import type {
  KubernetesConcept,
  GoalCheck,
  LevelConstraint,
  ManifestAssertion,
  ProblemCapability,
  ProblemLevel,
  WorkspaceSemanticPolicy,
} from "@/lib/domain/types";

import { CURRENT_KUBERNETES_RANGE } from "../metadata";

export interface ArchitectureFileSpec {
  path: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  label: string;
  assertions: ManifestAssertion[];
  /** Outcome requirements that accept equivalent Kubernetes expressions. */
  goals?: GoalCheck[];
  solution: string;
}

export interface ArchitectureBuildSpec {
  id: string;
  title: string;
  severity: "high" | "critical";
  estimatedMinutes: number;
  successRate: number;
  concepts: KubernetesConcept[];
  capabilities: ProblemCapability[];
  blurb: string;
  story: string;
  objective: string;
  learningObjectives: string[];
  prerequisites: string[];
  files: ArchitectureFileSpec[];
  /**
   * Cross-resource acceptance rules for this design. Declared here, next to the
   * manifests they judge, rather than as a slug branch in the shared evaluator.
   */
  semanticPolicy?: WorkspaceSemanticPolicy;
  hintBodies: [string, string, string];
  review: {
    risk: string;
    reasoning: string;
    accepted: string;
    tradeoffs: string;
  };
  docsHref?: string;
  recommendedNextSlugs: string[];
}

export const eq = (path: string, value: string | number | boolean): ManifestAssertion => ({
  path,
  operator: "equals",
  value,
});

export const gte = (path: string, value: number): ManifestAssertion => ({
  path,
  operator: "gte",
  value,
});

export const lte = (path: string, value: number): ManifestAssertion => ({
  path,
  operator: "lte",
  value,
});

export const lengthEquals = (path: string, value: number): ManifestAssertion => ({
  path,
  operator: "length-equals",
  value,
});

export const includes = (path: string, value: string): ManifestAssertion => ({
  path,
  operator: "array-contains",
  value,
});

export const present = (path: string): ManifestAssertion => ({ path, operator: "present" });

export const emptyObject = (path: string): ManifestAssertion => ({
  path,
  operator: "empty-object",
});

export const validBase64 = (path: string): ManifestAssertion => ({ path, operator: "base64" });

export const notMatches = (path: string, value: string): ManifestAssertion => ({
  path,
  operator: "not-matches",
  value,
});

export const matches = (path: string, value: string): ManifestAssertion => ({
  path,
  operator: "matches",
  value,
});

export const excludes = (path: string, value: string): ManifestAssertion => ({
  path,
  operator: "array-not-contains",
  value,
});

function starterManifest(file: ArchitectureFileSpec): string {
  // Required literals are part of the public problem contract, not hidden answers.
  const requirements = file.assertions.map(
    (rule) =>
      `# ${rule.path}: ${rule.operator}${"value" in rule ? ` ${JSON.stringify(rule.value)}` : ""}`,
  );
  return [
    `# ${file.label}`,
    "# Acceptance contract:",
    ...requirements,
    `apiVersion: ${file.apiVersion}`,
    `kind: ${file.kind}`,
    "metadata:",
    `  name: ${file.name}`,
    ...(file.namespace ? [`  namespace: ${file.namespace}`] : []),
    "# Complete the resource below to meet the brief and acceptance contract.",
    "",
  ].join("\n");
}

function buildConstraints(files: readonly ArchitectureFileSpec[]): LevelConstraint[] {
  return [
    {
      id: "architecture-files",
      label: "Keep every architecture artifact in the submitted workspace",
      kind: "editable-files",
      paths: files.map((file) => file.path),
    },
    ...files.map((file): LevelConstraint => ({
      id: `architecture-${file.path.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      label: file.label,
      kind: "manifest",
      file: file.path,
      resource: {
        kind: file.kind,
        name: file.name,
        ...(file.namespace ? { namespace: file.namespace } : {}),
      },
      exclusive: true,
      assertions: [eq("apiVersion", file.apiVersion), ...file.assertions],
      ...(file.goals ? { goals: file.goals } : {}),
    })),
  ];
}

export function buildLevel(spec: ArchitectureBuildSpec): ProblemLevel {
  return {
    id: spec.id,
    slug: spec.id,
    contentVersion: 2,
    publicationStatus: "published",
    challengeMode: "build",
    title: spec.title,
    difficulty: "architect",
    severity: spec.severity,
    xp: 500,
    estimatedMinutes: spec.estimatedMinutes,
    successRate: spec.successRate,
    concepts: spec.concepts,
    blurb: spec.blurb,
    story: spec.story,
    objective: spec.objective,
    learningObjectives: spec.learningObjectives,
    prerequisites: spec.prerequisites,
    learningPaths: ["platform-architect"],
    capabilities: spec.capabilities,
    kubernetesVersion: CURRENT_KUBERNETES_RANGE,
    engine: { kind: "scripted", scenarioId: "manifest-assessment" },
    constraints: buildConstraints(spec.files),
    semanticPolicy: spec.semanticPolicy,
    files: spec.files.map((file) => ({
      path: file.path,
      language: "yaml",
      initialValue: starterManifest(file),
      access: "editable",
      applyAtBoot: false,
    })),
    quickCommands: [
      { id: "assessment-pod", command: "kubectl get pods" },
      { id: "assessment-events", command: "kubectl get events" },
      { id: "assessment-deployment", command: "kubectl describe deployment manifest-assessment" },
      { id: "assessment-logs", command: "kubectl logs manifest-assessment" },
    ],
    probeTargets: ["http://assessment-svc/"],
    validators: [
      {
        id: "architecture-ready",
        title: "Static manifest assessment is Ready",
        successLabel: "Every machine-checked manifest requirement is satisfied",
        failureLabel: "The manifests still violate one or more static requirements",
        kind: "pod-ready-by-selector",
        namespace: "default",
        selector: { app: "manifest-assessment" },
        minReady: 1,
      },
      {
        id: "architecture-contract",
        title: "Static architecture contract is accepted",
        successLabel: "The submitted manifests pass the static design review",
        failureLabel: "The submitted manifests do not pass the static design review",
        kind: "http-get-through-service",
        namespace: "default",
        service: "assessment-svc",
        port: 80,
        path: "/",
        expectStatus: 200,
      },
    ],
    hints: [
      {
        id: "design-review-1",
        title: "Review the failure boundary",
        body: spec.hintBodies[0],
        xpPenalty: 50,
      },
      {
        id: "design-review-2",
        title: "Review the operating contract",
        body: spec.hintBodies[1],
        xpPenalty: 75,
        unlockAfter: ["architecture-rejection"],
      },
      {
        id: "design-review-3",
        title: "Review the tradeoff",
        body: spec.hintBodies[2],
        xpPenalty: 100,
        unlockAfter: ["architecture-probe"],
      },
    ],
    evidenceRules: [
      {
        id: "architecture-pod",
        evidenceId: "architecture-pod-not-ready",
        label: "The policy assessment Pod is Running but not Ready",
        hiddenLabel: "Assessment workload status reviewed",
        source: "terminal",
        trigger: {
          type: "command",
          commandMatches: "get pods",
          outputMatches: "0/1|Running",
        },
      },
      {
        id: "architecture-rejection",
        evidenceId: "architecture-config-rejected",
        label: "The submitted repository does not meet every machine-checked requirement",
        hiddenLabel: "Policy assessment event reviewed",
        source: "events",
        trigger: { type: "event-reason", reason: "ConfigRejected" },
      },
      {
        id: "architecture-topology",
        evidenceId: "architecture-assessor-inspected",
        label: "The architecture assessment workload is the active policy gate",
        hiddenLabel: "Assessment topology inspected",
        source: "topology",
        trigger: {
          type: "topology-view",
          kind: "Deployment",
          nameMatches: "^manifest-assessment$",
          namespace: "default",
        },
      },
      {
        id: "architecture-probe",
        evidenceId: "architecture-contract-rejected",
        label: "The static assessment endpoint returns HTTP 422",
        hiddenLabel: "Static assessment endpoint tested",
        source: "network",
        trigger: {
          type: "probe",
          hostMatches: "^assessment-svc$",
          pathMatches: "^/$",
          status: 422,
        },
      },
    ],
    postSolveExplanation: {
      rootCause: spec.review.risk,
      whyItFailed: spec.review.reasoning,
      whatFixedIt: spec.review.accepted,
      prevention: spec.review.tradeoffs,
      relatedConcepts: spec.concepts,
      ...(spec.docsHref ? { docsHref: spec.docsHref } : {}),
      recommendedNextSlugs: spec.recommendedNextSlugs,
    },
  };
}
