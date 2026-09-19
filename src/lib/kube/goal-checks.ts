import type { GoalCheck } from "@/lib/domain/types";
import { assertNever } from "@/lib/utils/exhaustive";

/**
 * Goal checks grade *intent*, where the path rubric grades transcription.
 *
 * A path assertion says "spec.template.spec.topologySpreadConstraints[…].maxSkew must
 * equal 1". That rejects `podAntiAffinity`, which spreads replicas across zones just
 * as well and is what plenty of production clusters actually use. The learner
 * understood the incident and still failed the level.
 *
 * A goal check asks the question the incident actually poses ("do these replicas
 * survive losing one zone?") and accepts any Kubernetes expression that answers it.
 * Path assertions remain available, and remain right, for requirements that genuinely
 * are exact: a specific image digest, a named Secret, an API version.
 *
 * Every check reports in the learner's language and never names a field to set, so a
 * goal's failure text is safe to show on the free surface.
 */

export interface GoalResult {
  passed: boolean;
  /** Observational, safe before submission: what the design does not yet achieve. */
  summary: string;
  /** Which expressions of the intent were looked for. Post-submission only. */
  diagnostic: string;
}

export function evaluateGoal(goal: GoalCheck, resource: Record<string, unknown>): GoalResult {
  switch (goal.goal) {
    case "spreads-across-topology":
      return spreadsAcrossTopology(goal, resource);
    case "graceful-drain":
      return gracefulDrain(goal, resource);
    case "zero-downtime-rollout":
      return zeroDowntimeRollout(goal, resource);
    case "rollout-fits-capacity":
      return rolloutFitsCapacity(goal, resource);
    case "external-traffic-routes-cluster-wide":
      return externalTrafficRoutesClusterWide(resource);
    case "disruption-budget-window":
      return disruptionBudgetWindow(goal, resource);
    case "service-targets-serving-port":
      return serviceTargetsServingPort(goal, resource);
    case "connects-to-service":
      return connectsToService(goal, resource);
    case "startup-probe-covers-warmup":
      return startupProbeCoversWarmup(goal, resource);
    case "probe-targets-serving-port":
      return probeTargetsServingPort(goal, resource);
    case "pulls-with-credentials":
      return pullsWithCredentials(goal, resource);
    default:
      return assertNever(goal);
  }
}

/** A Service can forward an external request to a ready endpoint on any node. */
function externalTrafficRoutesClusterWide(resource: Record<string, unknown>): GoalResult {
  const policy = objectValue(resource.spec)?.externalTrafficPolicy ?? "Cluster";
  return {
    passed: policy === "Cluster",
    summary: "external traffic is still restricted to endpoints on the receiving node",
    diagnostic: [
      "Looked for external traffic to use cluster-wide endpoint forwarding.",
      "Kubernetes defaults externalTrafficPolicy to Cluster when the field is omitted.",
      `Found: externalTrafficPolicy=${String(policy)}`,
    ].join("\n"),
  };
}

/** A PDB preserves its quorum while still allowing maintenance to make progress. */
function disruptionBudgetWindow(
  goal: Extract<GoalCheck, { goal: "disruption-budget-window" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const spec = objectValue(resource.spec);
  const rawMinimum = spec?.minAvailable;
  const rawMaximumUnavailable = spec?.maxUnavailable;
  const hasExactlyOneBound = (rawMinimum === undefined) !== (rawMaximumUnavailable === undefined);
  const resolvedMinimum =
    rawMinimum === undefined ? undefined : resolveReplicaBound(rawMinimum, goal.replicas, "up");
  const resolvedMaximumUnavailable =
    rawMaximumUnavailable === undefined
      ? undefined
      : resolveReplicaBound(rawMaximumUnavailable, goal.replicas, "up");
  const availableFloor =
    resolvedMinimum ??
    (resolvedMaximumUnavailable === undefined
      ? undefined
      : goal.replicas - resolvedMaximumUnavailable);
  const allowedDisruptions =
    availableFloor === undefined ? undefined : goal.replicas - availableFloor;
  const passed =
    hasExactlyOneBound &&
    availableFloor !== undefined &&
    allowedDisruptions !== undefined &&
    availableFloor >= goal.minimumAvailable &&
    allowedDisruptions >= goal.minimumDisruptions;

  return {
    passed,
    summary: "the disruption budget does not preserve service and permit maintenance together",
    diagnostic: [
      `Evaluated the budget against ${goal.replicas} replicas.`,
      `It must preserve at least ${goal.minimumAvailable} while permitting at least ${goal.minimumDisruptions} voluntary disruption.`,
      `Found: availableFloor=${availableFloor ?? "unresolved"}, allowedDisruptions=${allowedDisruptions ?? "unresolved"}`,
    ].join("\n"),
  };
}

/** A Service port resolves to the process's real numeric or named container port. */
function serviceTargetsServingPort(
  goal: Extract<GoalCheck, { goal: "service-targets-serving-port" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const servicePort = arrayAt(objectValue(resource.spec), "ports")
    .map(objectValue)
    .find((port) => port?.port === goal.servicePort);
  const target = servicePort?.targetPort ?? servicePort?.port;
  const passed =
    target === goal.servingPort ||
    (goal.servingPortName !== undefined && target === goal.servingPortName);
  return {
    passed,
    summary: "the Service still forwards traffic to a port where the workload is not serving",
    diagnostic: [
      `Looked for Service port ${goal.servicePort} to target the workload's serving port.`,
      `Accepted numeric target ${goal.servingPort}${
        goal.servingPortName ? ` or named target ${goal.servingPortName}` : ""
      }.`,
      `Found: targetPort=${String(target ?? "missing")}`,
    ].join("\n"),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Replicas survive the loss of one failure domain. Kubernetes offers two honest ways
 * to say this, and a third (`preferred` anti-affinity) that only asks nicely and so
 * does not count.
 */
function spreadsAcrossTopology(
  goal: Extract<GoalCheck, { goal: "spreads-across-topology" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const maxSkew = goal.maxSkew ?? 1;
  const podLabels = stringRecord(
    objectValue(objectValue(objectValue(resource.spec)?.template)?.metadata)?.labels,
  );

  const viaSpread = arrayAt(podSpec, "topologySpreadConstraints").some((entry) => {
    const constraint = objectValue(entry);
    return (
      constraint?.topologyKey === goal.topologyKey &&
      typeof constraint.maxSkew === "number" &&
      constraint.maxSkew <= maxSkew &&
      constraint.whenUnsatisfiable === "DoNotSchedule" &&
      selectorMatchesLabels(constraint.labelSelector, podLabels)
    );
  });

  const viaAntiAffinity = arrayAt(
    objectValue(objectValue(podSpec?.affinity)?.podAntiAffinity),
    "requiredDuringSchedulingIgnoredDuringExecution",
  ).some((entry) => {
    const term = objectValue(entry);
    return (
      term?.topologyKey === goal.topologyKey && selectorMatchesLabels(term.labelSelector, podLabels)
    );
  });

  return {
    passed: viaSpread || viaAntiAffinity,
    summary: `replicas are not yet guaranteed to spread across ${goal.topologyKey}`,
    diagnostic: [
      `Looked for a hard spread across ${goal.topologyKey}, satisfied by either:`,
      `  - a topologySpreadConstraint with maxSkew <= ${maxSkew} and whenUnsatisfiable: DoNotSchedule`,
      `  - a required podAntiAffinity on the same topologyKey`,
      `Found: topologySpread=${viaSpread}, requiredAntiAffinity=${viaAntiAffinity}`,
    ].join("\n"),
  };
}

/**
 * This exercise's application keeps its listener alive with a bounded sleep during
 * endpoint propagation. Unknown hooks cannot prove that delay. HTTP handlers and
 * arbitrary commands need an explicit application behavior model before grading.
 */
function gracefulDrain(
  goal: Extract<GoalCheck, { goal: "graceful-drain" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const grace = Number(podSpec?.terminationGracePeriodSeconds ?? 30);
  const containers = arrayAt(podSpec, "containers")
    .map(objectValue)
    .filter((container) => container?.name === goal.container);
  const drains = containers.map((container) => {
    const preStop = objectValue(objectValue(container?.lifecycle)?.preStop);
    if (!preStop) return undefined;
    const command = arrayAt(preStop, "exec.command").map(String);
    const nativeSleep = objectValue(preStop.sleep)?.seconds;
    // This application has no drain endpoint. Only a bounded delay can keep its
    // listener alive during propagation. Never infer behavior from an unknown hook.
    const executable = command[0]?.replace(/^.*\//, "");
    const shellSleep =
      (executable === "sh" || executable === "bash") && command[1] === "-c" && command.length === 3
        ? parseSleepSeconds(command[2] ?? "")
        : undefined;
    const directSleep =
      executable === "sleep" && command.length === 2 && /^\d+(?:\.\d+)?$/.test(command[1] ?? "")
        ? Number(command[1])
        : undefined;
    return shellSleep ?? directSleep ?? (typeof nativeSleep === "number" ? nativeSleep : undefined);
  });

  const drain = drains.find((seconds) => seconds !== undefined);
  const passed =
    grace >= goal.minGraceSeconds &&
    drain !== undefined &&
    drain >= (goal.minDrainSeconds ?? 1) &&
    drain < grace;

  return {
    passed,
    summary:
      drain === undefined
        ? "the Pod still closes its listener the moment it is told to stop"
        : `the drain window does not fit inside the ${grace}s termination budget`,
    diagnostic: [
      `Looked for a preStop drain action plus a termination grace period of at least ${goal.minGraceSeconds}s,`,
      `on container ${goal.container}, with the drain finishing before the grace period expires.`,
      `Found: terminationGracePeriodSeconds=${grace}, preStopDrainSeconds=${drain ?? "none"}`,
    ].join("\n"),
  };
}

/** No replica is removed before a replacement is Ready, however that is expressed. */
function zeroDowntimeRollout(
  goal: Extract<GoalCheck, { goal: "zero-downtime-rollout" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const strategy = objectValue(objectValue(resource.spec)?.strategy);
  const type = strategy?.type ?? "RollingUpdate";
  const rollingUpdate = objectValue(strategy?.rollingUpdate);
  const maxUnavailable = rollingUpdate?.maxUnavailable;
  const maxSurge = rollingUpdate?.maxSurge;
  const replicas = Number(objectValue(resource.spec)?.replicas ?? 1);
  const unavailable = resolveReplicaBound(maxUnavailable ?? "25%", replicas, "down");
  const surge = resolveReplicaBound(maxSurge ?? "25%", replicas, "up");
  const surgeWithinLimit =
    surge !== undefined && surge >= 1 && (goal.maxSurge === undefined || surge <= goal.maxSurge);
  const passed = type === "RollingUpdate" && unavailable === 0 && surgeWithinLimit;

  return {
    passed,
    summary:
      type === "RollingUpdate" && unavailable === 0 && surge === 0
        ? "the rollout cannot create a replacement without first removing a serving replica"
        : type === "RollingUpdate" && unavailable === 0 && !surgeWithinLimit
          ? `the rollout surge exceeds the ${goal.maxSurge} temporary replica capacity`
          : type === "RollingUpdate"
            ? "the rollout may still remove a serving replica before its replacement is Ready"
            : "the rollout replaces every replica at once, leaving no serving capacity",
    diagnostic: [
      "Looked for a RollingUpdate strategy that never takes a serving replica away",
      `and can create at least one replacement to make progress${
        goal.maxSurge === undefined ? "." : ` without surging by more than ${goal.maxSurge}.`
      }`,
      `Found: strategy=${String(type)}, maxUnavailable=${String(maxUnavailable)} -> ${
        unavailable ?? "unresolved"
      } pods, maxSurge=${String(maxSurge)} -> ${surge ?? "unresolved"} pods of ${replicas}`,
    ].join("\n"),
  };
}

/** The rollout never asks the cluster for capacity it does not have. */
function rolloutFitsCapacity(
  goal: Extract<GoalCheck, { goal: "rollout-fits-capacity" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const spec = objectValue(resource.spec);
  const strategy = objectValue(spec?.strategy);
  const rollingUpdate = objectValue(strategy?.rollingUpdate);
  const replicas = Number(spec?.replicas ?? 1);
  const surge = resolveReplicaBound(rollingUpdate?.maxSurge ?? "25%", replicas, "up");
  const unavailable = resolveReplicaBound(rollingUpdate?.maxUnavailable ?? "25%", replicas, "down");
  const passed =
    (strategy?.type ?? "RollingUpdate") === "RollingUpdate" &&
    surge !== undefined &&
    unavailable !== undefined &&
    replicas + surge <= goal.schedulableReplicas &&
    unavailable >= 1;

  return {
    passed,
    summary: `the rollout can demand more replicas than the ${goal.schedulableReplicas} the cluster can schedule`,
    diagnostic: [
      `Looked for a RollingUpdate whose peak replica count stays within ${goal.schedulableReplicas},`,
      "which requires surrendering at least one replica during the roll.",
      `Found: replicas=${replicas}, maxSurge -> ${surge ?? "unresolved"}, maxUnavailable -> ${
        unavailable ?? "unresolved"
      }`,
    ].join("\n"),
  };
}

/** The configured dependency URL resolves to the intended in-cluster Service. */
function connectsToService(
  goal: Extract<GoalCheck, { goal: "connects-to-service" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const container = arrayAt(podSpec, "containers")
    .map(objectValue)
    .find((candidate) => candidate?.name === goal.container);
  const configured = arrayAt(container, "env")
    .map(objectValue)
    .find((entry) => entry?.name === goal.env)?.value;
  const resourceNamespace =
    typeof objectValue(resource.metadata)?.namespace === "string"
      ? String(objectValue(resource.metadata)?.namespace)
      : "default";
  const acceptedHosts = new Set([
    ...(resourceNamespace === goal.namespace ? [goal.service] : []),
    `${goal.service}.${goal.namespace}`,
    `${goal.service}.${goal.namespace}.svc`,
    `${goal.service}.${goal.namespace}.svc.cluster.local`,
  ]);

  let parsed: URL | undefined;
  if (typeof configured === "string") {
    try {
      parsed = new URL(configured);
    } catch {
      parsed = undefined;
    }
  }
  const hostname = parsed?.hostname.replace(/\.$/, "");
  const port = parsed?.port === "" ? defaultPort(parsed.protocol) : Number(parsed?.port);
  const passed =
    parsed?.protocol === "http:" &&
    hostname !== undefined &&
    acceptedHosts.has(hostname) &&
    port === goal.port &&
    parsed.pathname === goal.path &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "";

  return {
    passed,
    summary: "the workload still does not call the required in-cluster upstream",
    diagnostic: [
      `Looked for ${goal.env} on container ${goal.container} to call Service ${goal.namespace}/${goal.service}`,
      `over HTTP port ${goal.port} at ${goal.path}, using a valid Kubernetes Service DNS form.`,
      `Found: ${typeof configured === "string" ? configured : "not configured"}`,
    ].join("\n"),
  };
}

/** The startup gate checks the real listener and outlasts expected initialization. */
function startupProbeCoversWarmup(
  goal: Extract<GoalCheck, { goal: "startup-probe-covers-warmup" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const container = arrayAt(podSpec, "containers")
    .map(objectValue)
    .find((candidate) => candidate?.name === goal.container);
  const probe = objectValue(container?.startupProbe);
  const ports = arrayAt(container, "ports").map(objectValue);
  const httpGet = objectValue(probe?.httpGet);
  const tcpSocket = objectValue(probe?.tcpSocket);
  const handler = httpGet ?? tcpSocket;
  const target = handler?.port;
  const resolvedPort =
    typeof target === "number"
      ? target
      : Number(ports.find((port) => port?.name === target)?.containerPort);
  const targetIsHealthy =
    resolvedPort === goal.servingPort &&
    ((httpGet !== undefined && httpGet.path === goal.httpPath) || tcpSocket !== undefined);
  const initialDelay = nonNegativeNumber(probe?.initialDelaySeconds, 0);
  const period = positiveNumber(probe?.periodSeconds, 10);
  const failures = positiveNumber(probe?.failureThreshold, 3);
  const budget = initialDelay + period * failures;
  const passed = targetIsHealthy && budget >= goal.minBudgetSeconds;

  return {
    passed,
    summary: targetIsHealthy
      ? `the startup gate can exhaust before the ${goal.minBudgetSeconds}s warm-up budget completes`
      : "the startup gate does not check the listener that becomes healthy after warm-up",
    diagnostic: [
      `Looked for a startup probe on container ${goal.container} that checks port ${goal.servingPort}`,
      `(HTTP ${goal.httpPath} or TCP) with at least ${goal.minBudgetSeconds}s before failure.`,
      `Found: handler=${httpGet ? "httpGet" : tcpSocket ? "tcpSocket" : "none"}, port=${String(
        target,
      )} -> ${Number.isFinite(resolvedPort) ? resolvedPort : "unresolved"}, budget=${budget}s`,
    ].join("\n"),
  };
}

/** The probe asks the port the container actually serves, by number or by name. */
function probeTargetsServingPort(
  goal: Extract<GoalCheck, { goal: "probe-targets-serving-port" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const container = arrayAt(podSpec, "containers")
    .map(objectValue)
    .find((candidate) => candidate?.name === goal.container);
  const ports = arrayAt(container, "ports").map(objectValue);
  const serving = ports.find((port) => Number(port?.containerPort) === goal.servingPort);
  const probe = objectValue(objectValue(container?.[goal.probe])?.httpGet);
  const target = probe?.port;
  const resolved =
    typeof target === "number"
      ? target
      : Number(ports.find((port) => port?.name === target)?.containerPort);

  return {
    passed: serving !== undefined && resolved === goal.servingPort,
    summary: `the ${goal.probe.replace("Probe", "")} probe does not check the port the container serves`,
    diagnostic: [
      `Looked for a ${goal.probe} httpGet resolving to container port ${goal.servingPort},`,
      "addressed either by number or by the declared port name.",
      `Found: probePort=${String(target)} -> ${Number.isFinite(resolved) ? resolved : "unresolved"}, declaredPorts=${
        ports.map((port) => `${String(port?.name)}:${String(port?.containerPort)}`).join(", ") ||
        "none"
      }`,
    ].join("\n"),
  };
}

/** The kubelet is given credentials for the private registry, by any supported route. */
function pullsWithCredentials(
  goal: Extract<GoalCheck, { goal: "pulls-with-credentials" }>,
  resource: Record<string, unknown>,
): GoalResult {
  const podSpec = podSpecOf(resource);
  const viaPod = arrayAt(podSpec, "imagePullSecrets").some(
    (entry) => objectValue(entry)?.name === goal.secret,
  );
  // A ServiceAccount carrying the pull secret is the other real-world route; the
  // workspace only shows the workload, so an explicit reference to one counts.
  const viaServiceAccount =
    goal.serviceAccount !== undefined &&
    (podSpec?.serviceAccountName === goal.serviceAccount ||
      podSpec?.serviceAccount === goal.serviceAccount);

  return {
    passed: viaPod || viaServiceAccount,
    summary: "the kubelet still has no credentials for the private registry",
    diagnostic: [
      `Looked for registry credentials reachable by the Pod: an imagePullSecrets entry naming ${goal.secret}`,
      goal.serviceAccount ? `, or the ${goal.serviceAccount} ServiceAccount that carries it.` : ".",
      `Found: imagePullSecrets=${viaPod}, serviceAccount=${viaServiceAccount}`,
    ].join(""),
  };
}

/* -------------------------------------------------------------------------- */

/** Pod template location differs by workload kind; CronJob nests one level deeper. */
function podSpecOf(resource: Record<string, unknown>): Record<string, unknown> | undefined {
  const spec = objectValue(resource.spec);
  if (resource.kind === "Pod") return spec;
  const cronTemplate = objectValue(objectValue(objectValue(spec?.jobTemplate)?.spec)?.template);
  if (cronTemplate) return objectValue(cronTemplate.spec);
  return objectValue(objectValue(spec?.template)?.spec);
}

/** Resolve an integer-or-percentage replica bound the way the controller does. */
function resolveReplicaBound(
  value: unknown,
  replicas: number,
  rounding: "up" | "down",
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const percent = /^(\d+)%$/.exec(value);
  if (percent) {
    const percentage = Number(percent[1]);
    if (percentage > 100) return undefined;
    const scaled = (percentage / 100) * replicas;
    return rounding === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  }
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function parseSleepSeconds(part: string): number | undefined {
  const match = /^\s*(?:\/bin\/)?sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(part);
  return match ? Number(match[1]) : undefined;
}

function defaultPort(protocol: string | undefined): number | undefined {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = objectValue(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Evaluate the label-selector subset needed by scheduling affinity/spread rules. */
function selectorMatchesLabels(value: unknown, labels: Record<string, string>): boolean {
  const selector = objectValue(value);
  if (!selector) return false;
  const matchLabels = stringRecord(selector.matchLabels);
  if (!Object.entries(matchLabels).every(([key, expected]) => labels[key] === expected)) {
    return false;
  }

  const expressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : [];
  return expressions.every((expressionValue) => {
    const expression = objectValue(expressionValue);
    const key = typeof expression?.key === "string" ? expression.key : undefined;
    const operator = expression?.operator;
    const values = Array.isArray(expression?.values)
      ? expression.values.filter((item): item is string => typeof item === "string")
      : [];
    if (!key) return false;
    if (operator === "In") return labels[key] !== undefined && values.includes(labels[key]);
    if (operator === "NotIn") return labels[key] !== undefined && !values.includes(labels[key]);
    if (operator === "Exists") return labels[key] !== undefined;
    if (operator === "DoesNotExist") return labels[key] === undefined;
    return false;
  });
}

function arrayAt(root: Record<string, unknown> | undefined, path: string): unknown[] {
  const value = path.split(".").reduce<unknown>((current, key) => {
    const record = objectValue(current);
    return record ? record[key] : undefined;
  }, root);
  return Array.isArray(value) ? value : [];
}
