import type { ProblemCapability, ProblemLevel } from "@/lib/domain/types";
import { err, ok, type Result } from "@/lib/utils/result";

import type { LogLine } from "./images/log-sink";
import { evaluateGoal } from "./goal-checks";
import { evaluateLevelConstraints } from "./manifest-constraints";
import { parseKubernetesManifests } from "./manifest-parser";
import type { ParsedManifest } from "./manifest-parser";
import type { AppliedResourceRef, ClusterSnapshot, ProbeResult } from "./simulator";
import { evaluateWorkspaceSemantics } from "./workspace-semantics";

export interface ScriptedScenarioRuntime {
  readonly capabilities: ReadonlySet<ProblemCapability>;
  /**
   * True when the scenario grades the workspace as a whole and cannot act on a
   * single manifest. `kubectl apply -f <file>` then re-runs the full review instead
   * of failing, so the terminal and the Apply button stay consistent.
   */
  readonly appliesWholeWorkspace?: boolean;
  boot(): Result<AppliedResourceRef[], string>;
  snapshot(): ClusterSnapshot;
  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string>;
  applyFiles?(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Result<AppliedResourceRef[], string>;
  probe(url: string): ProbeResult;
  logs(namespace: string, pod: string, container?: string): LogLine[];
}

/** Shown before the learner has submitted anything for review. */
const UNREVIEWED_ISSUE = "the submitted manifests have not passed static review";

/** The two-node analytics cluster cannot hold a surge replica; must match the level. */
const SCHEDULABLE_ANALYTICS_REPLICAS = 2;

const PRIVATE_REGISTRY_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "events",
  "http-probes",
  "image-pulls",
  "secrets",
]);

const GRACEFUL_SHUTDOWN_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "replicasets",
  "events",
  "logs",
  "http-probes",
  "rollouts",
  "container-lifecycle",
]);

const RECREATE_OUTAGE_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "replicasets",
  "events",
  "logs",
  "http-probes",
  "rollouts",
  "container-lifecycle",
]);

const ROLLOUT_MAXSURGE_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "replicasets",
  "events",
  "http-probes",
  "rollouts",
  "scheduling",
]);

const IMMUTABLE_SELECTOR_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "events",
  "http-probes",
  "rollouts",
]);

const MANIFEST_ASSESSMENT_CAPABILITIES = new Set<ProblemCapability>([
  "pods",
  "services",
  "deployments",
  "replicasets",
  "namespaces",
  "nodes",
  "events",
  "logs",
  "http-probes",
  "dns",
  "rollouts",
  "image-pulls",
  "container-restarts",
  "container-lifecycle",
  "multi-container",
  "configmaps",
  "secrets",
  "workload-controllers",
  "network-policy",
  "scheduling",
]);

const CAPABILITIES: Readonly<Record<string, ReadonlySet<ProblemCapability>>> = {
  "private-registry-pull": PRIVATE_REGISTRY_CAPABILITIES,
  "graceful-shutdown-502": GRACEFUL_SHUTDOWN_CAPABILITIES,
  "recreate-strategy-outage": RECREATE_OUTAGE_CAPABILITIES,
  "rollout-maxsurge-capacity": ROLLOUT_MAXSURGE_CAPABILITIES,
  "immutable-selector": IMMUTABLE_SELECTOR_CAPABILITIES,
  "manifest-assessment": MANIFEST_ASSESSMENT_CAPABILITIES,
};

export function scriptedScenarioCapabilities(scenarioId: string): ReadonlySet<ProblemCapability> {
  return CAPABILITIES[scenarioId] ?? new Set();
}

export function createScriptedScenarioRuntime(
  scenarioId: string,
): ScriptedScenarioRuntime | undefined {
  if (scenarioId === "private-registry-pull") return new PrivateRegistryScenario();
  if (scenarioId === "graceful-shutdown-502") return new GracefulShutdownScenario();
  if (scenarioId === "recreate-strategy-outage") return new RecreateStrategyScenario();
  if (scenarioId === "rollout-maxsurge-capacity") return new RolloutMaxSurgeScenario();
  if (scenarioId === "immutable-selector") return new ImmutableSelectorScenario();
  if (scenarioId === "manifest-assessment") return new ManifestAssessmentScenario();
  return undefined;
}

export function emptyScriptedSnapshot(): ClusterSnapshot {
  return {
    pods: [],
    services: [],
    deployments: [],
    replicaSets: [],
    endpointSlices: [],
    namespaces: [],
    nodes: [],
    events: [],
  };
}

/**
 * Deterministic policy lab for Kubernetes APIs the browser control plane does not
 * execute. Apply parses every editable file and evaluates the level's declared
 * manifest constraints. The visible assessment workload becomes Ready only when all
 * rules pass, so learners must still edit, Apply, inspect, and validate.
 */
class ManifestAssessmentScenario implements ScriptedScenarioRuntime {
  readonly capabilities = MANIFEST_ASSESSMENT_CAPABILITIES;
  readonly appliesWholeWorkspace = true;
  private fixed = false;
  private issues: string[] = [UNREVIEWED_ISSUE];

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    this.issues = [UNREVIEWED_ISSUE];
    return ok([
      { kind: "Deployment", name: "manifest-assessment", namespace: "default" },
      { kind: "Service", name: "assessment-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return manifestAssessmentSnapshot(this.fixed, this.rejectionMessage());
  }

  apply(_manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    return err("This policy lab requires the complete editable workspace.");
  }

  applyFiles(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Result<AppliedResourceRef[], string> {
    const mergedFiles = Object.fromEntries(
      level.files.map((file) => [file.path, files[file.path] ?? file.initialValue]),
    );
    const resources: AppliedResourceRef[] = [];

    for (const file of level.files.filter((candidate) => candidate.access === "editable")) {
      const parsed = parseKubernetesManifests(mergedFiles[file.path] ?? file.initialValue);
      if (!parsed.ok) return err(`${file.path}: ${parsed.error.message}`);
      resources.push(
        ...parsed.value.map((manifest) => ({
          kind: manifest.kind,
          name: manifest.name,
          namespace: manifest.namespace,
        })),
      );
    }

    const constraintIssues = evaluateLevelConstraints(level, mergedFiles)
      .filter((result) => !result.passed)
      .map((result) => result.detail);
    this.issues = [...constraintIssues, ...evaluateWorkspaceSemantics(level, mergedFiles)];
    this.fixed = this.issues.length === 0;
    return ok(resources);
  }

  /**
   * The rejection event a learner reads on the Events tab. It always names the
   * production-requirements boundary (the phrase the level's evidence rule matches)
   * and then summarizes how much is unmet, without naming the fix.
   */
  private rejectionMessage(): string {
    // The phrase "production requirements" is load-bearing: it is the boundary the
    // level's evidence rule matches on, so it must survive every issue count.
    return `production requirements not satisfied (${this.issues.length} unmet): ${
      this.issues[0] ?? UNREVIEWED_ISSUE
    }`;
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "assessment-svc" && host !== "assessment-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    return this.fixed
      ? { ok: true, status: 200, body: "manifest assessment passed\n" }
      : {
          ok: false,
          status: 422,
          body: "manifest assessment failed\n",
          reason: "One or more production requirements are not satisfied",
        };
  }

  logs(namespace: string, pod: string): LogLine[] {
    if (namespace !== "default" || pod !== "manifest-assessment") return [];
    return [
      scriptedLog(
        pod,
        "policy-engine",
        this.fixed
          ? "all production requirements satisfied"
          : `configuration rejected: ${this.rejectionMessage()}`,
      ),
    ];
  }
}

class PrivateRegistryScenario implements ScriptedScenarioRuntime {
  readonly capabilities = PRIVATE_REGISTRY_CAPABILITIES;
  readonly appliesWholeWorkspace = true;
  private fixed = false;

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    return ok([
      { kind: "Deployment", name: "private-api", namespace: "default" },
      { kind: "Service", name: "private-api-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return privateRegistrySnapshot(this.fixed);
  }

  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "private-api",
    );
    if (!deployment) return err("The private-api Deployment is missing.");
    // One source of truth with the level's acceptance goal, so the simulated cluster
    // and the validator can never disagree about whether the incident is fixed.
    this.fixed = evaluateGoal(
      { goal: "pulls-with-credentials", secret: "registry-credentials" },
      deployment.raw,
    ).passed;
    return ok([{ kind: "Deployment", name: "private-api", namespace: "default" }]);
  }

  applyFiles(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Result<AppliedResourceRef[], string> {
    const mergedFiles = Object.fromEntries(
      level.files.map((file) => [file.path, files[file.path] ?? file.initialValue]),
    );
    const source = mergedFiles["deployment.yaml"];
    if (!source) return err("The private-api Deployment is missing.");
    const parsed = parseKubernetesManifests(source);
    if (!parsed.ok) return err(`deployment.yaml: ${parsed.error.message}`);
    const deployment = parsed.value.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "private-api",
    );
    if (!deployment) return err("The private-api Deployment is missing.");

    // The cluster state must agree with the complete acceptance rubric. Checking
    // only imagePullSecrets made a scaled-to-zero or disconnected workload appear
    // healthy even though validation correctly rejected it.
    this.fixed =
      evaluateLevelConstraints(level, mergedFiles).every((result) => result.passed) &&
      evaluateWorkspaceSemantics(level, mergedFiles).length === 0;
    return ok([{ kind: "Deployment", name: "private-api", namespace: "default" }]);
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "private-api-svc" && host !== "private-api-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    return this.fixed
      ? { ok: true, status: 200, body: "private api ready\n" }
      : { ok: false, status: 503, body: "no ready endpoints\n", reason: "ImagePullBackOff" };
  }

  logs(namespace: string, pod: string): LogLine[] {
    if (namespace !== "default" || pod !== "private-api-6f4d9" || !this.fixed) return [];
    return [scriptedLog(pod, "api", "server listening on :8080")];
  }
}

class GracefulShutdownScenario implements ScriptedScenarioRuntime {
  readonly capabilities = GRACEFUL_SHUTDOWN_CAPABILITIES;
  private fixed = false;
  private probeIndex = 0;

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    this.probeIndex = 0;
    return ok([
      { kind: "Deployment", name: "edge-api", namespace: "default" },
      { kind: "Service", name: "edge-api-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return gracefulShutdownSnapshot(this.fixed);
  }

  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "edge-api",
    );
    if (!deployment) return err("The edge-api Deployment is missing.");

    this.fixed = evaluateGoal(
      { goal: "graceful-drain", container: "api", minGraceSeconds: 15, minDrainSeconds: 10 },
      deployment.raw,
    ).passed;
    this.probeIndex = 0;
    return ok([{ kind: "Deployment", name: "edge-api", namespace: "default" }]);
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "edge-api-svc" && host !== "edge-api-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    this.probeIndex += 1;
    if (!this.fixed && this.probeIndex % 3 === 0) {
      return {
        ok: false,
        status: 502,
        body: "backend=edge-api-old state=terminating listener=closed\n",
        reason: "Ingress still routed to a terminating endpoint",
      };
    }
    return {
      ok: true,
      status: 200,
      body: `backend=${this.fixed ? "edge-api-new" : "edge-api-new-a"} status=ok\n`,
    };
  }

  logs(namespace: string, pod: string, container?: string): LogLine[] {
    if (namespace !== "default" || (container && container !== "api")) return [];
    if (pod === "edge-api-old") {
      return [
        scriptedLog(pod, "api", "SIGTERM received; closing listener immediately"),
        scriptedLog(pod, "api", "existing connections drained; process awaiting termination"),
      ];
    }
    if (pod.startsWith("edge-api-new")) {
      return [scriptedLog(pod, "api", "edge-api listening on :8080")];
    }
    return [];
  }
}

/**
 * Problem 20: Recreate Strategy Outage. A Recreate rollout terminated every old pod
 * before the new release passed readiness, so the Service has zero ready endpoints.
 * Switching to RollingUpdate (maxUnavailable 0) lets the controller keep old pods
 * serving until the new ones are Ready.
 */
class RecreateStrategyScenario implements ScriptedScenarioRuntime {
  readonly capabilities = RECREATE_OUTAGE_CAPABILITIES;
  private fixed = false;

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    return ok([
      { kind: "Deployment", name: "checkout", namespace: "default" },
      { kind: "Service", name: "checkout-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return recreateOutageSnapshot(this.fixed);
  }

  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "checkout",
    );
    if (!deployment) return err("The checkout Deployment is missing.");
    if (!hasOriginalAppSelector(deployment.raw, "checkout")) {
      return err(
        'The Deployment "checkout" is invalid: spec.selector: Invalid value: field is immutable',
      );
    }
    this.fixed = evaluateGoal({ goal: "zero-downtime-rollout" }, deployment.raw).passed;
    return ok([{ kind: "Deployment", name: "checkout", namespace: "default" }]);
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "checkout-svc" && host !== "checkout-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    return this.fixed
      ? { ok: true, status: 200, body: "checkout api ready\n" }
      : {
          ok: false,
          status: 503,
          body: "no ready endpoints\n",
          reason: "Recreate rollout terminated every pod before the new release was Ready",
        };
  }

  logs(namespace: string, pod: string, container?: string): LogLine[] {
    if (namespace !== "default" || (container && container !== "api")) return [];
    if (this.fixed && pod.startsWith("checkout-")) {
      return [scriptedLog(pod, "api", "checkout api listening on :8080")];
    }
    if (!this.fixed && pod.startsWith("checkout-new")) {
      return [
        scriptedLog(pod, "api", "starting up; readiness probe not yet passing"),
        scriptedLog(pod, "api", "old replicas already terminated by Recreate strategy"),
      ];
    }
    return [];
  }
}

/**
 * Problem 19: Rollout Cannot Fit maxSurge. The cluster has only enough capacity for
 * the desired replica count. With maxSurge>0 the controller tries to create extra
 * surge pods that cannot schedule (Pending, Insufficient cpu), and maxUnavailable:0
 * prevents it from freeing room, so the new release never lands. Setting maxSurge:0
 * with maxUnavailable:1 lets the controller roll within existing capacity.
 */
class RolloutMaxSurgeScenario implements ScriptedScenarioRuntime {
  readonly capabilities = ROLLOUT_MAXSURGE_CAPABILITIES;
  private fixed = false;

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    return ok([
      { kind: "Deployment", name: "analytics", namespace: "default" },
      { kind: "Service", name: "analytics-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return rolloutMaxSurgeSnapshot(this.fixed);
  }

  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "analytics",
    );
    if (!deployment) return err("The analytics Deployment is missing.");
    this.fixed = evaluateGoal(
      { goal: "rollout-fits-capacity", schedulableReplicas: SCHEDULABLE_ANALYTICS_REPLICAS },
      deployment.raw,
    ).passed;
    return ok([{ kind: "Deployment", name: "analytics", namespace: "default" }]);
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "analytics-svc" && host !== "analytics-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    return this.fixed
      ? { ok: true, status: 200, body: "analytics v2 ready\n" }
      : {
          ok: false,
          status: 500,
          body: "analytics v1 internal error\n",
          reason: "v1 is serving 500",
        };
  }

  logs(namespace: string, pod: string, container?: string): LogLine[] {
    if (namespace !== "default" || (container && container !== "api")) return [];
    if (this.fixed && pod.startsWith("analytics-")) {
      return [scriptedLog(pod, "api", "analytics v2 listening on :8080")];
    }
    if (!this.fixed && pod.startsWith("analytics-old")) {
      return [scriptedLog(pod, "api", "analytics v1 internal error: dependency schema mismatch")];
    }
    return [];
  }
}

/**
 * Problem 21: Immutable Deployment Selector. The Service now selects pods carrying
 * `tier: api`, but the pods lack that label. A teammate tried to add it through the
 * Deployment selector, which the API rejects (selectors are immutable). The safe fix
 * is to leave the selector alone and add `tier: api` to the pod template labels.
 */
class ImmutableSelectorScenario implements ScriptedScenarioRuntime {
  readonly capabilities = IMMUTABLE_SELECTOR_CAPABILITIES;
  private fixed = false;

  boot(): Result<AppliedResourceRef[], string> {
    this.fixed = false;
    return ok([
      { kind: "Deployment", name: "search", namespace: "default" },
      { kind: "Service", name: "search-svc", namespace: "default" },
    ]);
  }

  snapshot(): ClusterSnapshot {
    return immutableSelectorSnapshot(this.fixed);
  }

  apply(manifests: readonly ParsedManifest[]): Result<AppliedResourceRef[], string> {
    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.name === "search",
    );
    if (!deployment) return err("The search Deployment is missing.");
    if (!hasOriginalAppSelector(deployment.raw, "search")) {
      return err(
        'The Deployment "search" is invalid: spec.selector: Invalid value: field is immutable',
      );
    }
    const templateLabels = objectAt(deployment.raw, "spec.template.metadata.labels");
    this.fixed =
      (templateLabels as Record<string, unknown>)?.app === "search" &&
      (templateLabels as Record<string, unknown>)?.tier === "api";
    return ok([{ kind: "Deployment", name: "search", namespace: "default" }]);
  }

  probe(url: string): ProbeResult {
    const host = safeHostname(url);
    if (host !== "search-svc" && host !== "search-svc.default.svc.cluster.local") {
      return { ok: false, status: 0, body: "", reason: `Service ${host || url} not found` };
    }
    return this.fixed
      ? { ok: true, status: 200, body: "search api ready\n" }
      : {
          ok: false,
          status: 503,
          body: "no ready endpoints\n",
          reason: "No pods carry the tier: api label the Service selects",
        };
  }

  logs(_namespace: string, _pod: string, _container?: string): LogLine[] {
    return [];
  }
}

function hasOriginalAppSelector(resource: Record<string, unknown>, app: string): boolean {
  const selector = objectAt(resource, "spec.selector");
  const matchLabels = objectAt(resource, "spec.selector.matchLabels");
  return (
    selector !== undefined &&
    Object.keys(selector).length === 1 &&
    Object.keys(matchLabels ?? {}).length === 1 &&
    matchLabels?.app === app
  );
}

function manifestAssessmentSnapshot(fixed: boolean, rejectionMessage: string): ClusterSnapshot {
  const podName = "manifest-assessment";
  const pod = {
    metadata: {
      name: podName,
      namespace: "default",
      labels: { app: "manifest-assessment", assessment: fixed ? "passed" : "pending" },
    },
    spec: {
      nodeName: "node-1",
      containers: [{ name: "policy-engine", image: "klab/manifest-assessment:1.0.0" }],
    },
    status: {
      phase: "Running",
      podIP: "10.0.0.90",
      conditions: [{ type: "Ready", status: fixed ? "True" : "False" }],
      containerStatuses: [
        {
          name: "policy-engine",
          image: "klab/manifest-assessment:1.0.0",
          imageID: "scripted://manifest-assessment-1.0.0",
          ready: fixed,
          restartCount: 0,
          state: { running: { startedAt: new Date("2026-08-11T00:00:00Z") } },
        },
      ],
    },
  };
  const service = {
    metadata: { name: "assessment-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.99",
      selector: { app: "manifest-assessment" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };

  return {
    pods: [pod],
    services: [service],
    deployments: [
      {
        metadata: { name: "manifest-assessment", namespace: "default" },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "manifest-assessment" } },
          template: pod,
        },
        status: { replicas: 1, readyReplicas: fixed ? 1 : 0, unavailableReplicas: fixed ? 0 : 1 },
      },
    ],
    replicaSets: [],
    endpointSlices: [
      {
        metadata: {
          name: "assessment-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "assessment-svc" },
        },
        addressType: "IPv4",
        endpoints: fixed
          ? [
              {
                addresses: ["10.0.0.90"],
                conditions: { ready: true },
                targetRef: { name: podName },
              },
            ]
          : [],
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }],
    events: fixed
      ? []
      : [
          {
            metadata: { name: "manifest-assessment-rejected", namespace: "default" },
            involvedObject: {
              kind: "Deployment",
              name: "manifest-assessment",
              namespace: "default",
            },
            type: "Warning",
            reason: "ConfigRejected",
            message: rejectionMessage,
          },
        ],
  } as unknown as ClusterSnapshot;
}

function privateRegistrySnapshot(fixed: boolean): ClusterSnapshot {
  const podName = "private-api-6f4d9";
  const podTemplate = {
    metadata: { labels: { app: "private-api" } },
    spec: {
      ...(fixed ? { imagePullSecrets: [{ name: "registry-credentials" }] } : {}),
      containers: [
        {
          name: "api",
          image: "registry.example/private/api:1.0.0",
          ports: [{ name: "http", containerPort: 8080 }],
        },
      ],
    },
  };
  const pod = {
    metadata: { name: podName, namespace: "default", labels: { app: "private-api" } },
    spec: {
      ...podTemplate.spec,
      nodeName: "node-1",
    },
    status: {
      phase: fixed ? "Running" : "Pending",
      podIP: fixed ? "10.0.0.21" : undefined,
      conditions: [{ type: "Ready", status: fixed ? "True" : "False" }],
      containerStatuses: [
        {
          name: "api",
          image: "registry.example/private/api:1.0.0",
          imageID: fixed ? "scripted://private-api-1.0.0" : "",
          ready: fixed,
          restartCount: 0,
          state: fixed
            ? { running: { startedAt: new Date("2026-07-10T00:00:00Z") } }
            : { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } },
        },
      ],
    },
  };
  const service = {
    metadata: { name: "private-api-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.90",
      selector: { app: "private-api" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };
  return {
    pods: [pod],
    services: [service],
    deployments: [
      {
        metadata: { name: "private-api", namespace: "default" },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "private-api" } },
          template: podTemplate,
        },
        status: {
          replicas: 1,
          updatedReplicas: 1,
          availableReplicas: fixed ? 1 : 0,
          readyReplicas: fixed ? 1 : 0,
          unavailableReplicas: fixed ? 0 : 1,
        },
      },
    ],
    replicaSets: [],
    endpointSlices: [
      {
        metadata: {
          name: "private-api-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "private-api-svc" },
        },
        addressType: "IPv4",
        endpoints: fixed
          ? [
              {
                addresses: ["10.0.0.21"],
                conditions: { ready: true },
                targetRef: { name: podName },
              },
            ]
          : [],
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }],
    resources: [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "registry-credentials", namespace: "default" },
        type: "kubernetes.io/dockerconfigjson",
        data: {
          ".dockerconfigjson":
            "eyJhdXRocyI6eyJyZWdpc3RyeS5leGFtcGxlIjp7ImF1dGgiOiJSRURBQ1RFRCJ9fX0=",
        },
      },
    ],
    events: fixed
      ? []
      : [
          {
            metadata: { name: "private-api-pull", namespace: "default" },
            involvedObject: { kind: "Pod", name: podName, namespace: "default" },
            type: "Warning",
            reason: "Failed",
            message:
              "Failed to pull image registry.example/private/api:1.0.0: pull access denied; registry authorization failed",
          },
        ],
  } as unknown as ClusterSnapshot;
}

function gracefulShutdownSnapshot(fixed: boolean): ClusterSnapshot {
  // Matches the accepted repair: a drain window long enough to contain the preStop hook.
  const grace = fixed ? 15 : 5;
  const newPods = [
    scriptedRunningPod("edge-api-new-a", "10.0.0.31", "new", false, grace),
    scriptedRunningPod("edge-api-new-b", "10.0.0.32", "new", false, grace),
  ];
  const oldPod = scriptedRunningPod("edge-api-old", "10.0.0.30", "old", true, 5);
  const pods = fixed ? newPods : [oldPod, ...newPods];
  const endpoints = pods.map((pod) => {
    const terminating = pod.metadata.deletionTimestamp !== undefined;
    return {
      addresses: [pod.status.podIP],
      // EndpointSlice keeps a terminating endpoint visible for drain-aware consumers,
      // but marks `ready` false for backward compatibility. `serving` communicates
      // whether it can still drain traffic while external routes converge.
      conditions: { ready: !terminating, serving: true, terminating },
      targetRef: { name: pod.metadata.name },
    };
  });
  const service = {
    metadata: { name: "edge-api-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.91",
      selector: { app: "edge-api" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };

  return {
    pods,
    services: [service],
    deployments: [
      {
        metadata: { name: "edge-api", namespace: "default" },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "edge-api" } },
          template: { metadata: { labels: { app: "edge-api", release: "new" } } },
        },
        status: { replicas: fixed ? 2 : 3, readyReplicas: fixed ? 2 : 3, updatedReplicas: 2 },
      },
    ],
    replicaSets: [
      scriptedReplicaSet("edge-api-old-rs", "old", fixed ? 0 : 1),
      scriptedReplicaSet("edge-api-new-rs", "new", 2),
    ],
    endpointSlices: [
      {
        metadata: {
          name: "edge-api-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "edge-api-svc" },
        },
        addressType: "IPv4",
        endpoints,
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }, { metadata: { name: "node-2" } }],
    events: fixed
      ? []
      : [
          {
            metadata: { name: "edge-api-terminating", namespace: "default" },
            involvedObject: { kind: "Pod", name: "edge-api-old", namespace: "default" },
            type: "Normal",
            reason: "Killing",
            message:
              "Stopping container api while external load-balancer endpoint removal is pending",
          },
        ],
  } as unknown as ClusterSnapshot;
}

function recreateOutageSnapshot(fixed: boolean): ClusterSnapshot {
  const image = "klab/checkout:2.1.0";
  const podSpec = (name: string, ready: boolean, podIP: string | undefined) => ({
    metadata: {
      name,
      namespace: "default",
      labels: { app: "checkout", "pod-template-hash": "7d9c1" },
    },
    spec: {
      nodeName: "node-1",
      containers: [{ name: "api", image, ports: [{ name: "http", containerPort: 8080 }] }],
    },
    status: {
      phase: "Running",
      podIP,
      conditions: [
        { type: "Ready", status: ready ? "True" : "False" },
        { type: "ContainersReady", status: ready ? "True" : "False" },
      ],
      containerStatuses: [
        {
          name: "api",
          image,
          imageID: "scripted://checkout-2.1.0",
          ready,
          restartCount: 0,
          state: { running: { startedAt: new Date("2026-07-10T00:00:00Z") } },
        },
      ],
    },
  });
  const pods = fixed
    ? [podSpec("checkout-a", true, "10.0.0.41"), podSpec("checkout-b", true, "10.0.0.42")]
    : [
        podSpec("checkout-new-a", false, "10.0.0.41"),
        podSpec("checkout-new-b", false, "10.0.0.42"),
      ];
  const readyPods = pods.filter((pod) => pod.status.conditions[0]?.status === "True");
  const endpoints = readyPods.map((pod) => ({
    addresses: [pod.status.podIP],
    conditions: { ready: true },
    targetRef: { name: pod.metadata.name },
  }));
  const service = {
    metadata: { name: "checkout-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.93",
      selector: { app: "checkout" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };
  return {
    pods,
    services: [service],
    deployments: [
      {
        metadata: { name: "checkout", namespace: "default" },
        spec: {
          replicas: 2,
          strategy: fixed
            ? { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
            : { type: "Recreate" },
          selector: { matchLabels: { app: "checkout" } },
          template: {
            metadata: { labels: { app: "checkout" } },
            spec: {
              containers: [
                {
                  name: "api",
                  image,
                  ports: [{ name: "http", containerPort: 8080 }],
                  readinessProbe: {
                    httpGet: { path: "/healthz", port: 8080 },
                    periodSeconds: 2,
                  },
                },
              ],
            },
          },
        },
        status: {
          replicas: 2,
          readyReplicas: fixed ? 2 : 0,
          updatedReplicas: 2,
          unavailableReplicas: fixed ? 0 : 2,
        },
      },
    ],
    replicaSets: [
      ...(!fixed
        ? [
            {
              metadata: {
                name: "checkout-5f2a1-oldrs",
                namespace: "default",
                labels: { app: "checkout", "pod-template-hash": "5f2a1" },
              },
              spec: {
                replicas: 0,
                selector: { matchLabels: { app: "checkout", "pod-template-hash": "5f2a1" } },
                template: {
                  metadata: { labels: { app: "checkout", "pod-template-hash": "5f2a1" } },
                },
              },
              status: { replicas: 0, readyReplicas: 0, availableReplicas: 0 },
            },
          ]
        : []),
      {
        metadata: {
          name: fixed ? "checkout-7d9c1-rs" : "checkout-7d9c1-newrs",
          namespace: "default",
          labels: { app: "checkout", "pod-template-hash": "7d9c1" },
        },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "checkout", "pod-template-hash": "7d9c1" } },
          template: {
            metadata: { labels: { app: "checkout", "pod-template-hash": "7d9c1" } },
          },
        },
        status: { replicas: 2, readyReplicas: fixed ? 2 : 0, availableReplicas: fixed ? 2 : 0 },
      },
    ],
    endpointSlices: [
      {
        metadata: {
          name: "checkout-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "checkout-svc" },
        },
        addressType: "IPv4",
        endpoints,
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }, { metadata: { name: "node-2" } }],
    events: fixed
      ? []
      : [
          {
            metadata: { name: "checkout-scaling", namespace: "default" },
            involvedObject: {
              kind: "ReplicaSet",
              name: "checkout-5f2a1-oldrs",
              namespace: "default",
            },
            type: "Normal",
            reason: "ScalingReplicaSet",
            message: "Scaled down replica set checkout-5f2a1-oldrs to 0 (Recreate strategy)",
          },
        ],
  } as unknown as ClusterSnapshot;
}

function rolloutMaxSurgeSnapshot(fixed: boolean): ClusterSnapshot {
  const readyPod = (
    name: string,
    podIP: string,
    image: string,
    labels: Record<string, string>,
  ) => ({
    metadata: { name, namespace: "default", labels },
    spec: {
      nodeName: "node-1",
      containers: [
        {
          name: "api",
          image,
          ports: [{ name: "http", containerPort: 8080 }],
          resources: { requests: { cpu: "2" }, limits: { cpu: "2" } },
        },
      ],
    },
    status: {
      phase: "Running",
      podIP,
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "api",
          image,
          imageID: `scripted://${image}`,
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: new Date("2026-07-10T00:00:00Z") } },
        },
      ],
    },
  });
  const pendingPod = (name: string) => ({
    metadata: { name, namespace: "default", labels: { app: "analytics", track: "v2" } },
    spec: {
      nodeName: undefined,
      containers: [
        {
          name: "api",
          image: "klab/analytics:2.0.0",
          ports: [{ name: "http", containerPort: 8080 }],
          resources: { requests: { cpu: "2" }, limits: { cpu: "2" } },
        },
      ],
    },
    status: {
      phase: "Pending",
      podIP: undefined as string | undefined,
      conditions: [{ type: "PodScheduled", status: "False" }],
      containerStatuses: [],
    },
  });
  const pods = fixed
    ? [
        readyPod("analytics-a", "10.0.0.51", "klab/analytics:2.0.0", {
          app: "analytics",
          track: "v2",
        }),
        readyPod("analytics-b", "10.0.0.52", "klab/analytics:2.0.0", {
          app: "analytics",
          track: "v2",
        }),
      ]
    : [
        readyPod("analytics-old-a", "10.0.0.53", "klab/analytics:1.0.0", {
          app: "analytics",
          track: "v1",
        }),
        readyPod("analytics-old-b", "10.0.0.54", "klab/analytics:1.0.0", {
          app: "analytics",
          track: "v1",
        }),
        pendingPod("analytics-new-a"),
        pendingPod("analytics-new-b"),
      ];
  const readyPods = pods.filter((pod) => pod.status.phase === "Running");
  const endpoints = readyPods.map((pod) => ({
    addresses: [pod.status.podIP],
    conditions: { ready: true },
    targetRef: { name: pod.metadata.name },
  }));
  const service = {
    metadata: { name: "analytics-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.94",
      selector: { app: "analytics" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };
  return {
    pods,
    services: [service],
    deployments: [
      {
        metadata: { name: "analytics", namespace: "default" },
        spec: {
          replicas: 2,
          strategy: fixed
            ? { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }
            : { type: "RollingUpdate", rollingUpdate: { maxSurge: 2, maxUnavailable: 0 } },
          selector: { matchLabels: { app: "analytics" } },
          template: { metadata: { labels: { app: "analytics" } } },
        },
        status: {
          replicas: fixed ? 2 : 4,
          readyReplicas: 2,
          updatedReplicas: fixed ? 2 : 0,
          unavailableReplicas: fixed ? 0 : 2,
        },
      },
    ],
    replicaSets: fixed
      ? [
          {
            metadata: {
              name: "analytics-3b8f1-v2rs",
              namespace: "default",
              labels: { app: "analytics", track: "v2" },
            },
            spec: {
              replicas: 2,
              selector: { matchLabels: { app: "analytics" } },
              template: { metadata: { labels: { app: "analytics", track: "v2" } } },
            },
            status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
          },
        ]
      : [
          {
            metadata: {
              name: "analytics-2a1c0-v1rs",
              namespace: "default",
              labels: { app: "analytics", track: "v1" },
            },
            spec: {
              replicas: 2,
              selector: { matchLabels: { app: "analytics" } },
              template: { metadata: { labels: { app: "analytics", track: "v1" } } },
            },
            status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
          },
          {
            metadata: {
              name: "analytics-3b8f1-v2rs",
              namespace: "default",
              labels: { app: "analytics", track: "v2" },
            },
            spec: {
              replicas: 2,
              selector: { matchLabels: { app: "analytics" } },
              template: { metadata: { labels: { app: "analytics", track: "v2" } } },
            },
            status: { replicas: 0, readyReplicas: 0, availableReplicas: 0 },
          },
        ],
    endpointSlices: [
      {
        metadata: {
          name: "analytics-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "analytics-svc" },
        },
        addressType: "IPv4",
        endpoints,
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }],
    events: fixed
      ? []
      : [
          {
            metadata: { name: "analytics-new-a-sched", namespace: "default" },
            involvedObject: { kind: "Pod", name: "analytics-new-a", namespace: "default" },
            type: "Warning",
            reason: "FailedScheduling",
            message:
              "0/1 nodes are available: 1 Insufficient cpu. Deployment rollout is blocked: maxSurge=2 cannot fit, maxUnavailable=0 will not yield capacity.",
          },
        ],
  } as unknown as ClusterSnapshot;
}

function immutableSelectorSnapshot(fixed: boolean): ClusterSnapshot {
  const image = "klab/search:1.4.0";
  const labels = fixed ? { app: "search", tier: "api" } : { app: "search" };
  const podSpec = (name: string, podIP: string) => ({
    metadata: { name, namespace: "default", labels },
    spec: {
      nodeName: "node-1",
      containers: [{ name: "api", image, ports: [{ name: "http", containerPort: 8080 }] }],
    },
    status: {
      phase: "Running",
      podIP,
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "api",
          image,
          imageID: "scripted://search-1.4.0",
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: new Date("2026-07-10T00:00:00Z") } },
        },
      ],
    },
  });
  const pods = [podSpec("search-a", "10.0.0.61"), podSpec("search-b", "10.0.0.62")];
  // Service selects {app: search, tier: api}; pods only match when tier: api is present.
  const matchingPods = fixed ? pods : [];
  const endpoints = matchingPods.map((pod) => ({
    addresses: [pod.status.podIP],
    conditions: { ready: true },
    targetRef: { name: pod.metadata.name },
  }));
  const service = {
    metadata: { name: "search-svc", namespace: "default" },
    spec: {
      clusterIP: "10.96.0.95",
      selector: { app: "search", tier: "api" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    },
  };
  return {
    pods,
    services: [service],
    deployments: [
      {
        metadata: { name: "search", namespace: "default" },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "search" } },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "api",
                  image,
                  ports: [{ name: "http", containerPort: 8080 }],
                  readinessProbe: {
                    httpGet: { path: "/healthz", port: 8080 },
                    periodSeconds: 2,
                  },
                },
              ],
            },
          },
        },
        status: { replicas: 2, readyReplicas: 2, updatedReplicas: 2 },
      },
    ],
    replicaSets: [
      {
        metadata: { name: "search-6e2a1-rs", namespace: "default", labels: { app: "search" } },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "search" } },
          template: { metadata: { labels } },
        },
        status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
      },
    ],
    endpointSlices: [
      {
        metadata: {
          name: "search-svc-scripted",
          namespace: "default",
          labels: { "kubernetes.io/service-name": "search-svc" },
        },
        addressType: "IPv4",
        endpoints,
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
    namespaces: [{ metadata: { name: "default" } }],
    nodes: [{ metadata: { name: "node-1" } }],
    // A Service with no matching Pods does not emit a warning Event; the empty
    // EndpointSlice is the real diagnostic surface.
    events: [],
  } as unknown as ClusterSnapshot;
}

function scriptedRunningPod(
  name: string,
  podIP: string,
  release: string,
  terminating = false,
  /**
   * The whole incident is "the drain window is too short", so the running Pod has to
   * report the window the manifest actually asks for. Defaulting it silently to 30s
   * made `kubectl describe pod` contradict the manifest on screen.
   */
  gracePeriodSeconds = 5,
) {
  return {
    metadata: {
      name,
      namespace: "default",
      labels: { app: "edge-api", release },
      deletionTimestamp: terminating ? new Date("2026-07-10T00:00:05Z") : undefined,
    },
    spec: {
      nodeName: release === "old" ? "node-1" : "node-2",
      terminationGracePeriodSeconds: gracePeriodSeconds,
      containers: [
        {
          name: "api",
          image: "registry.example/edge-api:2.4.0",
          ports: [{ name: "http", containerPort: 8080 }],
        },
      ],
    },
    status: {
      phase: "Running",
      podIP,
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "api",
          image: "registry.example/edge-api:2.4.0",
          imageID: "scripted://edge-api-2.4.0",
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: new Date("2026-07-10T00:00:00Z") } },
        },
      ],
    },
  };
}

function scriptedReplicaSet(name: string, release: string, replicas: number) {
  return {
    metadata: { name, namespace: "default", labels: { app: "edge-api", release } },
    spec: {
      replicas,
      selector: { matchLabels: { app: "edge-api", release } },
      template: { metadata: { labels: { app: "edge-api", release } } },
    },
    status: { replicas, readyReplicas: replicas, availableReplicas: replicas },
  };
}

function objectAt(value: unknown, path: string): Record<string, unknown> | undefined {
  const result = path ? valueAt(value, path) : value;
  return typeof result === "object" && result !== null
    ? (result as Record<string, unknown>)
    : undefined;
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function scriptedLog(pod: string, container: string, message: string): LogLine {
  return {
    namespace: "default",
    pod,
    container,
    message,
    timestampMs: Date.parse("2026-07-10T00:00:00Z"),
  };
}
