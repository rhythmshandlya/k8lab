/**
 * Domain model for klab content: problem levels, playground templates, and docs
 * lessons. These types are the contract between static content (`src/content`) and
 * the runtime. Every static entry is validated at load time by the matching Zod
 * schema in `./schemas.ts`, so the runtime can trust these shapes.
 *
 * Kept intentionally free of any Webernetes/runtime imports: pure data.
 */

export type Difficulty = "beginner" | "intermediate" | "advanced" | "architect";
export type Severity = "low" | "medium" | "high" | "critical";

/** Concept tags used to cross-link levels ⇄ docs ⇄ templates. */
export type KubernetesConcept =
  | "pods"
  | "deployments"
  | "replicasets"
  | "statefulsets"
  | "daemonsets"
  | "jobs"
  | "cronjobs"
  | "services"
  | "ingress"
  | "gateway-api"
  | "endpoints"
  | "endpointslices"
  | "labels-selectors"
  | "annotations"
  | "owners-gc"
  | "readiness-probes"
  | "liveness-probes"
  | "startup-probes"
  | "init-containers"
  | "sidecar-containers"
  | "lifecycle-hooks"
  | "dns"
  | "namespaces"
  | "rollouts"
  | "disruptions"
  | "events"
  | "logs"
  | "resources"
  | "resource-quotas"
  | "limit-ranges"
  | "configmaps"
  | "secrets"
  | "storage"
  | "service-accounts"
  | "rbac"
  | "security-contexts"
  | "network-policies"
  | "scheduling"
  | "autoscaling"
  | "object-management"
  | "kustomize"
  | "crds"
  | "operators"
  | "admission-controllers"
  | "reconciliation"
  | "networking"
  | "debugging";

export type EditableFileLanguage = "yaml" | "json" | "typescript" | "markdown";

/* ----------------------------- cluster fixtures ---------------------------- */

/**
 * A declarative cluster for incidents the browser control plane cannot execute.
 *
 * The alternative — one shared "manifest assessment" workload reused by every static
 * level — meant the story said "checkout has three replicas pinned to zone-a in
 * namespace payments" while the terminal, topology, explorer, and events all showed
 * the same anonymous placeholder in `default`. Every investigation surface contradicted
 * the brief, so the only workable strategy was to ignore the cluster and edit YAML.
 *
 * A fixture is data: the pods, nodes, events, and logs this incident would actually
 * produce, in the namespace the brief names, before and after the fix.
 */
export interface FixtureNode {
  name: string;
  labels?: Record<string, string>;
}

export interface FixtureContainer {
  name: string;
  image: string;
  /** Runtime-resolved image identity, which can differ between Pods that show the same tag. */
  imageID?: string;
  /** Container port and its name, when the workload serves traffic. */
  port?: { name: string; containerPort: number };
  ready?: boolean;
  restartCount?: number;
  /** Non-running container state, e.g. `CrashLoopBackOff`. */
  waitingReason?: string;
  /** Reason from the previous terminated container attempt, e.g. `OOMKilled`. */
  lastTerminationReason?: string;
}

export interface FixturePod {
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  priorityClassName?: string;
  priority?: number;
  nodeName?: string;
  podIP?: string;
  phase?: "Pending" | "Running" | "Succeeded" | "Failed";
  ready?: boolean;
  containers: FixtureContainer[];
  terminationGracePeriodSeconds?: number;
  /** Log lines this Pod has emitted, newest last. */
  logs?: { container?: string; message: string }[];
}

export interface FixtureService {
  name: string;
  namespace?: string;
  clusterIP: string;
  selector: Record<string, string>;
  ports: { name: string; port: number; targetPort: number | string }[];
  annotations?: Record<string, string>;
  type?: "ClusterIP" | "NodePort" | "LoadBalancer";
  externalTrafficPolicy?: "Cluster" | "Local";
  /** Headless bootstrap Services may deliberately publish endpoints before readiness. */
  publishNotReadyAddresses?: boolean;
}

export interface FixtureWorkload {
  name: string;
  replicas: number;
  selector: Record<string, string>;
}

export interface FixtureEvent {
  reason: string;
  message: string;
  type?: "Normal" | "Warning";
  involvedObject?: { kind: string; name: string };
}

export interface FixtureEndpoint {
  /** Service name the probe targets. */
  service: string;
  status: number;
  body: string;
  reason?: string;
}

/**
 * An unstructured Kubernetes object exposed by a fixture-backed incident.
 *
 * Fixtures use this for APIs the browser control plane does not reconcile (CRDs,
 * StorageClasses, admission webhooks, operator resources, and similar objects). It
 * keeps the terminal and object explorer truthful without pretending every submitted
 * object is a Deployment.
 */
export interface FixtureResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One observable state of the incident's cluster. */
export interface ClusterFixture {
  namespace: string;
  /** Authored Kubernetes objects visible through get/describe and the explorer. */
  resources?: FixtureResource[];
  nodes?: FixtureNode[];
  workloads?: FixtureWorkload[];
  pods: FixturePod[];
  services?: FixtureService[];
  events?: FixtureEvent[];
  endpoints?: FixtureEndpoint[];
}

/** The two states a repair level moves between. */
export interface LevelFixture {
  broken: ClusterFixture;
  healthy: ClusterFixture;
}

export interface EditableFile {
  path: string;
  language: EditableFileLanguage;
  initialValue: string;
}

export type ProblemFileAccess = "editable" | "readonly" | "hidden";

/** A scenario file and its complete workspace/runtime behavior. */
export interface ProblemFile extends EditableFile {
  access: ProblemFileAccess;
  /** Apply this manifest while constructing/resetting the incident state. */
  applyAtBoot: boolean;
}

export interface ManifestResourceSelector {
  kind: string;
  name: string;
  namespace?: string;
}

export type ManifestAssertion =
  | { path: string; operator: "present" }
  | { path: string; operator: "absent" }
  | { path: string; operator: "empty-object" }
  | { path: string; operator: "base64" }
  | { path: string; operator: "length-equals"; value: number }
  | {
      path: string;
      operator:
        | "equals"
        | "not-equals"
        | "gte"
        | "lte"
        | "matches"
        | "not-matches"
        | "array-contains"
        | "array-not-contains";
      value: string | number | boolean;
    };

/**
 * A named production outcome, graded by intent rather than by field position. Any
 * Kubernetes expression that genuinely achieves the outcome is accepted, so a learner
 * who reaches for `podAntiAffinity` instead of `topologySpreadConstraints` passes.
 * Use a `ManifestAssertion` only where the requirement really is exact (a digest, a
 * named Secret, an API version); use a goal for everything the incident is about.
 */
export type GoalCheck =
  | { goal: "spreads-across-topology"; topologyKey: string; maxSkew?: number }
  | { goal: "graceful-drain"; container: string; minGraceSeconds: number; minDrainSeconds?: number }
  | { goal: "zero-downtime-rollout"; maxSurge?: number }
  | { goal: "rollout-fits-capacity"; schedulableReplicas: number }
  | { goal: "external-traffic-routes-cluster-wide" }
  | {
      goal: "disruption-budget-window";
      replicas: number;
      minimumAvailable: number;
      minimumDisruptions: number;
    }
  | {
      goal: "service-targets-serving-port";
      servicePort: number;
      servingPort: number;
      servingPortName?: string;
    }
  | {
      goal: "connects-to-service";
      container: string;
      env: string;
      service: string;
      namespace: string;
      port: number;
      path: string;
    }
  | {
      goal: "startup-probe-covers-warmup";
      container: string;
      servingPort: number;
      httpPath: string;
      minBudgetSeconds: number;
    }
  | {
      goal: "probe-targets-serving-port";
      container: string;
      servingPort: number;
      probe: "readinessProbe" | "livenessProbe" | "startupProbe";
    }
  | { goal: "pulls-with-credentials"; secret: string; serviceAccount?: string };

/** A hard rule that is both displayed and evaluated during every validation. */
export type LevelConstraint = {
  id: string;
  label: string;
} & (
  | { kind: "editable-files"; paths: string[] }
  | {
      kind: "manifest";
      file: string;
      resource: ManifestResourceSelector;
      /** Reject extra documents smuggled into a single-resource learner file. */
      exclusive: boolean;
      assertions: ManifestAssertion[];
      /** Outcome-level requirements, checked alongside the exact assertions. */
      goals?: GoalCheck[];
    }
);

export interface QuickCommandTarget {
  kind: "pod";
  namespace: string;
  selector: Record<string, string>;
  prefer: "not-ready" | "highest-restarts" | "first";
}

export interface QuickCommand {
  id: string;
  command: string;
  target?: QuickCommandTarget;
}

export type ProblemEngineSpec =
  | { kind: "webernetes" }
  | { kind: "scripted"; scenarioId: string }
  /**
   * A declarative cluster for incidents the browser control plane cannot execute
   * (scheduling, CNI, storage, admission, control-plane failures). The fixture is
   * this level's own workload in its own namespace, so every investigation surface
   * agrees with the incident brief instead of showing a shared placeholder.
   */
  | { kind: "fixture"; fixture: LevelFixture };

export type ProblemPublicationStatus = "draft" | "review" | "published";

export type ProblemLearningPath =
  | "kubernetes-foundations"
  | "application-debugging"
  | "networking"
  | "reliability"
  | "sre-on-call"
  | "platform-architect";

export type ProblemChallengeMode = "repair" | "build";

export type ProblemCapability =
  | "pods"
  | "services"
  | "deployments"
  | "replicasets"
  | "namespaces"
  | "nodes"
  | "events"
  | "logs"
  | "http-probes"
  | "dns"
  | "rollouts"
  | "image-pulls"
  | "container-restarts"
  | "container-lifecycle"
  | "multi-container"
  | "configmaps"
  | "secrets"
  | "workload-controllers"
  | "network-policy"
  | "scheduling";

export interface KubernetesVersionRange {
  min: string;
  max: string;
  tested: string;
}

export interface IncidentSource {
  title: string;
  href: string;
  attribution: "inspired-by";
  adaptationNote: string;
}

export type ProblemBootWait =
  | {
      kind: "pods-ready";
      namespace: string;
      selector: Record<string, string>;
      minReady: number;
      timeoutMs: number;
    }
  | {
      kind: "pod-image-present";
      namespace: string;
      image: string;
      minCount: number;
      timeoutMs: number;
    };

export interface ProblemBootStep {
  id: string;
  filePaths: string[];
  waitFor?: ProblemBootWait;
}

export type EvidenceRuleId = string;

export type EvidenceSource =
  "terminal" | "logs" | "events" | "network" | "topology" | "object-explorer" | "validator";

/** A fact the learner can surface through investigation. Starts uncollected. */
export interface EvidenceItem {
  id: string;
  label: string;
  collected: boolean;
  source: EvidenceSource;
  timestamp?: string;
}

/**
 * Declarative trigger that marks an evidence item collected. Matched against
 * `InvestigationSignal`s emitted by the terminal/probe/explorer (see
 * `lib/kube/evidence.ts`). Discriminated on `type` for exhaustive handling.
 */
export type EvidenceTrigger =
  | { type: "command"; commandMatches: string; outputMatches?: string }
  | {
      type: "probe";
      hostMatches: string;
      pathMatches: string;
      status: number;
      bodyMatches?: string;
    }
  | { type: "event-reason"; reason: string; messageMatches?: string }
  | { type: "log"; messageMatches: string; podMatches?: string; namespace?: string }
  | { type: "object-view"; kind: string; nameMatches: string; namespace?: string }
  | { type: "topology-view"; kind: string; nameMatches: string; namespace?: string }
  | { type: "validator"; validatorId: string; passed: boolean };

export interface EvidenceRule {
  id: EvidenceRuleId;
  evidenceId: string;
  label: string;
  /**
   * Neutral description of the investigative act (e.g. "Service endpoints inspected"),
   * shown on the evidence board BEFORE the item is collected. Describes what to look
   * at without revealing what will be found. Falls back to a generic placeholder.
   */
  hiddenLabel?: string;
  source: EvidenceSource;
  trigger: EvidenceTrigger;
}

export interface Hint {
  id: string;
  title: string;
  body: string;
  xpPenalty: number;
  /** Locked until these evidence rules have fired (progressive disclosure). */
  unlockAfter?: EvidenceRuleId[];
}

/** Metadata describing a fake image a level expects to be registered. */
export interface SimulatedImageDefinition {
  ref: string;
  description: string;
}

/**
 * Hidden validator run against real cluster behavior (not YAML text). Discriminated
 * on `kind`. Shared fields (`id`, `title`, `successLabel`, `failureLabel`) plus the
 * per-kind parameters.
 */
export type LevelValidatorDefinition = {
  id: string;
  title: string;
  successLabel: string;
  failureLabel: string;
} & ValidatorCheck;

export type ValidatorCheck =
  | {
      kind: "deployment-ready";
      namespace: string;
      name: string;
      minReadyReplicas: number;
    }
  | {
      kind: "service-has-ready-endpoints";
      namespace: string;
      name: string;
      minReadyEndpoints: number;
    }
  | {
      kind: "http-get-through-service";
      namespace: string;
      service: string;
      port: number;
      path: string;
      expectStatus: number;
    }
  | {
      kind: "http-sample-through-service";
      namespace: string;
      service: string;
      port: number;
      path: string;
      expectStatus: number;
      samples: number;
      maxFailures: number;
    }
  | {
      /** No Running pod in the namespace is currently failing its readiness probe. */
      kind: "no-pods-failing-readiness";
      namespace: string;
    }
  | {
      /** No current Warning event remains in the namespace. */
      kind: "no-warning-events";
      namespace: string;
    }
  | {
      kind: "pod-ready-by-selector";
      namespace: string;
      selector: Record<string, string>;
      minReady: number;
    }
  | {
      /** At least one pod matches AND no matching pod has restarted more than maxRestarts times. */
      kind: "pod-restarts-below";
      namespace: string;
      selector: Record<string, string>;
      maxRestarts: number;
    }
  | {
      /** Passes when ZERO pods match the selector (e.g. a zombie workload was retired). */
      kind: "no-pods-matching";
      namespace: string;
      selector: Record<string, string>;
    };

export type ValidatorKind = ValidatorCheck["kind"];

/**
 * Level-specific production rules the shared cross-resource evaluator applies.
 *
 * These used to live in the evaluator as `slug === "..."` branches, which meant a
 * shared module had to grow a new special case for every level and no reviewer could
 * see a level's real acceptance rules by reading the level. Each entry here is a
 * parameterized, reusable check: the evaluator knows about kinds of policy, never
 * about individual problems.
 */
export interface WorkspaceSemanticPolicy {
  /**
   * Pods must stay out of host namespaces and carry a non-root, seccomp-confined
   * security context. Used by levels whose whole point is workload hardening.
   */
  podSecurity?: "hardened";
  /**
   * Per-PodDisruptionBudget survivability floors, keyed by budget name. `baseline` is
   * the workload's replica count, used to resolve percentage bounds.
   */
  disruptionBudgets?: Record<string, { baseline: number; minimumAvailable: number }>;
  /** Every rule in a matching Role/ClusterRole must match one of the allowed shapes. */
  rbacContracts?: RbacContract[];
  /** Exact contracts for named pipeline Tasks, by Task name. */
  taskContracts?: TaskContract[];
  /** The ordered, digest-pinned promotion pipeline a supply-chain level requires. */
  pipelineContract?: PipelineContract;
  /** Exact image-variable and CEL validation contract for one signature admission policy. */
  signaturePolicyContract?: SignaturePolicyContract;
  /** Exact least-connectivity contracts for named NetworkPolicies. */
  networkPolicyContracts?: NetworkPolicyContract[];
  /** Quantity-aware per-container ceilings for authored resource requests and limits. */
  resourceBudgets?: ContainerResourceBudget[];
}

/**
 * A resource ceiling for one named container. Workload containers are found from the
 * Pod template by default. Operators that expose their managed container's resources
 * directly (for example Prometheus) can declare `resourcesPath` instead.
 */
export interface ContainerResourceBudget {
  kind: string;
  name: string;
  namespace?: string;
  container: string;
  resourcesPath?: string;
  maxRequestCpu?: string;
  maxRequestMemory?: string;
  maxLimitCpu?: string;
  maxLimitMemory?: string;
}

export interface NetworkPolicyTraffic {
  /** Destination/source Pod identity. Omit when the peer is namespace-only. */
  podSelector?: Record<string, string>;
  /** Destination/source namespace identity. Omit for a same-namespace peer. */
  namespaceSelector?: Record<string, string>;
  /** One permitted protocol/port pair. */
  port: { protocol: "TCP" | "UDP" | "SCTP"; port: number | string };
}

/**
 * Exact traffic graph for one NetworkPolicy. Rules are normalized into peer/port
 * tuples, so harmless rule ordering and grouping do not affect acceptance while an
 * extra peer or port cannot silently broaden the graph.
 */
export interface NetworkPolicyContract {
  name: string;
  namespace?: string;
  podSelector: Record<string, string>;
  policyTypes: ("Ingress" | "Egress")[];
  ingress?: NetworkPolicyTraffic[];
  egress?: NetworkPolicyTraffic[];
}

export interface RbacContract {
  appliesTo: "Role" | "ClusterRole";
  /** Sentence fragment completing "Role/<name> …". */
  violation: string;
  /** Reject when the authored rule count differs (a contract with exactly N rules). */
  exactRuleCount?: number;
  allowedRules: {
    apiGroups: string[];
    resources: string[];
    verbs: string[];
    resourceNames?: string[];
  }[];
}

export interface TaskContract {
  task: string;
  stepCount: number;
  image: string;
  /** Exact argument set, order-insensitive. */
  args?: string[];
  /** Fragments the step script must contain. */
  scriptIncludes?: string[];
  /** Sentence fragment completing "Task/<name> …". */
  violation: string;
}

export interface PipelineContract {
  /** Pipeline param that carries the immutable artifact identity. */
  digestParam: string;
  /** The image reference every task must be given, usually built from `digestParam`. */
  pinnedImage: string;
  /** Tasks in required run order; each must `runAfter` the previous one. */
  tasks: { name: string; taskRef: string }[];
  /** Sentence fragment completing "Pipeline/<name> …". */
  violation: string;
}

/**
 * Exact CEL surface for a named ImageValidatingPolicy. Expression order is ignored,
 * but extra variables or validations are rejected so a policy cannot quietly omit an
 * image source or add a bypassing alternative while retaining the expected snippets.
 */
export interface SignaturePolicyContract {
  name: string;
  imageVariable: { name: string; expression: string };
  validations: string[];
  /** Sentence fragment completing `ImageValidatingPolicy/<name> ...`. */
  violation: string;
}

/**
 * A level has four separable concerns, and confusing them is what let the catalog
 * drift: a level could look complete while its scenario contradicted its story, or
 * while its grading rules had nothing to do with its pedagogy. They are declared as
 * facets rather than nested objects so authored levels stay flat and readable, while
 * every consumer can name the slice it actually depends on.
 */

/** Who this level is for and where it sits in the curriculum. Powers the catalog. */
export interface LevelIdentity {
  id: string;
  slug: string;
  contentVersion: number;
  publicationStatus: ProblemPublicationStatus;
  challengeMode: ProblemChallengeMode;
  title: string;
  difficulty: Difficulty;
  severity: Severity;
  xp: number;
  /** Author-estimated time to solve, shown in the catalog. */
  estimatedMinutes: number;
  /** Author-estimated solve rate (0 to 100), shown in the catalog. */
  successRate: number;
  concepts: KubernetesConcept[];
  /** One-line teaser for lists/tables (story is the full in-level briefing). */
  blurb: string;
  story: string;
  objective: string;
  learningObjectives: string[];
  prerequisites: string[];
  learningPaths: ProblemLearningPath[];
  capabilities: ProblemCapability[];
  kubernetesVersion: KubernetesVersionRange;
  incidentSource?: IncidentSource;
}

/** The cluster the learner works in, and the surfaces they investigate it through. */
export interface LevelScenario {
  engine: ProblemEngineSpec;
  files: ProblemFile[];
  /** Ordered incident construction; omitted when all applyAtBoot files form one step. */
  bootSequence?: ProblemBootStep[];
  quickCommands: QuickCommand[];
  /** Real-cluster diagnostic commands shown as a runbook reference, not executed by the simulator. */
  referenceCommands?: string[];
  /** Preset URLs for the network-probe panel (level-specific service names). */
  probeTargets: string[];
}

/** What counts as solved: the manifest rubric, cross-resource rules, and live checks. */
export interface LevelGrading {
  constraints: LevelConstraint[];
  /** Cross-resource acceptance rules beyond the per-manifest constraint rubric. */
  semanticPolicy?: WorkspaceSemanticPolicy;
  validators: LevelValidatorDefinition[];
}

/** What the level teaches, and how much help it gives on the way there. */
export interface LevelPedagogy {
  hints: Hint[];
  evidenceRules: EvidenceRule[];
  postSolveExplanation: PostSolveExplanation;
}

export interface ProblemLevel extends LevelIdentity, LevelScenario, LevelGrading, LevelPedagogy {}

/** Structured post-solve teaching payload shown once validation passes. */
export interface PostSolveExplanation {
  rootCause: string;
  whyItFailed: string;
  whatFixedIt: string;
  prevention: string;
  relatedConcepts: KubernetesConcept[];
  docsHref?: string;
  recommendedNextSlugs: string[];
}

export interface PlaygroundTemplate {
  id: string;
  title: string;
  description: string;
  concepts: KubernetesConcept[];
  files: EditableFile[];
  initialManifests: string[];
  registeredImages: SimulatedImageDefinition[];
}

export interface InteractiveLab {
  id: string;
  title: string;
  prompt: string;
  files: EditableFile[];
  initialManifests: string[];
  registeredImages: SimulatedImageDefinition[];
  tryChanging?: string;
  tasks?: string[];
  commands?: string[];
  debrief?: string;
}

/**
 * A block of docs lesson content. A small typed vocabulary (instead of MDX) that the
 * renderer maps to components: keeps content Zod-validated and free of a build-time
 * MDX pipeline. `heading` blocks provide the anchors for the table of contents;
 * `lab` blocks embed an interactive lab by id.
 */
export type DocsBlock =
  | { type: "heading"; id: string; text: string }
  | { type: "paragraph"; text: string }
  | { type: "callout"; tone: "info" | "warning" | "key"; title?: string; text: string }
  | { type: "concept"; term: string; definition: string }
  | { type: "code"; language: EditableFileLanguage; code: string }
  | {
      type: "diagram";
      variant:
        | "control-loop"
        | "cluster-architecture"
        | "api-object"
        | "pod"
        | "workload-hierarchy"
        | "service-routing"
        | "probe-gates"
        | "rollout"
        | "namespace-boundary"
        | "debug-loop";
      title?: string;
      caption?: string;
    }
  | {
      type: "demo";
      title: string;
      description: string;
      steps: { label: string; detail: string; command?: string; output?: string }[];
    }
  | {
      type: "quiz";
      id: string;
      question: string;
      options: { id: string; text: string; correct: boolean; explanation: string }[];
    }
  | { type: "steps"; title?: string; items: { title: string; text: string }[] }
  | { type: "takeaways"; items: string[] }
  | {
      type: "compare";
      caption?: string;
      left: { title: string; code: string };
      right: { title: string; code: string };
    }
  | {
      type: "annotatedCode";
      language: EditableFileLanguage;
      title?: string;
      caption?: string;
      lines: { code: string; note?: string }[];
    }
  | {
      type: "buildUp";
      language: EditableFileLanguage;
      title?: string;
      stages: { label: string; note: string; code: string }[];
    }
  | {
      type: "spotTheBug";
      language: EditableFileLanguage;
      title?: string;
      prompt: string;
      code: string;
      answer: string;
    }
  | {
      type: "challenge";
      language: EditableFileLanguage;
      title?: string;
      prompt: string;
      hint?: string;
      solution: string;
    }
  | {
      type: "decisionTable";
      title?: string;
      columns: string[];
      rows: { label: string; cells: string[] }[];
    }
  | { type: "lab"; labId: string }
  /** Embedded hands-on mission: a goal-checked workspace card, keyed by joined mission slug. */
  | { type: "mission"; missionSlug: string };

export interface DocsLesson {
  slug: string[];
  title: string;
  description: string;
  section: string;
  order: number;
  concepts: KubernetesConcept[];
  relatedLevelSlug?: string;
  sources?: { title: string; href: string }[];
  content: DocsBlock[];
  labs: InteractiveLab[];
}
