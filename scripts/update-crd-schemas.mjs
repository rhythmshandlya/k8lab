import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadAll } from "js-yaml";

const sources = [
  ...["gatewayclasses", "gateways", "httproutes"].map((name) => [
    "kubernetes-sigs/gateway-api",
    "v1.6.2",
    `config/crd/standard/gateway.networking.k8s.io_${name}.yaml`,
  ]),
  ...["probes", "prometheuses", "prometheusrules", "servicemonitors"].map((name) => [
    "prometheus-operator/prometheus-operator",
    "v0.94.0",
    `example/prometheus-operator-crd/monitoring.coreos.com_${name}.yaml`,
  ]),
  ["cert-manager/cert-manager", "v1.21.2", "deploy/crds/cert-manager.io_certificates.yaml"],
  [
    "GoogleCloudPlatform/k8s-config-connector",
    "v1.156.0",
    "config/crds/resources/apiextensions.k8s.io_v1_customresourcedefinition_containerclusters.container.cnrm.cloud.google.com.yaml",
  ],
  [
    "kubernetes-sigs/cluster-api",
    "v1.14.2",
    "controlplane/kubeadm/config/crd/bases/controlplane.cluster.x-k8s.io_kubeadmcontrolplanes.yaml",
  ],
  [
    "kyverno/kyverno",
    "v1.19.1",
    "config/crds/policies.kyverno.io/policies.kyverno.io_imagevalidatingpolicies.yaml",
  ],
  ...["task", "pipeline", "pipelinerun"].map((name) => [
    "tektoncd/pipeline",
    "v1.16.0",
    `config/300-crds/300-${name}.yaml`,
  ]),
];
const registry = {};
const provenance = [];
function clean(schema) {
  if (Array.isArray(schema)) return schema.map(clean);
  if (!schema || typeof schema !== "object") return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") || (key === "description" && typeof value === "string")) continue;
    result[key] = clean(value);
    // OpenAPI's Go regexp dialect permits inline case flags; JSON Schema uses ECMA.
    if (key === "pattern" && typeof value === "string" && value.includes("(?i)")) {
      if (!/^\^\(\?i\)\([a-zA-Z|]+\)\?\$$/.test(value))
        throw new Error(
          `Review unsupported Go regular expression before updating schemas: ${value}`,
        );
      result[key] = value
        .replace("(?i)", "")
        .replace(/[a-zA-Z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
    }
  }
  if (schema["x-kubernetes-int-or-string"] === true) {
    delete result.type;
    result.anyOf = [{ type: "integer" }, { type: "string" }];
  }
  if (schema["x-kubernetes-preserve-unknown-fields"] === true) result.additionalProperties = true;
  return result;
}
for (const [repo, tag, path] of sources) {
  const url = `https://raw.githubusercontent.com/${repo}/${tag}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const text = await response.text();
  for (const crd of loadAll(text)) {
    if (crd?.kind !== "CustomResourceDefinition") continue;
    for (const version of crd.spec.versions.filter((version) => version.served)) {
      const key = `${crd.spec.group}/${version.name}/${crd.spec.names.kind}`;
      registry[key] = clean(version.schema.openAPIV3Schema);
      console.log(key);
    }
  }
  provenance.push({
    url,
    sha256: createHash("sha256").update(text).digest("hex"),
    license: "Apache-2.0",
  });
}
await writeFile(
  new URL("../src/lib/kube/schemas/external.json", import.meta.url),
  JSON.stringify(registry),
);
await writeFile(
  new URL("../src/lib/kube/schemas/external-sources.json", import.meta.url),
  JSON.stringify(provenance, null, 2) + "\n",
);
