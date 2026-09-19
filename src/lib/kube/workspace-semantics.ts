import { validateKubernetesSchema, validatePodAdmission } from "./schema-validation";
import { evaluateFixtureConsistency } from "./fixture-consistency";
import type {
  ContainerResourceBudget,
  NetworkPolicyContract,
  PipelineContract,
  ProblemLevel,
  SignaturePolicyContract,
  WorkspaceSemanticPolicy,
} from "@/lib/domain/types";

import { parseKubernetesManifests, type ParsedKubernetesManifest } from "./manifest-parser";

const WORKLOAD_KINDS = new Set([
  "Deployment",
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "Pod",
  "Job",
  "CronJob",
]);

/**
 * Cross-resource checks shared by static incident and architecture assessments.
 * This is deliberately narrower than Kubernetes OpenAPI validation, but it rejects
 * the dangerous false positives a scalar path rubric cannot see: disconnected
 * selectors, missing scale targets, missing RBAC roles, broken governing Services,
 * invalid digest syntax, and changes to well-known immutable fields.
 */
export function evaluateWorkspaceSemantics(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): string[] {
  const parsed = parseWorkspace(level, files);
  if (parsed.errors.length > 0) return parsed.errors;

  const policy: WorkspaceSemanticPolicy = level.semanticPolicy ?? {};
  const issues: string[] = [];
  const resources = parsed.resources;
  if (resources.length > 100) return ["A learning workspace supports at most 100 resources."];
  issues.push(...evaluateFixtureConsistency(level, resources));
  const workloads = resources.filter((resource) => WORKLOAD_KINDS.has(resource.kind));
  const requireClosedGraph = level.challengeMode === "build";
  const restrictedNamespaces = new Set(
    resources
      .filter(
        (resource) =>
          resource.kind === "Namespace" &&
          stringAt(resource.raw, "/metadata/labels/pod-security.kubernetes.io~1enforce") ===
            "restricted",
      )
      .map((resource) => resource.name),
  );

  for (const resource of resources) {
    issues.push(...validateKubernetesSchema(resource));
    issues.push(...validatePodAdmission(resource, restrictedNamespaces.has(resource.namespace)));
    validateImageDigests(resource.raw, `${resource.kind}/${resource.name}`, issues);

    if (
      resource.kind === "Deployment" ||
      resource.kind === "ReplicaSet" ||
      resource.kind === "StatefulSet" ||
      resource.kind === "DaemonSet"
    ) {
      const selector = labelsAt(resource.raw, "spec.selector.matchLabels");
      const labels = workloadLabels(resource.raw, resource.kind);
      if (!selector || Object.keys(selector).length === 0) {
        issues.push(`${resource.kind}/${resource.name} is missing spec.selector.matchLabels`);
      } else if (!labelsMatch(labels, selector)) {
        issues.push(`${resource.kind}/${resource.name} selector does not match its Pod template`);
      }
      for (const [index, spreadValue] of arrayAt(
        resource.raw,
        "spec.template.spec.topologySpreadConstraints",
      ).entries()) {
        const spread = objectValue(spreadValue);
        const spreadSelector = objectValue(spread?.labelSelector)?.matchLabels;
        const selectorLabels = objectValue(spreadSelector);
        if (selectorLabels && !labelsMatch(labels, stringLabels(selectorLabels))) {
          issues.push(
            `${resource.kind}/${resource.name} topology spread rule ${index + 1} selects no Pod template`,
          );
        }
      }
    }

    if (WORKLOAD_KINDS.has(resource.kind)) {
      validateWorkload(policy, resource, issues);
    }

    if (resource.kind === "Deployment") {
      const minReadySeconds = valueAt(resource.raw, "spec.minReadySeconds");
      const progressDeadlineSeconds = valueAt(resource.raw, "spec.progressDeadlineSeconds");
      if (
        typeof minReadySeconds === "number" &&
        typeof progressDeadlineSeconds === "number" &&
        progressDeadlineSeconds <= minReadySeconds
      ) {
        issues.push(
          `Deployment/${resource.name} progress deadline must exceed its readiness stability window`,
        );
      }
    }

    if (
      requireClosedGraph &&
      resource.kind === "Namespace" &&
      stringAt(resource.raw, "metadata.labels.securityProfile") === "restricted" &&
      stringAt(resource.raw, "/metadata/labels/pod-security.kubernetes.io~1enforce") !==
        "restricted"
    ) {
      issues.push(
        `Namespace/${resource.name} advertises restricted security without enforcing Pod Security`,
      );
    }

    if (resource.kind === "Service") {
      const selector = labelsAt(resource.raw, "spec.selector");
      if (
        requireClosedGraph &&
        selector &&
        Object.keys(selector).length > 0 &&
        workloads.length > 0
      ) {
        const matches = workloads.some(
          (workload) =>
            workload.namespace === resource.namespace &&
            labelsMatch(workloadLabels(workload.raw, workload.kind), selector),
        );
        if (!matches) issues.push(`Service/${resource.name} selects no submitted workload`);
      }
    }

    if (resource.kind === "PodDisruptionBudget") {
      const selector = labelsAt(resource.raw, "spec.selector.matchLabels");
      validateDisruptionBudget(policy, resource, issues);
      if (requireClosedGraph && selector && workloads.length > 0) {
        const matches = resources.some(
          (candidate) =>
            candidate.namespace === resource.namespace &&
            labelsMatch(producedPodLabels(candidate), selector),
        );
        if (!matches) issues.push(`PodDisruptionBudget/${resource.name} protects no workload`);
      }
    }

    if (requireClosedGraph && resource.kind === "HorizontalPodAutoscaler") {
      const targetApiVersion = stringAt(resource.raw, "spec.scaleTargetRef.apiVersion");
      const targetKind = stringAt(resource.raw, "spec.scaleTargetRef.kind");
      const targetName = stringAt(resource.raw, "spec.scaleTargetRef.name");
      const minReplicas = valueAt(resource.raw, "spec.minReplicas");
      const maxReplicas = valueAt(resource.raw, "spec.maxReplicas");
      if (!targetApiVersion || !targetKind || !targetName) {
        issues.push(`HorizontalPodAutoscaler/${resource.name} has an incomplete scaleTargetRef`);
      }
      if (
        typeof minReplicas !== "number" ||
        typeof maxReplicas !== "number" ||
        minReplicas < 1 ||
        maxReplicas < minReplicas
      ) {
        issues.push(`HorizontalPodAutoscaler/${resource.name} has invalid replica bounds`);
      }
      if (arrayAt(resource.raw, "spec.metrics").length === 0) {
        issues.push(`HorizontalPodAutoscaler/${resource.name} has no scaling metric`);
      }
      if (
        !targetKind ||
        !targetName ||
        !resources.some(
          (candidate) =>
            candidate.kind === targetKind &&
            candidate.name === targetName &&
            candidate.namespace === resource.namespace,
        )
      ) {
        issues.push(`HorizontalPodAutoscaler/${resource.name} has no submitted scale target`);
      }
      const target = resources.find(
        (candidate) =>
          candidate.kind === targetKind &&
          candidate.name === targetName &&
          candidate.namespace === resource.namespace,
      );
      const replicas = target ? valueAt(target.raw, "spec.replicas") : undefined;
      if (
        typeof replicas === "number" &&
        typeof maxReplicas === "number" &&
        (replicas < 1 || replicas > maxReplicas)
      ) {
        issues.push(
          `${targetKind}/${targetName} baseline replicas must be between one and the HPA maximum`,
        );
      }
    }

    if (requireClosedGraph && resource.kind === "StatefulSet") {
      const serviceName = stringAt(resource.raw, "spec.serviceName");
      if (serviceName) {
        const service = resources.find(
          (candidate) =>
            candidate.kind === "Service" &&
            candidate.name === serviceName &&
            candidate.namespace === resource.namespace,
        );
        if (service && stringAt(service.raw, "spec.clusterIP") !== "None") {
          issues.push(`StatefulSet/${resource.name} governing Service must be headless`);
        }
      }
    }

    if (
      requireClosedGraph &&
      (resource.kind === "RoleBinding" || resource.kind === "ClusterRoleBinding")
    ) {
      const roleKind = stringAt(resource.raw, "roleRef.kind");
      const roleName = stringAt(resource.raw, "roleRef.name");
      if (
        roleKind &&
        roleName &&
        !resources.some(
          (candidate) =>
            candidate.kind === roleKind &&
            candidate.name === roleName &&
            (roleKind === "ClusterRole" || candidate.namespace === resource.namespace),
        )
      ) {
        issues.push(`${resource.kind}/${resource.name} references missing ${roleKind}/${roleName}`);
      }
      if (arrayAt(resource.raw, "subjects").length !== 1) {
        issues.push(`${resource.kind}/${resource.name} must bind exactly one intended subject`);
      }
      for (const subjectValue of arrayAt(resource.raw, "subjects")) {
        const subject = objectValue(subjectValue);
        if (subject?.kind !== "ServiceAccount") continue;
        const subjectName = typeof subject.name === "string" ? subject.name : undefined;
        const subjectNamespace =
          typeof subject.namespace === "string" ? subject.namespace : resource.namespace;
        if (
          !subjectName ||
          !resources.some(
            (candidate) =>
              candidate.kind === "ServiceAccount" &&
              candidate.name === subjectName &&
              candidate.namespace === subjectNamespace,
          )
        ) {
          issues.push(
            `${resource.kind}/${resource.name} references missing ServiceAccount/${subjectName ?? "unknown"}`,
          );
        }
      }
    }

    if (resource.kind === "Role" || resource.kind === "ClusterRole") {
      validateRoleSafety(policy, resource, issues);
    }

    if (requireClosedGraph && resource.kind === "NetworkPolicy") {
      validateNetworkPolicy(resource, issues);
    }

    if (requireClosedGraph && resource.kind === "HTTPRoute") {
      for (const reference of arrayAt(resource.raw, "spec.parentRefs")) {
        const gateway = objectValue(reference);
        const name = typeof gateway?.name === "string" ? gateway.name : undefined;
        const namespace =
          typeof gateway?.namespace === "string" ? gateway.namespace : resource.namespace;
        const submittedGateway = name
          ? resources.find(
              (candidate) =>
                candidate.kind === "Gateway" &&
                candidate.name === name &&
                candidate.namespace === namespace,
            )
          : undefined;
        if (name && !submittedGateway) {
          issues.push(`HTTPRoute/${resource.name} references missing Gateway/${name}`);
        }
        const sectionName =
          typeof gateway?.sectionName === "string" ? gateway.sectionName : undefined;
        if (
          submittedGateway &&
          sectionName &&
          !arrayAt(submittedGateway.raw, "spec.listeners").some(
            (listener) => objectValue(listener)?.name === sectionName,
          )
        ) {
          issues.push(
            `HTTPRoute/${resource.name} references missing listener ${sectionName} on Gateway/${name}`,
          );
        }
      }
      for (const ruleValue of arrayAt(resource.raw, "spec.rules")) {
        const rule = objectValue(ruleValue);
        for (const backendValue of Array.isArray(rule?.backendRefs) ? rule.backendRefs : []) {
          const backend = objectValue(backendValue);
          const kind = typeof backend?.kind === "string" ? backend.kind : "Service";
          const name = typeof backend?.name === "string" ? backend.name : undefined;
          const namespace =
            typeof backend?.namespace === "string" ? backend.namespace : resource.namespace;
          const submittedBackend = name
            ? resources.find(
                (candidate) =>
                  candidate.kind === kind &&
                  candidate.name === name &&
                  candidate.namespace === namespace,
              )
            : undefined;
          if (name && !submittedBackend) {
            issues.push(`HTTPRoute/${resource.name} references missing ${kind}/${name}`);
          }
          if (submittedBackend?.kind === "Service") {
            const backendPort = backend?.port;
            const exposesPort = arrayAt(submittedBackend.raw, "spec.ports").some((portValue) => {
              const port = objectValue(portValue);
              return port?.port === backendPort || port?.name === backendPort;
            });
            if (backendPort === undefined || !exposesPort) {
              issues.push(
                `HTTPRoute/${resource.name} backend Service/${name} does not expose port ${String(backendPort)}`,
              );
            }
          }
        }
      }
    }

    if (requireClosedGraph && resource.kind === "Pipeline") {
      for (const taskValue of arrayAt(resource.raw, "spec.tasks")) {
        const task = objectValue(taskValue);
        const taskRef = objectValue(task?.taskRef);
        const taskName = typeof taskRef?.name === "string" ? taskRef.name : undefined;
        const taskKind = typeof taskRef?.kind === "string" ? taskRef.kind : "Task";
        if (
          taskName &&
          !resources.some(
            (candidate) =>
              candidate.kind === taskKind &&
              candidate.name === taskName &&
              candidate.namespace === resource.namespace,
          )
        ) {
          issues.push(`Pipeline/${resource.name} references missing ${taskKind}/${taskName}`);
        }
      }
      if (policy.pipelineContract) {
        validatePipelineContract(policy.pipelineContract, resource, issues);
      }
    }

    if (requireClosedGraph && resource.kind === "PipelineRun") {
      const pipelineName = stringAt(resource.raw, "spec.pipelineRef.name");
      const serviceAccount = stringAt(resource.raw, "spec.taskRunTemplate.serviceAccountName");
      if (
        !pipelineName ||
        !resources.some(
          (candidate) =>
            candidate.kind === "Pipeline" &&
            candidate.name === pipelineName &&
            candidate.namespace === resource.namespace,
        )
      ) {
        issues.push(`PipelineRun/${resource.name} references a missing Pipeline`);
      }
      if (
        !serviceAccount ||
        !resources.some(
          (candidate) =>
            candidate.kind === "ServiceAccount" &&
            candidate.name === serviceAccount &&
            candidate.namespace === resource.namespace,
        )
      ) {
        issues.push(`PipelineRun/${resource.name} must use a submitted ServiceAccount`);
      }
    }

    if (requireClosedGraph && resource.kind === "Task") {
      validateTask(policy, resource, issues);
    }

    if (
      requireClosedGraph &&
      (resource.kind === "ClusterPolicy" || resource.kind === "ImageValidatingPolicy")
    ) {
      validateSignaturePolicy(resource, issues);
    }

    if (requireClosedGraph && resource.kind === "Prometheus") {
      validatePrometheusSelectors(resource, resources, issues);
    }

    if (resource.kind === "PrometheusRule") {
      for (const groupValue of arrayAt(resource.raw, "spec.groups")) {
        const group = objectValue(groupValue);
        const rules = Array.isArray(group?.rules) ? group.rules : [];
        for (const ruleValue of rules) {
          const rule = objectValue(ruleValue);
          const expression = typeof rule?.expr === "string" ? rule.expr.trim() : "";
          if (!expression || /^vector\(\s*[-+]?\d+(?:\.\d+)?\s*\)$/i.test(expression)) {
            issues.push(`PrometheusRule/${resource.name} contains an ineffective alert expression`);
          }
        }
      }
    }

    if (resource.kind === "ValidatingWebhookConfiguration") {
      for (const [index, webhookValue] of arrayAt(resource.raw, "webhooks").entries()) {
        const webhook = objectValue(webhookValue);
        if (!Array.isArray(webhook?.admissionReviewVersions)) {
          issues.push(
            `ValidatingWebhookConfiguration/${resource.name} webhook ${index + 1} is missing admissionReviewVersions`,
          );
        }
        if (typeof webhook?.sideEffects !== "string") {
          issues.push(
            `ValidatingWebhookConfiguration/${resource.name} webhook ${index + 1} is missing sideEffects`,
          );
        }
      }
    }

    if (resource.kind === "Secret") {
      const data = objectValue(valueAt(resource.raw, "data"));
      for (const [key, value] of Object.entries(data ?? {})) {
        if (typeof value !== "string" || !isBase64(value)) {
          issues.push(`Secret/${resource.name} data.${key} is not valid base64`);
        }
      }
    }
  }

  validateNetworkPolicyContracts(policy.networkPolicyContracts ?? [], resources, issues);
  validateResourceBudgets(policy.resourceBudgets ?? [], resources, issues);
  if (policy.signaturePolicyContract) {
    validateSignaturePolicyContract(policy.signaturePolicyContract, resources, issues);
  }
  issues.push(...immutableChangeIssues(level, files));
  return [...new Set(issues)];
}

function validateResourceBudgets(
  contracts: readonly ContainerResourceBudget[],
  resources: readonly ParsedKubernetesManifest[],
  issues: string[],
): void {
  for (const contract of contracts) {
    const resource = resources.find(
      (candidate) =>
        candidate.kind === contract.kind &&
        candidate.name === contract.name &&
        (contract.namespace === undefined || candidate.namespace === contract.namespace),
    );
    const identity = `${contract.kind}/${contract.name} container ${contract.container}`;
    if (!resource) {
      issues.push(`${identity} is missing from the submitted resource budget`);
      continue;
    }

    const containerResources = resourceRequirementsForBudget(resource, contract);
    if (!containerResources) {
      issues.push(`${identity} is missing its resource requirements`);
      continue;
    }

    const requests = objectValue(containerResources.requests);
    const limits = objectValue(containerResources.limits);
    validateResourceCeiling(
      identity,
      "requests.cpu",
      requests?.cpu,
      contract.maxRequestCpu,
      issues,
    );
    validateResourceCeiling(
      identity,
      "requests.memory",
      requests?.memory,
      contract.maxRequestMemory,
      issues,
    );
    validateResourceCeiling(identity, "limits.cpu", limits?.cpu, contract.maxLimitCpu, issues);
    validateResourceCeiling(
      identity,
      "limits.memory",
      limits?.memory,
      contract.maxLimitMemory,
      issues,
    );

    validateRequestFitsLimit(identity, "cpu", requests?.cpu, limits?.cpu, issues);
    validateRequestFitsLimit(identity, "memory", requests?.memory, limits?.memory, issues);
  }
}

function resourceRequirementsForBudget(
  resource: ParsedKubernetesManifest,
  contract: ContainerResourceBudget,
): Record<string, unknown> | undefined {
  if (contract.resourcesPath) return objectValue(valueAt(resource.raw, contract.resourcesPath));

  const podSpecPath =
    resource.kind === "Pod"
      ? "spec"
      : resource.kind === "CronJob"
        ? "spec.jobTemplate.spec.template.spec"
        : "spec.template.spec";
  const podSpec = objectValue(valueAt(resource.raw, podSpecPath));
  const container = arrayAt(podSpec, "containers")
    .map(objectValue)
    .find((candidate) => candidate?.name === contract.container);
  return objectValue(container?.resources);
}

function validateResourceCeiling(
  identity: string,
  field: "requests.cpu" | "requests.memory" | "limits.cpu" | "limits.memory",
  actual: unknown,
  maximum: string | undefined,
  issues: string[],
): void {
  if (maximum === undefined) return;
  const parser = field.endsWith("cpu") ? parseCpuQuantity : parseMemoryQuantity;
  const parsedActual = parser(actual);
  const parsedMaximum = parser(maximum);
  if (parsedActual === undefined || parsedMaximum === undefined || parsedActual > parsedMaximum) {
    issues.push(`${identity} must set ${field} at or below ${maximum}`);
  }
}

function validateRequestFitsLimit(
  identity: string,
  resource: "cpu" | "memory",
  request: unknown,
  limit: unknown,
  issues: string[],
): void {
  if (request === undefined || limit === undefined) return;
  const parser = resource === "cpu" ? parseCpuQuantity : parseMemoryQuantity;
  const parsedRequest = parser(request);
  const parsedLimit = parser(limit);
  if (parsedRequest !== undefined && parsedLimit !== undefined && parsedRequest > parsedLimit) {
    issues.push(`${identity} ${resource} request must not exceed its limit`);
  }
}

function parseCpuQuantity(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d*)?|\.\d+)(n|u|m)?$/.exec(String(value ?? ""));
  if (!match) return undefined;
  const multipliers: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1 };
  const amount = Number(match[1]) * multipliers[match[2] ?? ""]!;
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function parseMemoryQuantity(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d*)?|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])?$/.exec(String(value ?? ""));
  if (!match) return undefined;
  const binaryPowers: Record<string, number> = {
    Ki: 1,
    Mi: 2,
    Gi: 3,
    Ti: 4,
    Pi: 5,
    Ei: 6,
  };
  const decimalPowers: Record<string, number> = { k: 1, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const suffix = match[2] ?? "";
  const multiplier =
    suffix in binaryPowers
      ? 1024 ** binaryPowers[suffix]!
      : suffix in decimalPowers
        ? 1000 ** decimalPowers[suffix]!
        : 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function parseWorkspace(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): { resources: ParsedKubernetesManifest[]; errors: string[] } {
  const resources: ParsedKubernetesManifest[] = [];
  const errors: string[] = [];
  for (const file of level.files.filter(
    (candidate) => candidate.access === "editable" && candidate.language === "yaml",
  )) {
    const parsed = parseKubernetesManifests(files[file.path] ?? file.initialValue);
    if (!parsed.ok) errors.push(`${file.path}: ${parsed.error.message}`);
    else resources.push(...parsed.value);
  }
  return { resources, errors };
}

function immutableChangeIssues(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): string[] {
  const immutablePaths: Record<string, string[]> = {
    PriorityClass: ["value", "preemptionPolicy"],
    StorageClass: ["volumeBindingMode"],
    StatefulSet: ["spec.podManagementPolicy"],
    Service: ["spec.clusterIP"],
  };
  const issues: string[] = [];

  for (const file of level.files.filter((candidate) => candidate.access === "editable")) {
    const original = parseKubernetesManifests(file.initialValue);
    const current = parseKubernetesManifests(files[file.path] ?? file.initialValue);
    if (!original.ok || !current.ok) continue;
    for (const before of original.value) {
      const after = current.value.find(
        (candidate) =>
          candidate.kind === before.kind &&
          candidate.name === before.name &&
          candidate.namespace === before.namespace,
      );
      if (!after) continue;
      for (const path of immutablePaths[before.kind] ?? []) {
        const beforeValue = valueAt(before.raw, path);
        const afterValue = valueAt(after.raw, path);
        if (
          beforeValue !== undefined &&
          JSON.stringify(beforeValue) !== JSON.stringify(afterValue)
        ) {
          issues.push(`${before.kind}/${before.name} changes immutable field ${path}`);
        }
      }
    }
  }
  return issues;
}

function validatePrometheusSelectors(
  prometheus: ParsedKubernetesManifest,
  resources: readonly ParsedKubernetesManifest[],
  issues: string[],
): void {
  const serviceAccountName = stringAt(prometheus.raw, "spec.serviceAccountName");
  if (
    !serviceAccountName ||
    !resources.some(
      (candidate) =>
        candidate.kind === "ServiceAccount" &&
        candidate.name === serviceAccountName &&
        candidate.namespace === prometheus.namespace,
    )
  ) {
    issues.push(`Prometheus/${prometheus.name} must use a submitted discovery ServiceAccount`);
  } else {
    const hasDiscoveryBinding = resources.some(
      (candidate) =>
        candidate.kind === "ClusterRoleBinding" &&
        arrayAt(candidate.raw, "subjects").some((subjectValue) => {
          const subject = objectValue(subjectValue);
          return (
            subject?.kind === "ServiceAccount" &&
            subject.name === serviceAccountName &&
            subject.namespace === prometheus.namespace
          );
        }),
    );
    if (!hasDiscoveryBinding) {
      issues.push(`Prometheus/${prometheus.name} ServiceAccount has no discovery binding`);
    }
  }

  const podLabels = labelsAt(prometheus.raw, "spec.podMetadata.labels") ?? {};
  for (const [index, spreadValue] of arrayAt(
    prometheus.raw,
    "spec.topologySpreadConstraints",
  ).entries()) {
    const spreadSelector = objectValue(objectValue(spreadValue)?.labelSelector)?.matchLabels;
    const selectorLabels = objectValue(spreadSelector);
    if (selectorLabels && !labelsMatch(podLabels, stringLabels(selectorLabels))) {
      issues.push(
        `Prometheus/${prometheus.name} topology spread rule ${index + 1} selects no Prometheus Pod`,
      );
    }
  }
  const selectors = [
    ["spec.serviceMonitorSelector.matchLabels", "ServiceMonitor"],
    ["spec.probeSelector.matchLabels", "Probe"],
    ["spec.ruleSelector.matchLabels", "PrometheusRule"],
  ] as const;

  for (const [path, kind] of selectors) {
    const selector = labelsAt(prometheus.raw, path);
    if (!selector || Object.keys(selector).length === 0) {
      issues.push(`Prometheus/${prometheus.name} is missing a ${kind} selector`);
      continue;
    }
    const matches = resources.some(
      (candidate) =>
        candidate.kind === kind &&
        candidate.namespace === prometheus.namespace &&
        labelsMatch(labelsAt(candidate.raw, "metadata.labels") ?? {}, selector),
    );
    if (!matches) issues.push(`Prometheus/${prometheus.name} selects no submitted ${kind}`);
  }
}

function validateDisruptionBudget(
  policy: WorkspaceSemanticPolicy,
  budget: ParsedKubernetesManifest,
  issues: string[],
): void {
  const minAvailable = valueAt(budget.raw, "spec.minAvailable");
  const maxUnavailable = valueAt(budget.raw, "spec.maxUnavailable");
  if (minAvailable === undefined && maxUnavailable === undefined) {
    issues.push(`PodDisruptionBudget/${budget.name} must set minAvailable or maxUnavailable`);
    return;
  }
  if (minAvailable !== undefined && maxUnavailable !== undefined) {
    issues.push(`PodDisruptionBudget/${budget.name} must not set both disruption bounds`);
    return;
  }

  const requirement = policy.disruptionBudgets?.[budget.name];
  if (!requirement) return;
  const resolved = resolvedPodCount(
    minAvailable !== undefined ? minAvailable : maxUnavailable,
    requirement.baseline,
  );
  const preserved =
    resolved === undefined
      ? undefined
      : minAvailable !== undefined
        ? resolved
        : requirement.baseline - resolved;
  if (preserved === undefined || preserved < requirement.minimumAvailable) {
    issues.push(
      `PodDisruptionBudget/${budget.name} must preserve at least ${requirement.minimumAvailable} of ${requirement.baseline} baseline replicas`,
    );
  }
}

function resolvedPodCount(value: unknown, baseline: number): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return undefined;
  return Math.ceil((Number(match[1]) / 100) * baseline);
}

function producedPodLabels(resource: ParsedKubernetesManifest): Record<string, string> {
  if (resource.kind === "Prometheus") {
    return labelsAt(resource.raw, "spec.podMetadata.labels") ?? {};
  }
  return WORKLOAD_KINDS.has(resource.kind) ? workloadLabels(resource.raw, resource.kind) : {};
}

function validateWorkload(
  policy: WorkspaceSemanticPolicy,
  resource: ParsedKubernetesManifest,
  issues: string[],
): void {
  const podSpecPath =
    resource.kind === "Pod"
      ? "spec"
      : resource.kind === "CronJob"
        ? "spec.jobTemplate.spec.template.spec"
        : "spec.template.spec";
  const podSpec = objectValue(valueAt(resource.raw, podSpecPath));
  if (!podSpec) {
    issues.push(`${resource.kind}/${resource.name} has no Pod specification`);
    return;
  }

  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
  const auxiliaryContainers = [
    ...(Array.isArray(podSpec.initContainers) ? podSpec.initContainers : []),
    ...(Array.isArray(podSpec.ephemeralContainers) ? podSpec.ephemeralContainers : []),
  ];
  if (containers.length === 0) {
    issues.push(`${resource.kind}/${resource.name} must define at least one container`);
  }
  for (const [index, containerValue] of [...containers, ...auxiliaryContainers].entries()) {
    const container = objectValue(containerValue);
    if (
      !container ||
      typeof container.name !== "string" ||
      container.name.length === 0 ||
      typeof container.image !== "string" ||
      container.image.length === 0
    ) {
      issues.push(
        `${resource.kind}/${resource.name} container ${index + 1} needs a name and image`,
      );
      continue;
    }
    for (const probeName of ["startupProbe", "readinessProbe", "livenessProbe"] as const) {
      if (container[probeName] !== undefined && !hasProbeHandler(container[probeName])) {
        issues.push(
          `${resource.kind}/${resource.name} container ${container.name} has an empty ${probeName}`,
        );
      }
    }
    const resources = objectValue(container.resources);
    for (const section of ["requests", "limits"] as const) {
      const quantities = objectValue(resources?.[section]);
      for (const [name, value] of Object.entries(quantities ?? {})) {
        if (!isPositiveQuantity(value)) {
          issues.push(
            `${resource.kind}/${resource.name} container ${container.name} has non-positive ${section}.${name}`,
          );
        }
      }
    }
  }

  if (policy.podSecurity === "hardened") {
    if (podSpec.hostNetwork === true || podSpec.hostPID === true || podSpec.hostIPC === true) {
      issues.push(`${resource.kind}/${resource.name} must not join host namespaces`);
    }
    const podSecurity = objectValue(podSpec.securityContext);
    if (
      podSecurity?.runAsNonRoot !== true ||
      podSecurity?.runAsUser === 0 ||
      stringAt(podSecurity, "seccompProfile.type") !== "RuntimeDefault"
    ) {
      issues.push(`${resource.kind}/${resource.name} lacks the required Pod security context`);
    }
    for (const containerValue of [...containers, ...auxiliaryContainers]) {
      const container = objectValue(containerValue);
      const security = objectValue(container?.securityContext);
      const dropped = stringArray(objectValue(security?.capabilities)?.drop);
      if (
        security?.privileged === true ||
        security?.runAsUser === 0 ||
        security?.allowPrivilegeEscalation !== false ||
        security?.readOnlyRootFilesystem !== true ||
        !dropped.includes("ALL")
      ) {
        issues.push(
          `${resource.kind}/${resource.name} containers must be non-privileged, read-only, and drop all capabilities`,
        );
        break;
      }
      if (
        Array.isArray(container?.ports) &&
        container.ports.some((port) => {
          const hostPort = objectValue(port)?.hostPort;
          return typeof hostPort === "number" && hostPort > 0;
        })
      ) {
        issues.push(`${resource.kind}/${resource.name} containers must not expose host ports`);
        break;
      }
    }
    if (arrayAt(podSpec, "volumes").some((volume) => objectValue(volume)?.hostPath !== undefined)) {
      issues.push(`${resource.kind}/${resource.name} must not mount host paths`);
    }
  }
}

function validateNetworkPolicy(policy: ParsedKubernetesManifest, issues: string[]): void {
  const ingress = arrayAt(policy.raw, "spec.ingress");
  const egress = arrayAt(policy.raw, "spec.egress");
  if (policy.name === "default-deny") {
    if (ingress.length > 0) {
      issues.push(`NetworkPolicy/${policy.name} must not contain allow ingress rules`);
    }
    if (egress.length > 0) {
      issues.push(`NetworkPolicy/${policy.name} must not contain allow egress rules`);
    }
  }

  for (const [direction, rules] of [
    ["ingress", ingress],
    ["egress", egress],
  ] as const) {
    for (const [index, ruleValue] of rules.entries()) {
      const rule = objectValue(ruleValue);
      if (!rule || Object.keys(rule).length === 0) {
        issues.push(
          `NetworkPolicy/${policy.name} contains an allow-all ${direction} rule ${index + 1}`,
        );
        continue;
      }
      const peers = direction === "ingress" ? rule.from : rule.to;
      if (
        Array.isArray(peers) &&
        peers.some((peer) => {
          const object = objectValue(peer);
          const namespaceSelector = objectValue(object?.namespaceSelector);
          const ipBlock = objectValue(object?.ipBlock);
          return (
            !object ||
            Object.keys(object).length === 0 ||
            (namespaceSelector !== undefined && isEmptyLabelSelector(namespaceSelector)) ||
            ipBlock?.cidr === "0.0.0.0/0" ||
            ipBlock?.cidr === "::/0"
          );
        })
      ) {
        issues.push(`NetworkPolicy/${policy.name} contains an unrestricted ${direction} peer`);
      }
    }
  }

  const egressPorts = egress.flatMap((rule) => {
    const values = objectValue(rule)?.ports;
    return Array.isArray(values) ? values : [];
  });
  if (policy.name.includes("dns") || egressPorts.some((port) => objectValue(port)?.port === 53)) {
    const protocols = new Set(
      egressPorts
        .map((port) => objectValue(port))
        .filter((port) => port?.port === 53)
        .map((port) => (typeof port?.protocol === "string" ? port.protocol : "TCP")),
    );
    if (!protocols.has("UDP") || !protocols.has("TCP")) {
      issues.push(`NetworkPolicy/${policy.name} must allow DNS over both UDP and TCP`);
    }
  }
}

function validateNetworkPolicyContracts(
  contracts: readonly NetworkPolicyContract[],
  resources: readonly ParsedKubernetesManifest[],
  issues: string[],
): void {
  for (const contract of contracts) {
    const policy = resources.find(
      (candidate) =>
        candidate.kind === "NetworkPolicy" &&
        candidate.name === contract.name &&
        (contract.namespace === undefined || candidate.namespace === contract.namespace),
    );
    if (!policy) {
      issues.push(`NetworkPolicy/${contract.name} is missing from the submitted traffic graph`);
      continue;
    }

    const actualPodSelector = selectorSignature(valueAt(policy.raw, "spec.podSelector"));
    const requiredPodSelector = contractSelectorSignature(contract.podSelector);
    if (actualPodSelector !== requiredPodSelector) {
      issues.push(`NetworkPolicy/${contract.name} selects the wrong protected Pods`);
    }

    const actualPolicyTypes = arrayAt(policy.raw, "spec.policyTypes")
      .filter((value): value is string => typeof value === "string")
      .sort();
    const requiredPolicyTypes = [...contract.policyTypes].sort();
    if (JSON.stringify(actualPolicyTypes) !== JSON.stringify(requiredPolicyTypes)) {
      issues.push(`NetworkPolicy/${contract.name} has the wrong policy directions`);
    }

    for (const direction of ["ingress", "egress"] as const) {
      const actual = networkTrafficSignatures(policy.raw, direction);
      const required = (contract[direction] ?? [])
        .map((traffic) =>
          JSON.stringify({
            namespaceSelector:
              traffic.namespaceSelector === undefined
                ? null
                : contractSelectorSignature(traffic.namespaceSelector),
            podSelector:
              traffic.podSelector === undefined
                ? null
                : contractSelectorSignature(traffic.podSelector),
            ipBlock: null,
            port: {
              protocol: traffic.port.protocol,
              port: traffic.port.port,
              endPort: null,
            },
          }),
        )
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify(required)) {
        issues.push(
          `NetworkPolicy/${contract.name} does not match its exact ${direction} traffic contract`,
        );
      }
    }
  }
}

/** Normalize NetworkPolicy rules into their effective peer x port tuples. */
function networkTrafficSignatures(
  raw: Record<string, unknown>,
  direction: "ingress" | "egress",
): string[] {
  const peerField = direction === "ingress" ? "from" : "to";
  return arrayAt(raw, `spec.${direction}`)
    .flatMap((ruleValue) => {
      const rule = objectValue(ruleValue);
      const rawPeers = rule?.[peerField];
      const rawPorts = rule?.ports;
      const peers = Array.isArray(rawPeers) && rawPeers.length > 0 ? rawPeers : [undefined];
      const ports = Array.isArray(rawPorts) && rawPorts.length > 0 ? rawPorts : [undefined];
      return peers.flatMap((peerValue) => {
        const peer = objectValue(peerValue);
        return ports.map((portValue) => {
          const port = objectValue(portValue);
          return JSON.stringify({
            namespaceSelector:
              peer?.namespaceSelector === undefined
                ? null
                : selectorSignature(peer.namespaceSelector),
            podSelector:
              peer?.podSelector === undefined ? null : selectorSignature(peer.podSelector),
            ipBlock: peer?.ipBlock ?? (peer ? null : "*"),
            port:
              port === undefined
                ? "*"
                : {
                    protocol: typeof port.protocol === "string" ? port.protocol : "TCP",
                    port: port.port ?? "*",
                    endPort: port.endPort ?? null,
                  },
          });
        });
      });
    })
    .sort();
}

function contractSelectorSignature(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify({ matchLabels: sortedLabels(labels), matchExpressions: [] });
}

function selectorSignature(value: unknown): string {
  const selector = objectValue(value);
  if (!selector) return "missing";
  return JSON.stringify({
    matchLabels: sortedLabels(stringLabels(objectValue(selector.matchLabels) ?? {})),
    matchExpressions: Array.isArray(selector.matchExpressions) ? selector.matchExpressions : [],
  });
}

function sortedLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isEmptyLabelSelector(selector: Record<string, unknown>): boolean {
  const matchLabels = objectValue(selector.matchLabels);
  const matchExpressions = Array.isArray(selector.matchExpressions)
    ? selector.matchExpressions
    : undefined;
  return (
    (matchLabels === undefined || Object.keys(matchLabels).length === 0) &&
    (matchExpressions === undefined || matchExpressions.length === 0)
  );
}

function validateTask(
  policy: WorkspaceSemanticPolicy,
  resource: ParsedKubernetesManifest,
  issues: string[],
): void {
  const steps = arrayAt(resource.raw, "spec.steps");
  if (steps.length === 0) {
    issues.push(`Task/${resource.name} has no executable steps`);
    return;
  }
  for (const [index, stepValue] of steps.entries()) {
    const step = objectValue(stepValue);
    const executable =
      typeof step?.script === "string" ||
      (Array.isArray(step?.command) && step.command.length > 0) ||
      (Array.isArray(step?.args) && step.args.length > 0);
    if (typeof step?.image !== "string" || step.image.length === 0 || !executable) {
      issues.push(`Task/${resource.name} step ${index + 1} needs an image and executable action`);
    }
  }

  const contract = policy.taskContracts?.find((candidate) => candidate.task === resource.name);
  if (!contract) return;
  const step = objectValue(steps[0]);
  const script = typeof step?.script === "string" ? step.script : "";
  const satisfied =
    steps.length === contract.stepCount &&
    step?.image === contract.image &&
    (contract.args === undefined ||
      (script === "" && sameSet(stringArray(step?.args), contract.args))) &&
    (contract.scriptIncludes ?? []).every((fragment) => script.includes(fragment));
  if (!satisfied) issues.push(`Task/${resource.name} ${contract.violation}`);
}

/**
 * A promotion pipeline is only trustworthy if every stage acts on the same pinned
 * artifact, in order. The specific tasks, param name, and image are level data.
 */
function validatePipelineContract(
  contract: PipelineContract,
  pipeline: ParsedKubernetesManifest,
  issues: string[],
): void {
  const tasks = arrayAt(pipeline.raw, "spec.tasks")
    .map(objectValue)
    .filter((task): task is Record<string, unknown> => task !== undefined);
  const hasDigestParam = arrayAt(pipeline.raw, "spec.params")
    .map(objectValue)
    .some((param) => param?.name === contract.digestParam && param?.type === "string");

  const ordered = contract.tasks.every((expected, index) => {
    const task = tasks.find((candidate) => candidate.name === expected.name);
    if (!task) return false;
    if (objectValue(task.taskRef)?.name !== expected.taskRef) return false;
    if (namedParamValue(task, "image") !== contract.pinnedImage) return false;
    const previous = contract.tasks[index - 1];
    return previous === undefined || stringArray(task.runAfter).includes(previous.name);
  });

  if (tasks.length !== contract.tasks.length || !hasDigestParam || !ordered) {
    issues.push(`Pipeline/${pipeline.name} ${contract.violation}`);
  }
}

function namedParamValue(owner: Record<string, unknown> | undefined, name: string): unknown {
  return arrayAt(owner, "params")
    .map(objectValue)
    .find((param) => param?.name === name)?.value;
}

function validateSignaturePolicy(resource: ParsedKubernetesManifest, issues: string[]): void {
  if (resource.kind === "ImageValidatingPolicy") {
    const required = valueAt(resource.raw, "spec.validationConfigurations.required");
    const verifyDigest = valueAt(resource.raw, "spec.validationConfigurations.verifyDigest");
    const mutateDigest = valueAt(resource.raw, "spec.validationConfigurations.mutateDigest");
    const imageGlobs = arrayAt(resource.raw, "spec.matchImageReferences")
      .map(objectValue)
      .map((matcher) => matcher?.glob)
      .filter((glob): glob is string => typeof glob === "string");
    const attestors = arrayAt(resource.raw, "spec.attestors");
    const validations = arrayAt(resource.raw, "spec.validations");
    if (
      required !== true ||
      verifyDigest !== true ||
      mutateDigest !== false ||
      !imageGlobs.includes("*") ||
      attestors.length === 0
    ) {
      issues.push(
        `ImageValidatingPolicy/${resource.name} must reject tags and verify every image digest with a named attestor`,
      );
    }
    for (const attestorValue of attestors) {
      const attestor = objectValue(attestorValue);
      const identities = arrayAt(attestor, "cosign.keyless.identities");
      if (typeof attestor?.name !== "string" || identities.length === 0) {
        issues.push(
          `ImageValidatingPolicy/${resource.name} must configure a named keyless identity`,
        );
      }
      for (const identityValue of identities) {
        const identity = objectValue(identityValue);
        const subject = typeof identity?.subject === "string" ? identity.subject : "";
        const issuer = typeof identity?.issuer === "string" ? identity.issuer : "";
        if (!subject.startsWith("https://github.com/") || !issuer.startsWith("https://")) {
          issues.push(
            `ImageValidatingPolicy/${resource.name} keyless attestor must bind a repository workflow identity and issuer`,
          );
        }
      }
    }
    const expressions = validations
      .map((validation) => objectValue(validation)?.expression)
      .filter((expression): expression is string => typeof expression === "string");
    const registryRule = expressions.find(
      (expression) =>
        expression.includes("registry") &&
        expression.includes("sha256:") &&
        expression.includes("{64}") &&
        expression.includes(".matches("),
    );
    const signatureRule = expressions.find((expression) =>
      expression.includes("verifyImageSignatures"),
    );
    if (!registryRule || registryRule.includes("||")) {
      issues.push(
        `ImageValidatingPolicy/${resource.name} must restrict every production image to the approved digest registry`,
      );
    }
    if (
      !signatureRule ||
      signatureRule.replaceAll(/\s/g, "") !==
        "variables.allImages.map(image,verifyImageSignatures(image,[attestors.trustedCi])).all(result,result>0)"
    ) {
      issues.push(
        `ImageValidatingPolicy/${resource.name} must enforce signature verification in CEL`,
      );
    }
    return;
  }

  for (const [ruleIndex, ruleValue] of arrayAt(resource.raw, "spec.rules").entries()) {
    const rule = objectValue(ruleValue);
    const verifyImages = Array.isArray(rule?.verifyImages) ? rule.verifyImages : [];
    for (const [verifyIndex, verifyValue] of verifyImages.entries()) {
      const verify = objectValue(verifyValue);
      const attestors = Array.isArray(verify?.attestors) ? verify.attestors : [];
      if (verify?.required !== true || attestors.length === 0) {
        issues.push(
          `ClusterPolicy/${resource.name} signature rule ${ruleIndex + 1}.${verifyIndex + 1} must require nonempty attestors`,
        );
      }
      for (const attestorValue of attestors) {
        const entries = objectValue(attestorValue)?.entries;
        if (!Array.isArray(entries) || entries.length === 0) {
          issues.push(
            `ClusterPolicy/${resource.name} signature attestors must contain verification entries`,
          );
          continue;
        }
        for (const entryValue of entries) {
          const keyless = objectValue(objectValue(entryValue)?.keyless);
          if (!keyless) continue;
          const subject = typeof keyless.subject === "string" ? keyless.subject : "";
          const issuer = typeof keyless.issuer === "string" ? keyless.issuer : "";
          if (!subject.startsWith("https://github.com/") || !issuer.startsWith("https://")) {
            issues.push(
              `ClusterPolicy/${resource.name} keyless attestor must bind a repository workflow identity and issuer`,
            );
          }
        }
      }
    }
  }
}

function validateSignaturePolicyContract(
  contract: SignaturePolicyContract,
  resources: readonly ParsedKubernetesManifest[],
  issues: string[],
): void {
  const policy = resources.find(
    (candidate) => candidate.kind === "ImageValidatingPolicy" && candidate.name === contract.name,
  );
  if (!policy) {
    issues.push(`ImageValidatingPolicy/${contract.name} is missing its signature contract`);
    return;
  }

  const variables = arrayAt(policy.raw, "spec.variables")
    .map(objectValue)
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const exactVariable =
    variables.length === 1 &&
    variables[0]?.name === contract.imageVariable.name &&
    variables[0]?.expression === contract.imageVariable.expression;
  const validations = arrayAt(policy.raw, "spec.validations")
    .map(objectValue)
    .map((validation) => validation?.expression)
    .filter((expression): expression is string => typeof expression === "string");

  if (!exactVariable || !sameSet(validations, contract.validations)) {
    issues.push(`ImageValidatingPolicy/${contract.name} ${contract.violation}`);
  }
}

/**
 * Wildcard authority is always wrong. Beyond that, a level can declare the exact set
 * of rule shapes its RBAC contract permits, and any authored rule outside that set is
 * privilege the design did not ask for.
 */
function validateRoleSafety(
  policy: WorkspaceSemanticPolicy,
  role: ParsedKubernetesManifest,
  issues: string[],
): void {
  const rules = arrayAt(role.raw, "rules");
  const contracts = (policy.rbacContracts ?? []).filter(
    (contract) => contract.appliesTo === role.kind,
  );

  for (const ruleValue of rules) {
    const rule = objectValue(ruleValue);
    const apiGroups = stringArray(rule?.apiGroups);
    const resources = stringArray(rule?.resources);
    const verbs = stringArray(rule?.verbs);
    const resourceNames = stringArray(rule?.resourceNames);

    if (apiGroups.includes("*") || resources.includes("*") || verbs.includes("*")) {
      issues.push(`${role.kind}/${role.name} contains wildcard authority`);
    }

    for (const contract of contracts) {
      const permitted = contract.allowedRules.some(
        (allowed) =>
          sameSet(apiGroups, allowed.apiGroups) &&
          sameSet(resources, allowed.resources) &&
          sameSet(verbs, allowed.verbs) &&
          (allowed.resourceNames === undefined || sameSet(resourceNames, allowed.resourceNames)),
      );
      if (!permitted) issues.push(`${role.kind}/${role.name} ${contract.violation}`);
    }
  }

  for (const contract of contracts) {
    if (contract.exactRuleCount !== undefined && rules.length !== contract.exactRuleCount) {
      issues.push(
        `${role.kind}/${role.name} must contain exactly ${contract.exactRuleCount} rule${
          contract.exactRuleCount === 1 ? "" : "s"
        }`,
      );
    }
  }
}

function sameSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function hasProbeHandler(value: unknown): boolean {
  const probe = objectValue(value);
  return Boolean(
    probe &&
    ["httpGet", "tcpSocket", "exec", "grpc"].some(
      (handler) => objectValue(probe[handler]) !== undefined,
    ),
  );
}

function isPositiveQuantity(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const match = value.trim().match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+))(?:[a-zA-Z]+)?$/);
  return Boolean(match && Number(match[1]) > 0);
}

function workloadLabels(resource: Record<string, unknown>, kind: string): Record<string, string> {
  const path =
    kind === "Pod"
      ? "metadata.labels"
      : kind === "CronJob"
        ? "spec.jobTemplate.spec.template.metadata.labels"
        : "spec.template.metadata.labels";
  return labelsAt(resource, path) ?? {};
}

function labelsMatch(labels: Record<string, string>, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function labelsAt(root: unknown, path: string): Record<string, string> | undefined {
  const value = valueAt(root, path);
  const object = objectValue(value);
  if (!object) return undefined;
  return Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function stringAt(root: unknown, path: string): string | undefined {
  const value = valueAt(root, path);
  return typeof value === "string" ? value : undefined;
}

function arrayAt(root: unknown, path: string): unknown[] {
  const value = valueAt(root, path);
  return Array.isArray(value) ? value : [];
}

function valueAt(root: unknown, path: string): unknown {
  const segments = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");
  return segments.reduce<unknown>((value, segment) => {
    if (Array.isArray(value) && /^\d+$/.test(segment)) return value[Number(segment)];
    return objectValue(value)?.[segment];
  }, root);
}

function stringLabels(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateImageDigests(root: unknown, owner: string, issues: string[]): void {
  if (typeof root === "string") {
    if (
      /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:/.test(root) &&
      !/@sha256:[a-f0-9]{64}$/.test(root)
    ) {
      issues.push(`${owner} uses an invalid SHA-256 image digest`);
    }
    return;
  }
  if (Array.isArray(root)) {
    for (const value of root) validateImageDigests(value, owner, issues);
    return;
  }
  const object = objectValue(root);
  if (!object) return;
  for (const value of Object.values(object)) validateImageDigests(value, owner, issues);
}
