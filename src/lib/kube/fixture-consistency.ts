import type { ProblemLevel } from "@/lib/domain/types";
import { parseKubernetesManifests, type ParsedKubernetesManifest } from "./manifest-parser";

/** Fail closed when runtime-affecting changes contradict the authored observation model. */
export function evaluateFixtureConsistency(
  level: ProblemLevel,
  resources: readonly ParsedKubernetesManifest[],
): string[] {
  if (level.engine.kind !== "fixture") return [];
  const healthy = level.engine.fixture.healthy;
  const issues: string[] = [];
  const initial = level.files.flatMap((file) => {
    const parsed = parseKubernetesManifests(file.initialValue);
    return parsed.ok ? parsed.value : [];
  });
  for (const resource of resources) {
    if (!["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod"].includes(resource.kind))
      continue;
    const spec = podSpec(resource);
    const before = initial.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.name === resource.name &&
        candidate.namespace === resource.namespace,
    );
    const original = before ? podSpec(before) : {};
    const labels = object(object(object(resource.raw.spec).template).metadata).labels;
    const selector = object(labels ?? object(resource.raw.metadata).labels);
    const pods = healthy.pods.filter(
      (pod) =>
        (pod.namespace ?? healthy.namespace) === resource.namespace &&
        Object.entries(selector).every(([key, value]) => pod.labels?.[key] === value),
    );
    if (spec.nodeName && pods.some((pod) => pod.nodeName !== spec.nodeName))
      issues.push(
        `${resource.kind}/${resource.name}: nodeName bypasses scheduling and contradicts the required placement`,
      );
    if (
      spec.nodeSelector &&
      JSON.stringify(spec.nodeSelector) !== JSON.stringify(original.nodeSelector)
    ) {
      const nodes = healthy.nodes ?? [];
      if (
        pods.length === 0 ||
        pods.some((pod) => {
          const node = nodes.find((candidate) => candidate.name === pod.nodeName);
          return (
            !node ||
            Object.entries(object(spec.nodeSelector)).some(
              ([key, value]) =>
                (key === "kubernetes.io/hostname" ? node.name : node.labels?.[key]) !== value,
            )
          );
        })
      )
        issues.push(
          `${resource.kind}/${resource.name}: nodeSelector cannot place the required healthy replicas on the modelled nodes`,
        );
    }
    for (const field of [
      "schedulerName",
      "runtimeClassName",
      "readinessGates",
      "schedulingGates",
      "initContainers",
    ]) {
      if (JSON.stringify(spec[field]) !== JSON.stringify(original[field]))
        issues.push(
          `${resource.kind}/${resource.name}: changes to ${field} are outside this incident's execution model`,
        );
    }
    const affinity = object(spec.affinity);
    if (
      JSON.stringify(affinity.nodeAffinity) !==
      JSON.stringify(object(original.affinity).nodeAffinity)
    )
      issues.push(
        `${resource.kind}/${resource.name}: nodeAffinity changes are outside this incident's execution model; use its documented placement contract`,
      );
    const originals = array(original.containers).map(object);
    for (const container of array(spec.containers).map(object)) {
      const old = originals.find((candidate) => candidate.name === container.name);
      for (const field of ["command", "args"]) {
        const reviewed = level.constraints.some(
          (constraint) =>
            constraint.kind === "manifest" &&
            constraint.resource.kind === resource.kind &&
            constraint.resource.name === resource.name &&
            constraint.assertions.some((rule) =>
              rule.path.includes(`containers[name=${container.name}].${field}`),
            ),
        );
        if (!reviewed && JSON.stringify(container[field]) !== JSON.stringify(old?.[field]))
          issues.push(
            `${resource.kind}/${resource.name}: ${container.name}.${field} changes cannot be executed by this incident model`,
          );
      }
    }
  }
  return issues;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function podSpec(resource: ParsedKubernetesManifest) {
  const spec = object(resource.raw.spec);
  return resource.kind === "Pod" ? spec : object(object(spec.template).spec);
}
