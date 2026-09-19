import Ajv, { type AnySchema, type ValidateFunction } from "ajv";

import kubernetes from "./schemas/kubernetes-1.36.json";
import external from "./schemas/external.json";
import type { ParsedKubernetesManifest } from "./manifest-parser";

export interface KubernetesSchemaBundle {
  version: string;
  resources: Record<string, string>;
  definitions: Record<string, unknown>;
}

/** Match Kubernetes fieldValidation=Strict without closing free-form map values. */
function rejectUnknownFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rejectUnknownFields);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const copy = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, rejectUnknownFields(child)]),
  );
  if (
    source.type === "object" &&
    source.properties &&
    Object.keys(source.properties).length > 0 &&
    source.additionalProperties === undefined
  )
    copy.additionalProperties = false;
  return copy;
}

/** Vendored upstream schemas, compiled once per API and reused for every submission. */
export function createSchemaValidator(bundle: KubernetesSchemaBundle) {
  const definitions = rejectUnknownFields(bundle.definitions);
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    addUsedSchema: false,
  });
  const validators = new Map<string, ValidateFunction>();
  return (resource: ParsedKubernetesManifest): string[] => {
    const key = `${resource.apiVersion}/${resource.kind}`;
    const definition = bundle.resources[key];
    const extension = (external as Record<string, unknown>)[key] ?? teachingSchemas[key];
    if (!definition && !extension)
      return [`${key}: this API is not supported by the versioned schema registry`];
    let validate = validators.get(key);
    if (!validate) {
      validate = ajv.compile(
        (definition
          ? { $ref: `#/definitions/${definition}`, definitions }
          : rejectUnknownFields(extension)) as AnySchema,
      );
      validators.set(key, validate);
    }
    if (validate(resource.raw)) return [];
    return (validate.errors ?? [])
      .slice(0, 12)
      .map(
        (error) =>
          `${resource.kind}/${resource.name}${error.instancePath}: ${error.message}${error.params.missingProperty ? ` (${error.params.missingProperty})` : ""}`,
      );
  };
}

// These are explicitly authored teaching/tool contracts, not claims of a built-in API.
const teachingSchemas: Record<string, AnySchema> = {
  "platform.example.com/v1/Preview": {
    type: "object",
    required: ["apiVersion", "kind", "metadata"],
    properties: {
      apiVersion: { const: "platform.example.com/v1" },
      kind: { const: "Preview" },
      metadata: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          namespace: { type: "string" },
          finalizers: { type: "array", items: { type: "string" } },
        },
      },
      spec: { type: "object" },
      status: { type: "object" },
    },
  },
  "kustomize.config.k8s.io/v1beta1/Kustomization": {
    type: "object",
    required: ["apiVersion", "kind", "resources"],
    properties: {
      apiVersion: { const: "kustomize.config.k8s.io/v1beta1" },
      kind: { const: "Kustomization" },
      metadata: { type: "object" },
      namespace: { type: "string" },
      resources: { type: "array", items: { type: "string" } },
      images: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            newName: { type: "string" },
            newTag: { type: "string" },
            digest: { type: "string" },
          },
        },
      },
    },
  },
};

export const validateKubernetesSchema = createSchemaValidator(kubernetes);

export function validatePodAdmission(
  resource: ParsedKubernetesManifest,
  restricted: boolean,
): string[] {
  const raw = resource.raw;
  const spec = object(raw.spec);
  if (typeof spec.replicas === "number" && (spec.replicas < 0 || spec.replicas > 50))
    return [
      `${resource.kind}/${resource.name}: this learning runtime supports 0–50 replicas per workload`,
    ];
  const template =
    resource.kind === "CronJob"
      ? object(object(object(spec.jobTemplate).spec).template)
      : object(spec.template);
  const pod = resource.kind === "Pod" ? spec : object(template.spec);
  if (!Array.isArray(pod.containers)) return [];
  const issues: string[] = [];
  const fail = (message: string) => issues.push(`${resource.kind}/${resource.name}: ${message}`);
  if (
    ["Deployment", "ReplicaSet", "StatefulSet", "DaemonSet"].includes(resource.kind) &&
    pod.restartPolicy !== undefined &&
    pod.restartPolicy !== "Always"
  )
    fail("controller Pod restartPolicy must be Always");
  const security = object(pod.securityContext);
  if (restricted && [pod.hostNetwork, pod.hostPID, pod.hostIPC].includes(true))
    fail("restricted Pods cannot join host namespaces");
  const containers = [
    ...pod.containers,
    ...array(pod.initContainers),
    ...array(pod.ephemeralContainers),
  ].map(object);
  for (const container of containers) {
    for (const port of array(container.ports).map(object)) {
      for (const field of ["containerPort", "hostPort"]) {
        const value = port[field];
        if (
          value !== undefined &&
          (!Number.isInteger(value) ||
            Number(value) < (field === "hostPort" ? 0 : 1) ||
            Number(value) > 65535)
        )
          fail(`${container.name}.${field} must be a valid port (1-65535)`);
      }
      if (restricted && Number(port.hostPort ?? 0) !== 0)
        fail("restricted Pods cannot expose host ports");
    }
    for (const name of ["readinessProbe", "livenessProbe", "startupProbe"]) {
      if (container[name] === undefined) continue;
      const probe = object(container[name]);
      if (
        ["httpGet", "tcpSocket", "exec", "grpc"].filter((handler) => probe[handler] !== undefined)
          .length !== 1
      )
        fail(`${container.name}.${name} must declare exactly one handler`);
    }
    if (!restricted) continue;
    const own = object(container.securityContext);
    if (own.privileged === true || own.allowPrivilegeEscalation !== false)
      fail(`${container.name} must disable privilege escalation and privileged mode`);
    if (
      (own.runAsNonRoot ?? security.runAsNonRoot) !== true ||
      (own.runAsUser ?? security.runAsUser) === 0
    )
      fail(`${container.name} must run as non-root`);
    const seccomp = object(own.seccompProfile ?? security.seccompProfile);
    if (!["RuntimeDefault", "Localhost"].includes(String(seccomp.type)))
      fail(`${container.name} must use RuntimeDefault or Localhost seccomp`);
    const caps = object(own.capabilities);
    if (
      !array(caps.drop).includes("ALL") ||
      array(caps.add).some((cap) => cap !== "NET_BIND_SERVICE")
    )
      fail(`${container.name} must drop ALL capabilities and only add NET_BIND_SERVICE if needed`);
  }
  if (
    restricted &&
    array(pod.volumes)
      .map(object)
      .some((volume) => volume.hostPath !== undefined)
  )
    fail("restricted Pods cannot mount hostPath volumes");
  return issues;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
