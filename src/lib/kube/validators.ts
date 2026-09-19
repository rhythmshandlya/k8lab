import type { LevelValidatorDefinition, ProblemLevel } from "@/lib/domain/types";
import { assertNever } from "@/lib/utils/exhaustive";

import { isPodReady, podPhase, podRestarts, readyEndpointCount } from "./kubectl/format";
import { evaluateLevelConstraints } from "./manifest-constraints";
import { evaluateWorkspaceSemantics } from "./workspace-semantics";
import type { ClusterSnapshot, ProbeResult } from "./simulator";

/**
 * Validators check real cluster *behavior*, not YAML text. Each is a pure-ish async
 * function over a live snapshot (+ network probe for the HTTP check). Discriminated
 * on `kind` with an exhaustive switch so adding a validator kind is a compile error
 * until handled.
 */

export interface ValidatorResult {
  id: string;
  title: string;
  passed: boolean;
  /**
   * Observational current state (e.g. "0/2 ready replicas"). Safe to display for
   * free, before the learner submits: it says what is broken, never what to type.
   */
  detail: string;
  /**
   * Prescriptive breakdown (which requirement, expected vs found). Withheld from the
   * always-visible checks panel and revealed only after a formal submission, so the
   * free surface can never state the answer.
   */
  diagnostic?: string;
  label: string;
}

export interface ValidationReport {
  passed: boolean;
  results: ValidatorResult[];
}

export interface ValidatorContext {
  simulator: ValidationRuntime;
}

export interface ValidationRuntime {
  getSnapshot(): ClusterSnapshot;
  probe(url: string): Promise<ProbeResult>;
}

export async function runValidators(
  validators: readonly LevelValidatorDefinition[],
  ctx: ValidatorContext,
): Promise<ValidationReport> {
  const results = await Promise.all(validators.map((validator) => runValidator(validator, ctx)));
  return { passed: results.every((r) => r.passed), results };
}

/** Combine live-cluster checks with the authored constraints for a formal submission. */
export async function runLevelValidation(
  level: ProblemLevel,
  currentFiles: Readonly<Record<string, string>>,
  ctx: ValidatorContext,
): Promise<ValidationReport> {
  const runtime = await runValidators(level.validators, ctx);
  const constraints = evaluateLevelConstraints(level, currentFiles);
  const issues = evaluateWorkspaceSemantics(level, currentFiles);
  const results = [
    ...runtime.results,
    ...constraints,
    ...issues.map((detail, index) => ({
      id: `workspace-validity-${index}`,
      title: "Submitted Kubernetes configuration is valid",
      passed: false,
      detail: "The submitted configuration has a Kubernetes validity issue.",
      diagnostic: detail,
      label: "Correct the submitted manifest",
    })),
  ];
  return { passed: results.every((result) => result.passed), results };
}

export async function runValidator(
  validator: LevelValidatorDefinition,
  ctx: ValidatorContext,
): Promise<ValidatorResult> {
  const snapshot = ctx.simulator.getSnapshot();
  const { passed, detail } = await evaluate(validator, snapshot, ctx.simulator);
  return {
    id: validator.id,
    title: validator.title,
    passed,
    detail,
    label: passed ? validator.successLabel : validator.failureLabel,
  };
}

async function evaluate(
  validator: LevelValidatorDefinition,
  snapshot: ClusterSnapshot,
  simulator: ValidationRuntime,
): Promise<{ passed: boolean; detail: string }> {
  switch (validator.kind) {
    case "deployment-ready": {
      const deployment = snapshot.deployments.find(
        (d) =>
          d.metadata?.name === validator.name &&
          (d.metadata?.namespace ?? "default") === validator.namespace,
      );
      const ready = deployment?.status?.readyReplicas ?? 0;
      const desired = deployment?.spec?.replicas ?? 0;
      return {
        passed: deployment !== undefined && ready >= validator.minReadyReplicas,
        detail: deployment ? `${ready}/${desired} ready replicas` : "deployment not found",
      };
    }

    case "service-has-ready-endpoints": {
      const service = snapshot.services.find(
        (s) =>
          s.metadata?.name === validator.name &&
          (s.metadata?.namespace ?? "default") === validator.namespace,
      );
      const count = service ? readyEndpointCount(service, snapshot.endpointSlices) : 0;
      return {
        passed: service !== undefined && count >= validator.minReadyEndpoints,
        detail: service ? `${count} ready endpoint${count === 1 ? "" : "s"}` : "service not found",
      };
    }

    case "http-get-through-service": {
      const url = `http://${validator.service}.${validator.namespace}.svc.cluster.local:${validator.port}${validator.path}`;
      const probe = await simulator.probe(url);
      return {
        passed: probe.status === validator.expectStatus,
        detail:
          probe.status === 0
            ? `no response (${probe.reason ?? "unreachable"})`
            : `GET ${validator.path} → HTTP ${probe.status}`,
      };
    }

    case "http-sample-through-service": {
      const url = `http://${validator.service}.${validator.namespace}.svc.cluster.local:${validator.port}${validator.path}`;
      const statuses: number[] = [];
      for (let index = 0; index < validator.samples; index += 1) {
        statuses.push((await simulator.probe(url)).status);
      }
      const failures = statuses.filter((status) => status !== validator.expectStatus).length;
      return {
        passed: failures <= validator.maxFailures,
        detail: `${failures}/${validator.samples} samples missed HTTP ${validator.expectStatus} (${statuses.join(", ")})`,
      };
    }

    case "no-pods-failing-readiness": {
      // Current-state interpretation rather than event-history scraping, which is
      // timing-fragile. The kind is named for what it actually checks.
      const notReady = snapshot.pods.filter(
        (p) =>
          (p.metadata?.namespace ?? "default") === validator.namespace &&
          podPhase(p) === "Running" &&
          !isPodReady(p),
      );
      return {
        passed: notReady.length === 0,
        detail:
          notReady.length === 0
            ? "no failing readiness probes"
            : `${notReady.length} pod(s) Running but not Ready`,
      };
    }

    case "no-warning-events": {
      const warnings = snapshot.events.filter(
        (event) =>
          (event.metadata?.namespace ?? "default") === validator.namespace &&
          event.type === "Warning",
      );
      return {
        passed: warnings.length === 0,
        detail:
          warnings.length === 0
            ? `0 Warning events remain in ${validator.namespace}`
            : `${warnings.length} Warning event${warnings.length === 1 ? "" : "s"} remain in ${validator.namespace}`,
      };
    }

    case "pod-ready-by-selector": {
      const ready = snapshot.pods.filter(
        (p) =>
          (p.metadata?.namespace ?? "default") === validator.namespace &&
          matchesSelector(p.metadata?.labels, validator.selector) &&
          isPodReady(p),
      );
      return {
        passed: ready.length >= validator.minReady,
        detail: `${ready.length} matching pod(s) ready`,
      };
    }

    case "pod-restarts-below": {
      const matching = snapshot.pods.filter(
        (p) =>
          (p.metadata?.namespace ?? "default") === validator.namespace &&
          matchesSelector(p.metadata?.labels, validator.selector),
      );
      const worst = Math.max(0, ...matching.map((p) => podRestarts(p)));
      return {
        passed: matching.length > 0 && worst <= validator.maxRestarts,
        detail:
          matching.length === 0
            ? "no matching pods"
            : `highest restart count is ${worst} (limit ${validator.maxRestarts})`,
      };
    }

    case "no-pods-matching": {
      const matching = snapshot.pods.filter(
        (p) =>
          (p.metadata?.namespace ?? "default") === validator.namespace &&
          matchesSelector(p.metadata?.labels, validator.selector),
      );
      return {
        passed: matching.length === 0,
        detail:
          matching.length === 0
            ? "no pods match the selector"
            : `${matching.length} pod(s) still match ${formatSelectorInline(validator.selector)}`,
      };
    }

    default:
      return assertNever(validator);
  }
}

function matchesSelector(
  labels: Record<string, string> | undefined,
  selector: Record<string, string>,
): boolean {
  if (!labels) return false;
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function formatSelectorInline(selector: Record<string, string>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}
