import type { ProblemLevel } from "@/lib/domain/types";

import { PUBLISHED_PROBLEM_V1 } from "./metadata";

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: edge-api
  namespace: default
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: edge-api
  template:
    metadata:
      labels:
        app: edge-api
    spec:
      terminationGracePeriodSeconds: 5
      containers:
        - name: api
          image: registry.example/edge-api:2.4.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
`;

const SERVICE_YAML = `apiVersion: v1
kind: Service
metadata:
  name: edge-api-svc
  namespace: default
spec:
  selector:
    app: edge-api
  ports:
    - name: http
      port: 80
      targetPort: 8080
`;

export const gracefulShutdown502s = {
  id: "graceful-shutdown-502s",
  slug: "graceful-shutdown-502s",
  ...PUBLISHED_PROBLEM_V1,
  title: "Graceful Shutdown 502s",
  difficulty: "advanced",
  severity: "critical",
  xp: 200,
  estimatedMinutes: 30,
  successRate: 38,
  concepts: [
    "deployments",
    "replicasets",
    "services",
    "endpointslices",
    "lifecycle-hooks",
    "rollouts",
    "debugging",
  ],
  blurb: "Most rollout requests succeed, but terminating backends intermittently return 502.",
  story:
    "edge-api reports two healthy replicas and the rollout strategy allows zero unavailable Pods. During every release, roughly one request in three still returns 502. The external route is slower to forget an endpoint than the application is to close its listener.",
  objective:
    "Keep terminating Pods serving long enough for endpoint propagation and eliminate sampled rollout errors.",
  learningObjectives: [
    "Explain why Pod termination and external endpoint removal happen concurrently.",
    "Use preStop and terminationGracePeriodSeconds as a bounded drain window, then verify it with repeated traffic.",
  ],
  prerequisites: ["rolling-update-gone-wrong", "liveness-probe-death-spiral"],
  learningPaths: ["reliability", "sre-on-call", "platform-architect"],
  capabilities: [
    "pods",
    "services",
    "deployments",
    "replicasets",
    "events",
    "logs",
    "http-probes",
    "rollouts",
    "container-lifecycle",
  ],
  incidentSource: {
    title: "Kubernetes' dirty endpoint secret and Ingress (Ravelin)",
    href: "https://philpearl.github.io/post/k8s_ingress/",
    attribution: "inspired-by",
    adaptationNote:
      "This deterministic lab adapts the endpoint-propagation and early-listener-shutdown mechanism. Names, timing, traffic ratio, and manifests are simplified; it is not an exact reproduction of Ravelin's environment.",
  },
  engine: { kind: "scripted", scenarioId: "graceful-shutdown-502" },
  constraints: [
    {
      id: "edit-deployment-only",
      label: "Only edit deployment.yaml",
      kind: "editable-files",
      paths: ["deployment.yaml"],
    },
    {
      id: "preserve-rollout-add-drain",
      label: "Keep the workload, image, probes, and zero-unavailable rollout; add a bounded drain",
      kind: "manifest",
      file: "deployment.yaml",
      resource: { kind: "Deployment", name: "edge-api" },
      exclusive: true,
      assertions: [
        { path: "spec.replicas", operator: "equals", value: 2 },
        {
          path: "spec.strategy.rollingUpdate.maxUnavailable",
          operator: "equals",
          value: 0,
        },
        {
          path: "spec.template.spec.containers[name=api].image",
          operator: "equals",
          value: "registry.example/edge-api:2.4.0",
        },
        { path: "spec.template.spec.containers[name=api].readinessProbe", operator: "present" },
      ],
      // A supported delay must cover this application's propagation window;
      // equivalent direct, shell, and native sleep actions are accepted.
      goals: [
        { goal: "graceful-drain", container: "api", minGraceSeconds: 15, minDrainSeconds: 10 },
      ],
    },
  ],
  files: [
    {
      path: "deployment.yaml",
      language: "yaml",
      initialValue: DEPLOYMENT_YAML,
      access: "editable",
      applyAtBoot: true,
    },
    {
      path: "service.yaml",
      language: "yaml",
      initialValue: SERVICE_YAML,
      access: "readonly",
      applyAtBoot: true,
    },
  ],
  quickCommands: [
    { id: "pods", command: "kubectl get pods" },
    { id: "replicasets", command: "kubectl get rs" },
    { id: "endpoints", command: "kubectl get endpointslices" },
    {
      id: "describe-old",
      command: "kubectl describe pod <pod>",
      target: {
        kind: "pod",
        namespace: "default",
        selector: { app: "edge-api", release: "old" },
        prefer: "first",
      },
    },
    {
      id: "logs-old",
      command: "kubectl logs <pod>",
      target: {
        kind: "pod",
        namespace: "default",
        selector: { app: "edge-api", release: "old" },
        prefer: "first",
      },
    },
    { id: "events", command: "kubectl get events --sort-by=.lastTimestamp" },
  ],
  probeTargets: ["http://edge-api-svc/", "http://edge-api-svc/healthz"],
  validators: [
    {
      id: "deployment-ready",
      title: "Rollout capacity is healthy",
      successLabel: "edge-api retains at least two Ready replicas",
      failureLabel: "edge-api has fewer than two Ready replicas",
      kind: "deployment-ready",
      namespace: "default",
      name: "edge-api",
      minReadyReplicas: 2,
    },
    {
      id: "sampled-availability",
      title: "Sampled rollout traffic stays healthy",
      successLabel: "All six sampled requests return HTTP 200",
      failureLabel: "At least one sampled request still reaches a closed listener",
      kind: "http-sample-through-service",
      namespace: "default",
      service: "edge-api-svc",
      port: 80,
      path: "/",
      expectStatus: 200,
      samples: 6,
      maxFailures: 0,
    },
  ],
  hints: [
    {
      id: "hint-1",
      title: "One curl is not a traffic test",
      body: "Use Sample 6x in Network Probe. Compare the backend named in successful and failed response bodies.",
      xpPenalty: 25,
    },
    {
      id: "hint-2",
      title: "Inspect the terminating process",
      body: "The old Pod remains in the endpoint set briefly. Its logs show what the process does immediately after SIGTERM.",
      xpPenalty: 40,
      unlockAfter: ["r-intermittent-502"],
    },
    {
      id: "hint-3",
      title: "Drain before exit",
      body: 'Add a preStop exec hook with ["sh", "-c", "sleep 10"] and set terminationGracePeriodSeconds to at least 15 so the hook fits inside the total grace window.',
      xpPenalty: 55,
      unlockAfter: ["r-listener-closes"],
    },
  ],
  evidenceRules: [
    {
      id: "r-intermittent-502",
      evidenceId: "sampled-502",
      label: "Repeated traffic intermittently returns 502 from edge-api-old",
      hiddenLabel: "Rollout traffic sampled repeatedly",
      source: "network",
      trigger: {
        type: "probe",
        hostMatches: "^edge-api-svc$",
        pathMatches: "/",
        status: 502,
        bodyMatches: "edge-api-old",
      },
    },
    {
      id: "r-stale-endpoint",
      evidenceId: "terminating-endpoint-present",
      label: "The EndpointSlice still records the terminating Pod while routes converge",
      hiddenLabel: "Terminating endpoint state inspected",
      source: "terminal",
      trigger: {
        type: "command",
        commandMatches: "get endpointslices",
        outputMatches: "10.0.0.30",
      },
    },
    {
      id: "r-listener-closes",
      evidenceId: "listener-closes-on-sigterm",
      label: "edge-api-old closes its listener immediately after SIGTERM",
      hiddenLabel: "Terminating Pod logs inspected",
      source: "logs",
      trigger: {
        type: "log",
        messageMatches: "SIGTERM received; closing listener immediately",
        podMatches: "edge-api-old",
      },
    },
    {
      id: "r-killing-overlap",
      evidenceId: "termination-overlaps-propagation",
      label: "Killing starts while external endpoint removal is pending",
      hiddenLabel: "Termination events inspected",
      source: "events",
      trigger: {
        type: "event-reason",
        reason: "Killing",
        messageMatches: "endpoint removal is pending",
      },
    },
    {
      id: "r-short-grace",
      evidenceId: "short-termination-window",
      label: "The Pod has only a five-second grace period and no preStop hook",
      hiddenLabel: "Pod termination configuration inspected",
      source: "terminal",
      trigger: {
        type: "command",
        commandMatches: "describe pod",
        outputMatches: "Termination Grace Period:\\s+5s",
      },
    },
  ],
  postSolveExplanation: {
    rootCause:
      "The application closed its listener as soon as SIGTERM arrived, while the external route still sent new requests to the terminating endpoint.",
    whyItFailed:
      "Kubernetes begins container termination and endpoint-state propagation concurrently. The terminating endpoint stops being Ready, but an Ingress or external load balancer can lag behind that update. During that window, the old Pod remained externally routable but no longer accepted connections, producing intermittent 502 responses despite healthy replica counts.",
    whatFixedIt:
      "A ten-second preStop delay kept the process serving while routing converged. A fifteen-second total termination grace period left room for the hook and process shutdown. Six-request validation then remained entirely HTTP 200.",
    prevention:
      "Measure real endpoint-propagation latency, budget preStop and termination grace above it, preserve rollout capacity, and sample traffic during termination in release tests.",
    relatedConcepts: ["lifecycle-hooks", "rollouts", "services", "endpointslices", "debugging"],
    docsHref: "/docs/workloads/init-sidecars-lifecycle",
    recommendedNextSlugs: ["zombie-replicaset"],
  },
} satisfies ProblemLevel;
