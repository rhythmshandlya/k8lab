import { z } from "zod";

import type { DocsLesson, PlaygroundTemplate, ProblemLevel } from "./types";

/**
 * Zod schemas mirroring `./types.ts`. Static content is parsed through these so the
 * runtime can trust it. `z.infer` of each schema is checked to equal the hand-written
 * domain type via the `satisfies` assertions at the bottom, keeping the two in sync.
 */

export const difficultySchema = z.enum(["beginner", "intermediate", "advanced", "architect"]);
export const severitySchema = z.enum(["low", "medium", "high", "critical"]);

export const conceptSchema = z.enum([
  "pods",
  "deployments",
  "replicasets",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
  "services",
  "ingress",
  "gateway-api",
  "endpoints",
  "endpointslices",
  "labels-selectors",
  "annotations",
  "owners-gc",
  "readiness-probes",
  "liveness-probes",
  "startup-probes",
  "init-containers",
  "sidecar-containers",
  "lifecycle-hooks",
  "dns",
  "namespaces",
  "rollouts",
  "disruptions",
  "events",
  "logs",
  "resources",
  "resource-quotas",
  "limit-ranges",
  "configmaps",
  "secrets",
  "storage",
  "service-accounts",
  "rbac",
  "security-contexts",
  "network-policies",
  "scheduling",
  "autoscaling",
  "object-management",
  "kustomize",
  "crds",
  "operators",
  "admission-controllers",
  "reconciliation",
  "networking",
  "debugging",
]);

const fileLanguageSchema = z.enum(["yaml", "json", "typescript", "markdown"]);

export const editableFileSchema = z.object({
  path: z.string().min(1),
  language: fileLanguageSchema,
  initialValue: z.string(),
});

const problemFileSchema = editableFileSchema.extend({
  access: z.enum(["editable", "readonly", "hidden"]),
  applyAtBoot: z.boolean(),
});

const manifestValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const manifestAssertionSchema = z.discriminatedUnion("operator", [
  z.object({ path: z.string().min(1), operator: z.literal("present") }),
  z.object({ path: z.string().min(1), operator: z.literal("absent") }),
  z.object({ path: z.string().min(1), operator: z.literal("empty-object") }),
  z.object({ path: z.string().min(1), operator: z.literal("base64") }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("length-equals"),
    value: z.number().int().nonnegative(),
  }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("equals"),
    value: manifestValueSchema,
  }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("not-equals"),
    value: manifestValueSchema,
  }),
  z.object({ path: z.string().min(1), operator: z.literal("gte"), value: manifestValueSchema }),
  z.object({ path: z.string().min(1), operator: z.literal("lte"), value: manifestValueSchema }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("matches"),
    value: manifestValueSchema,
  }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("not-matches"),
    value: manifestValueSchema,
  }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("array-contains"),
    value: manifestValueSchema,
  }),
  z.object({
    path: z.string().min(1),
    operator: z.literal("array-not-contains"),
    value: manifestValueSchema,
  }),
]);

const constraintSharedSchema = {
  id: z.string().min(1),
  label: z.string().min(1),
};
const goalCheckSchema = z.discriminatedUnion("goal", [
  z.object({
    goal: z.literal("spreads-across-topology"),
    topologyKey: z.string().min(1),
    maxSkew: z.number().int().positive().optional(),
  }),
  z.object({
    goal: z.literal("graceful-drain"),
    container: z.string().min(1),
    minGraceSeconds: z.number().int().positive(),
    minDrainSeconds: z.number().positive().optional(),
  }),
  z.object({
    goal: z.literal("zero-downtime-rollout"),
    maxSurge: z.number().int().min(1).optional(),
  }),
  z.object({
    goal: z.literal("rollout-fits-capacity"),
    schedulableReplicas: z.number().int().positive(),
  }),
  z.object({ goal: z.literal("external-traffic-routes-cluster-wide") }),
  z.object({
    goal: z.literal("disruption-budget-window"),
    replicas: z.number().int().positive(),
    minimumAvailable: z.number().int().nonnegative(),
    minimumDisruptions: z.number().int().positive(),
  }),
  z.object({
    goal: z.literal("service-targets-serving-port"),
    servicePort: z.number().int().positive(),
    servingPort: z.number().int().positive(),
    servingPortName: z.string().min(1).optional(),
  }),
  z.object({
    goal: z.literal("connects-to-service"),
    container: z.string().min(1),
    env: z.string().min(1),
    service: z.string().min(1),
    namespace: z.string().min(1),
    port: z.number().int().positive(),
    path: z.string().startsWith("/"),
  }),
  z.object({
    goal: z.literal("startup-probe-covers-warmup"),
    container: z.string().min(1),
    servingPort: z.number().int().positive(),
    httpPath: z.string().startsWith("/"),
    minBudgetSeconds: z.number().positive(),
  }),
  z.object({
    goal: z.literal("probe-targets-serving-port"),
    container: z.string().min(1),
    servingPort: z.number().int().positive(),
    probe: z.enum(["readinessProbe", "livenessProbe", "startupProbe"]),
  }),
  z.object({
    goal: z.literal("pulls-with-credentials"),
    secret: z.string().min(1),
    serviceAccount: z.string().min(1).optional(),
  }),
]);

const constraintSchema = z.discriminatedUnion("kind", [
  z.object({
    ...constraintSharedSchema,
    kind: z.literal("editable-files"),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    ...constraintSharedSchema,
    kind: z.literal("manifest"),
    file: z.string().min(1),
    resource: z.object({
      kind: z.string().min(1),
      name: z.string().min(1),
      namespace: z.string().min(1).optional(),
    }),
    exclusive: z.boolean(),
    assertions: z.array(manifestAssertionSchema).min(1),
    goals: z.array(goalCheckSchema).min(1).optional(),
  }),
]);

const quickCommandSchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    target: z
      .object({
        kind: z.literal("pod"),
        namespace: z.string().min(1),
        selector: z.record(z.string(), z.string()),
        prefer: z.enum(["not-ready", "highest-restarts", "first"]),
      })
      .optional(),
  })
  .superRefine((quickCommand, ctx) => {
    if (quickCommand.command.includes("<pod>") && !quickCommand.target) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Commands containing <pod> require an explicit target selector.",
      });
    }
  });

const fixturePodSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()),
  priorityClassName: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  nodeName: z.string().min(1).optional(),
  podIP: z.string().min(1).optional(),
  phase: z.enum(["Pending", "Running", "Succeeded", "Failed"]).optional(),
  ready: z.boolean().optional(),
  containers: z
    .array(
      z.object({
        name: z.string().min(1),
        image: z.string().min(1),
        imageID: z.string().min(1).optional(),
        port: z.object({ name: z.string().min(1), containerPort: z.number().int() }).optional(),
        ready: z.boolean().optional(),
        restartCount: z.number().int().nonnegative().optional(),
        waitingReason: z.string().min(1).optional(),
        lastTerminationReason: z.string().min(1).optional(),
      }),
    )
    .min(1),
  terminationGracePeriodSeconds: z.number().int().nonnegative().optional(),
  logs: z
    .array(z.object({ container: z.string().min(1).optional(), message: z.string().min(1) }))
    .optional(),
});

const clusterFixtureSchema = z.object({
  namespace: z.string().min(1),
  resources: z
    .array(
      z
        .object({
          apiVersion: z.string().min(1),
          kind: z.string().min(1),
          metadata: z
            .object({
              name: z.string().min(1),
              namespace: z.string().min(1).optional(),
              labels: z.record(z.string(), z.string()).optional(),
            })
            .catchall(z.unknown()),
        })
        .catchall(z.unknown()),
    )
    .optional(),
  nodes: z
    .array(
      z.object({
        name: z.string().min(1),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  workloads: z
    .array(
      z.object({
        name: z.string().min(1),
        replicas: z.number().int().nonnegative(),
        selector: z.record(z.string(), z.string()),
      }),
    )
    .optional(),
  pods: z.array(fixturePodSchema),
  services: z
    .array(
      z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
        clusterIP: z.string().min(1),
        selector: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).optional(),
        type: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]).optional(),
        externalTrafficPolicy: z.enum(["Cluster", "Local"]).optional(),
        publishNotReadyAddresses: z.boolean().optional(),
        ports: z.array(
          z.object({
            name: z.string().min(1),
            port: z.number().int(),
            targetPort: z.union([z.number().int(), z.string().min(1)]),
          }),
        ),
      }),
    )
    .optional(),
  events: z
    .array(
      z.object({
        reason: z.string().min(1),
        message: z.string().min(1),
        type: z.enum(["Normal", "Warning"]).optional(),
        involvedObject: z.object({ kind: z.string().min(1), name: z.string().min(1) }).optional(),
      }),
    )
    .optional(),
  endpoints: z
    .array(
      z.object({
        service: z.string().min(1),
        status: z.number().int(),
        body: z.string(),
        reason: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

const problemEngineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("webernetes") }),
  z.object({ kind: z.literal("scripted"), scenarioId: z.string().min(1) }),
  z.object({
    kind: z.literal("fixture"),
    fixture: z.object({ broken: clusterFixtureSchema, healthy: clusterFixtureSchema }),
  }),
]);

const problemPublicationStatusSchema = z.enum(["draft", "review", "published"]);
const problemLearningPathSchema = z.enum([
  "kubernetes-foundations",
  "application-debugging",
  "networking",
  "reliability",
  "sre-on-call",
  "platform-architect",
]);
const problemChallengeModeSchema = z.enum(["repair", "build"]);
const problemCapabilitySchema = z.enum([
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
const kubernetesMinorSchema = z.string().regex(/^1\.\d{2}$/);
const kubernetesVersionRangeSchema = z.object({
  min: kubernetesMinorSchema,
  max: kubernetesMinorSchema,
  tested: kubernetesMinorSchema,
});
const incidentSourceSchema = z.object({
  title: z.string().min(1),
  href: z.string().url(),
  attribution: z.literal("inspired-by"),
  adaptationNote: z.string().min(1),
});

const problemBootWaitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pods-ready"),
    namespace: z.string().min(1),
    selector: z.record(z.string(), z.string()),
    minReady: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("pod-image-present"),
    namespace: z.string().min(1),
    image: z.string().min(1),
    minCount: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
]);

const problemBootStepSchema = z.object({
  id: z.string().min(1),
  filePaths: z.array(z.string().min(1)).min(1),
  waitFor: problemBootWaitSchema.optional(),
});

const evidenceSourceSchema = z.enum([
  "terminal",
  "logs",
  "events",
  "network",
  "topology",
  "object-explorer",
  "validator",
]);

const evidenceTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command"),
    commandMatches: z.string().min(1),
    outputMatches: z.string().optional(),
  }),
  z.object({
    type: z.literal("probe"),
    hostMatches: z.string().min(1),
    pathMatches: z.string().min(1),
    status: z.number().int(),
    bodyMatches: z.string().optional(),
  }),
  z.object({
    type: z.literal("event-reason"),
    reason: z.string().min(1),
    messageMatches: z.string().optional(),
  }),
  z.object({
    type: z.literal("log"),
    messageMatches: z.string().min(1),
    podMatches: z.string().optional(),
    namespace: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("object-view"),
    kind: z.string().min(1),
    nameMatches: z.string().min(1),
    namespace: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("topology-view"),
    kind: z.string().min(1),
    nameMatches: z.string().min(1),
    namespace: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("validator"),
    validatorId: z.string().min(1),
    passed: z.boolean(),
  }),
]);

const evidenceRuleSchema = z.object({
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  label: z.string().min(1),
  hiddenLabel: z.string().optional(),
  source: evidenceSourceSchema,
  trigger: evidenceTriggerSchema,
});

const hintSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  xpPenalty: z.number().int().nonnegative(),
  unlockAfter: z.array(z.string()).optional(),
});

const simulatedImageSchema = z.object({
  ref: z.string().min(1),
  description: z.string().min(1),
});

const validatorCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deployment-ready"),
    namespace: z.string().min(1),
    name: z.string().min(1),
    minReadyReplicas: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("service-has-ready-endpoints"),
    namespace: z.string().min(1),
    name: z.string().min(1),
    minReadyEndpoints: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("http-get-through-service"),
    namespace: z.string().min(1),
    service: z.string().min(1),
    port: z.number().int().positive(),
    path: z.string().min(1),
    expectStatus: z.number().int(),
  }),
  z.object({
    kind: z.literal("http-sample-through-service"),
    namespace: z.string().min(1),
    service: z.string().min(1),
    port: z.number().int().positive(),
    path: z.string().min(1),
    expectStatus: z.number().int(),
    samples: z.number().int().min(2).max(20),
    maxFailures: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("no-pods-failing-readiness"),
    namespace: z.string().min(1),
  }),
  z.object({
    kind: z.literal("no-warning-events"),
    namespace: z.string().min(1),
  }),
  z.object({
    kind: z.literal("pod-ready-by-selector"),
    namespace: z.string().min(1),
    selector: z.record(z.string(), z.string()),
    minReady: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("pod-restarts-below"),
    namespace: z.string().min(1),
    selector: z.record(z.string(), z.string()),
    maxRestarts: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("no-pods-matching"),
    namespace: z.string().min(1),
    selector: z.record(z.string(), z.string()),
  }),
]);

const validatorSharedSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  successLabel: z.string().min(1),
  failureLabel: z.string().min(1),
});

const levelValidatorSchema = z.intersection(validatorSharedSchema, validatorCheckSchema);

const postSolveSchema = z.object({
  rootCause: z.string().min(1),
  whyItFailed: z.string().min(1),
  whatFixedIt: z.string().min(1),
  prevention: z.string().min(1),
  relatedConcepts: z.array(conceptSchema),
  docsHref: z.string().optional(),
  recommendedNextSlugs: z.array(z.string().min(1)),
});

const semanticPolicySchema = z.object({
  podSecurity: z.literal("hardened").optional(),
  disruptionBudgets: z
    .record(
      z.string().min(1),
      z.object({
        baseline: z.number().int().positive(),
        minimumAvailable: z.number().int().positive(),
      }),
    )
    .optional(),
  rbacContracts: z
    .array(
      z.object({
        appliesTo: z.enum(["Role", "ClusterRole"]),
        violation: z.string().min(1),
        exactRuleCount: z.number().int().positive().optional(),
        allowedRules: z
          .array(
            z.object({
              apiGroups: z.array(z.string()),
              resources: z.array(z.string().min(1)),
              verbs: z.array(z.string().min(1)),
              resourceNames: z.array(z.string().min(1)).optional(),
            }),
          )
          .min(1),
      }),
    )
    .optional(),
  taskContracts: z
    .array(
      z.object({
        task: z.string().min(1),
        stepCount: z.number().int().positive(),
        image: z.string().min(1),
        args: z.array(z.string()).optional(),
        scriptIncludes: z.array(z.string().min(1)).optional(),
        violation: z.string().min(1),
      }),
    )
    .optional(),
  pipelineContract: z
    .object({
      digestParam: z.string().min(1),
      pinnedImage: z.string().min(1),
      tasks: z.array(z.object({ name: z.string().min(1), taskRef: z.string().min(1) })).min(2),
      violation: z.string().min(1),
    })
    .optional(),
  signaturePolicyContract: z
    .object({
      name: z.string().min(1),
      imageVariable: z.object({
        name: z.string().min(1),
        expression: z.string().min(1),
      }),
      validations: z.array(z.string().min(1)).min(1),
      violation: z.string().min(1),
    })
    .optional(),
  networkPolicyContracts: z
    .array(
      z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
        podSelector: z.record(z.string().min(1), z.string()),
        policyTypes: z.array(z.enum(["Ingress", "Egress"])).min(1),
        ingress: z
          .array(
            z.object({
              podSelector: z.record(z.string().min(1), z.string()).optional(),
              namespaceSelector: z.record(z.string().min(1), z.string()).optional(),
              port: z.object({
                protocol: z.enum(["TCP", "UDP", "SCTP"]),
                port: z.union([z.number().int().positive(), z.string().min(1)]),
              }),
            }),
          )
          .optional(),
        egress: z
          .array(
            z.object({
              podSelector: z.record(z.string().min(1), z.string()).optional(),
              namespaceSelector: z.record(z.string().min(1), z.string()).optional(),
              port: z.object({
                protocol: z.enum(["TCP", "UDP", "SCTP"]),
                port: z.union([z.number().int().positive(), z.string().min(1)]),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  resourceBudgets: z
    .array(
      z.object({
        kind: z.string().min(1),
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
        container: z.string().min(1),
        resourcesPath: z.string().min(1).optional(),
        maxRequestCpu: z.string().min(1).optional(),
        maxRequestMemory: z.string().min(1).optional(),
        maxLimitCpu: z.string().min(1).optional(),
        maxLimitMemory: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

export const problemLevelSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  contentVersion: z.number().int().positive(),
  publicationStatus: problemPublicationStatusSchema,
  challengeMode: problemChallengeModeSchema,
  title: z.string().min(1),
  difficulty: difficultySchema,
  severity: severitySchema,
  xp: z.number().int().positive(),
  estimatedMinutes: z.number().int().positive(),
  successRate: z.number().int().min(0).max(100),
  concepts: z.array(conceptSchema).min(1),
  blurb: z.string().min(1),
  story: z.string().min(1),
  objective: z.string().min(1),
  learningObjectives: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string().min(1)),
  learningPaths: z.array(problemLearningPathSchema).min(1),
  capabilities: z.array(problemCapabilitySchema).min(1),
  kubernetesVersion: kubernetesVersionRangeSchema,
  incidentSource: incidentSourceSchema.optional(),
  engine: problemEngineSchema,
  constraints: z.array(constraintSchema),
  semanticPolicy: semanticPolicySchema.optional(),
  files: z.array(problemFileSchema).min(1),
  bootSequence: z.array(problemBootStepSchema).min(1).optional(),
  quickCommands: z.array(quickCommandSchema),
  referenceCommands: z.array(z.string().min(1)).optional(),
  probeTargets: z.array(z.string()),
  validators: z.array(levelValidatorSchema).min(1),
  hints: z.array(hintSchema),
  evidenceRules: z.array(evidenceRuleSchema),
  postSolveExplanation: postSolveSchema,
});

const interactiveLabSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  files: z.array(editableFileSchema),
  initialManifests: z.array(z.string()),
  registeredImages: z.array(simulatedImageSchema),
  tryChanging: z.string().optional(),
  tasks: z.array(z.string().min(1)).optional(),
  commands: z.array(z.string().min(1)).optional(),
  debrief: z.string().optional(),
});

export const playgroundTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  concepts: z.array(conceptSchema),
  files: z.array(editableFileSchema),
  initialManifests: z.array(z.string()),
  registeredImages: z.array(simulatedImageSchema),
});

const docsBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), id: z.string().min(1), text: z.string().min(1) }),
  z.object({ type: z.literal("paragraph"), text: z.string().min(1) }),
  z.object({
    type: z.literal("callout"),
    tone: z.enum(["info", "warning", "key"]),
    title: z.string().optional(),
    text: z.string().min(1),
  }),
  z.object({ type: z.literal("concept"), term: z.string().min(1), definition: z.string().min(1) }),
  z.object({ type: z.literal("code"), language: fileLanguageSchema, code: z.string().min(1) }),
  z.object({
    type: z.literal("diagram"),
    variant: z.enum([
      "control-loop",
      "cluster-architecture",
      "api-object",
      "pod",
      "workload-hierarchy",
      "service-routing",
      "probe-gates",
      "rollout",
      "namespace-boundary",
      "debug-loop",
    ]),
    title: z.string().optional(),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal("demo"),
    title: z.string().min(1),
    description: z.string().min(1),
    steps: z.array(
      z.object({
        label: z.string().min(1),
        detail: z.string().min(1),
        command: z.string().optional(),
        output: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("quiz"),
    id: z.string().min(1),
    question: z.string().min(1),
    options: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        correct: z.boolean(),
        explanation: z.string().min(1),
      }),
    ),
  }),
  z.object({
    type: z.literal("steps"),
    title: z.string().optional(),
    items: z.array(z.object({ title: z.string().min(1), text: z.string().min(1) })),
  }),
  z.object({ type: z.literal("takeaways"), items: z.array(z.string().min(1)) }),
  z.object({
    type: z.literal("compare"),
    caption: z.string().optional(),
    left: z.object({ title: z.string(), code: z.string() }),
    right: z.object({ title: z.string(), code: z.string() }),
  }),
  z.object({
    type: z.literal("annotatedCode"),
    language: fileLanguageSchema,
    title: z.string().optional(),
    caption: z.string().optional(),
    lines: z.array(z.object({ code: z.string(), note: z.string().optional() })),
  }),
  z.object({
    type: z.literal("buildUp"),
    language: fileLanguageSchema,
    title: z.string().optional(),
    stages: z.array(
      z.object({ label: z.string().min(1), note: z.string().min(1), code: z.string().min(1) }),
    ),
  }),
  z.object({
    type: z.literal("spotTheBug"),
    language: fileLanguageSchema,
    title: z.string().optional(),
    prompt: z.string().min(1),
    code: z.string().min(1),
    answer: z.string().min(1),
  }),
  z.object({
    type: z.literal("challenge"),
    language: fileLanguageSchema,
    title: z.string().optional(),
    prompt: z.string().min(1),
    hint: z.string().optional(),
    solution: z.string().min(1),
  }),
  z.object({
    type: z.literal("decisionTable"),
    title: z.string().optional(),
    columns: z.array(z.string().min(1)).min(1),
    rows: z.array(z.object({ label: z.string().min(1), cells: z.array(z.string()) })),
  }),
  z.object({ type: z.literal("lab"), labId: z.string().min(1) }),
  z.object({ type: z.literal("mission"), missionSlug: z.string().min(1) }),
]);

export const docsLessonSchema = z.object({
  slug: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  section: z.string().min(1),
  order: z.number().int().nonnegative(),
  concepts: z.array(conceptSchema),
  relatedLevelSlug: z.string().optional(),
  sources: z.array(z.object({ title: z.string().min(1), href: z.string().url() })).optional(),
  content: z.array(docsBlockSchema).min(1),
  labs: z.array(interactiveLabSchema),
});

/**
 * Parse-or-throw helpers. The domain-type return annotations double as a
 * compile-time guarantee that each schema's inferred output stays assignable to the
 * hand-written type in `./types.ts`: if they drift, this file fails to typecheck.
 */
export function parseLevel(input: unknown): ProblemLevel {
  return problemLevelSchema.parse(input);
}
export function parseTemplate(input: unknown): PlaygroundTemplate {
  return playgroundTemplateSchema.parse(input);
}
export function parseLesson(input: unknown): DocsLesson {
  return docsLessonSchema.parse(input);
}
