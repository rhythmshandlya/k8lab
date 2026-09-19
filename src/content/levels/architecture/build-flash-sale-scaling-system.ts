import type { ArchitectureBuildSpec } from "./spec";
import { eq, present } from "./spec";

export const buildFlashSaleScalingSystem: ArchitectureBuildSpec = {
  id: "build-flash-sale-scaling-system",
  title: "Build a Flash-Sale Scaling System",
  severity: "critical",
  estimatedMinutes: 80,
  successRate: 21,
  concepts: [
    "deployments",
    "services",
    "autoscaling",
    "resources",
    "disruptions",
    "scheduling",
    "configmaps",
  ],
  capabilities: [
    "pods",
    "services",
    "deployments",
    "configmaps",
    "scheduling",
    "rollouts",
    "http-probes",
  ],
  blurb:
    "Scale an API and queue workers for a 20x burst without abandoning cost or disruption controls.",
  story:
    "A ticket sale jumps from 300 to 6,000 requests per second in under two minutes. The API must keep p95 latency below 300 ms while workers drain the purchase queue within five minutes. Finance caps the system at thirty API Pods and sixty workers. The platform already exposes purchase_queue_depth through its external-metrics adapter. A node drain may overlap the sale, so baseline headroom, bounded resources, queue-aware worker scaling, and disruption protection must work together.",
  objective:
    "Build a flash-sale system with six warm API replicas, ten warm workers, independent bounded autoscalers, resource requests, queue-depth scaling, priority, and a four-available API disruption floor.",
  learningObjectives: [
    "Choose warm capacity and scale ceilings from burst, latency, drain, and budget constraints.",
    "Scale request-serving and queue-consuming workloads from different demand signals.",
    "Protect critical capacity during disruption without making cluster operations impossible.",
  ],
  prerequisites: [
    "rollout-cannot-fit-maxsurge",
    "recreate-strategy-outage",
    "graceful-shutdown-502s",
    "liveness-probe-death-spiral",
  ],
  files: [
    {
      path: "namespace.yaml",
      apiVersion: "v1",
      kind: "Namespace",
      name: "commerce",
      label: "Create an owned restricted namespace for the sale workloads",
      assertions: [
        eq("metadata.labels.owner", "commerce-platform"),
        eq("/metadata/labels/pod-security.kubernetes.io~1enforce", "restricted"),
      ],
      solution: `apiVersion: v1
kind: Namespace
metadata:
  name: commerce
  labels:
    owner: commerce-platform
    pod-security.kubernetes.io/enforce: restricted
`,
    },
    {
      path: "scaling-contract.yaml",
      apiVersion: "v1",
      kind: "ConfigMap",
      name: "flash-sale-contract",
      namespace: "commerce",
      label: "Record the traffic, latency, queue, and budget assumptions used by both autoscalers",
      assertions: [
        eq("data.peakRps", "6000"),
        eq("data.p95LatencyMs", "300"),
        eq("data.queueDrainMinutes", "5"),
        eq("data.maxPods", "90"),
        { path: "data", operator: "length-equals", value: 4 },
      ],
      solution: `apiVersion: v1
kind: ConfigMap
metadata:
  name: flash-sale-contract
  namespace: commerce
data:
  peakRps: "6000"
  p95LatencyMs: "300"
  queueDrainMinutes: "5"
  maxPods: "90"
`,
    },
    {
      path: "api-deployment.yaml",
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "sale-api",
      namespace: "commerce",
      label: "Keep six warm, resource-bounded API replicas ready for the first burst",
      assertions: [
        eq("spec.replicas", 6),
        eq("spec.selector.matchLabels.app", "sale-api"),
        eq("spec.template.metadata.labels.app", "sale-api"),
        present("spec.template.spec.containers[name=api].readinessProbe"),
        eq("spec.template.spec.containers[name=api].readinessProbe.httpGet.path", "/readyz"),
        eq("spec.template.spec.containers[name=api].readinessProbe.httpGet.port", "http"),
        present("spec.template.spec.containers[name=api].resources.requests.cpu"),
        present("spec.template.spec.containers[name=api].resources.requests.memory"),
        present("spec.template.spec.containers[name=api].resources.limits.cpu"),
        present("spec.template.spec.containers[name=api].resources.limits.memory"),
        eq("spec.template.spec.priorityClassName", "sale-critical"),
      ],
      goals: [
        { goal: "zero-downtime-rollout", maxSurge: 2 },
        {
          goal: "spreads-across-topology",
          topologyKey: "topology.kubernetes.io/zone",
          maxSkew: 1,
        },
      ],
      solution: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sale-api
  namespace: commerce
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 2
  selector:
    matchLabels:
      app: sale-api
  template:
    metadata:
      labels:
        app: sale-api
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      priorityClassName: sale-critical
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: sale-api
      containers:
        - name: api
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          image: registry.example/sale-api:2.0.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
`,
    },
    {
      path: "api-service.yaml",
      apiVersion: "v1",
      kind: "Service",
      name: "sale-api",
      namespace: "commerce",
      label: "Route sale traffic to the warm API pool through named ports",
      assertions: [
        eq("spec.selector.app", "sale-api"),
        { path: "spec.ports", operator: "length-equals", value: 1 },
        eq("spec.ports[name=http].port", 80),
        eq("spec.ports[name=http].targetPort", "http"),
      ],
      solution: `apiVersion: v1
kind: Service
metadata:
  name: sale-api
  namespace: commerce
spec:
  selector:
    app: sale-api
  ports:
    - name: http
      port: 80
      targetPort: http
`,
    },
    {
      path: "worker-deployment.yaml",
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "sale-worker",
      namespace: "commerce",
      label: "Keep ten bounded queue workers warm without giving them API priority",
      assertions: [
        eq("spec.replicas", 10),
        eq("spec.selector.matchLabels.app", "sale-worker"),
        eq("spec.template.metadata.labels.app", "sale-worker"),
        { path: "spec.template.spec.priorityClassName", operator: "absent" },
        present("spec.template.spec.containers[name=worker].resources.requests.cpu"),
        present("spec.template.spec.containers[name=worker].resources.requests.memory"),
        present("spec.template.spec.containers[name=worker].resources.limits.cpu"),
        present("spec.template.spec.containers[name=worker].resources.limits.memory"),
      ],
      goals: [
        {
          goal: "spreads-across-topology",
          topologyKey: "topology.kubernetes.io/zone",
          maxSkew: 1,
        },
      ],
      solution: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sale-worker
  namespace: commerce
spec:
  replicas: 10
  selector:
    matchLabels:
      app: sale-worker
  template:
    metadata:
      labels:
        app: sale-worker
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: sale-worker
      containers:
        - name: worker
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          image: registry.example/sale-worker:2.0.0
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
`,
    },
    {
      path: "api-hpa.yaml",
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      name: "sale-api",
      namespace: "commerce",
      label:
        "Scale the API from six to thirty replicas on utilization while preserving warm headroom",
      assertions: [
        eq("spec.minReplicas", 6),
        eq("spec.maxReplicas", 30),
        eq("spec.scaleTargetRef.apiVersion", "apps/v1"),
        eq("spec.scaleTargetRef.kind", "Deployment"),
        eq("spec.scaleTargetRef.name", "sale-api"),
        { path: "spec.metrics", operator: "length-equals", value: 1 },
        eq("spec.metrics[type=Resource].resource.name", "cpu"),
        eq("spec.metrics[type=Resource].resource.target.type", "Utilization"),
        eq("spec.metrics[type=Resource].resource.target.averageUtilization", 55),
        eq("spec.behavior.scaleUp.stabilizationWindowSeconds", 0),
        eq("spec.behavior.scaleUp.policies[type=Percent].value", 100),
        eq("spec.behavior.scaleUp.policies[type=Percent].periodSeconds", 30),
      ],
      solution: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sale-api
  namespace: commerce
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sale-api
  minReplicas: 6
  maxReplicas: 30
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 55
`,
    },
    {
      path: "worker-hpa.yaml",
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      name: "sale-worker",
      namespace: "commerce",
      label: "Scale workers from ten to sixty against purchase queue depth",
      assertions: [
        eq("spec.minReplicas", 10),
        eq("spec.maxReplicas", 60),
        eq("spec.scaleTargetRef.apiVersion", "apps/v1"),
        eq("spec.scaleTargetRef.kind", "Deployment"),
        eq("spec.scaleTargetRef.name", "sale-worker"),
        { path: "spec.metrics", operator: "length-equals", value: 1 },
        eq("spec.metrics[type=External].external.metric.name", "purchase_queue_depth"),
        eq("spec.metrics[type=External].external.target.type", "AverageValue"),
        eq("spec.metrics[type=External].external.target.averageValue", "20"),
        eq("spec.behavior.scaleDown.stabilizationWindowSeconds", 300),
      ],
      solution: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sale-worker
  namespace: commerce
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sale-worker
  minReplicas: 10
  maxReplicas: 60
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
  metrics:
    - type: External
      external:
        metric:
          name: purchase_queue_depth
        target:
          type: AverageValue
          averageValue: "20"
`,
    },
    {
      path: "api-pdb.yaml",
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      name: "sale-api",
      namespace: "commerce",
      label: "Keep four API replicas serving during a voluntary disruption",
      assertions: [eq("spec.selector.matchLabels.app", "sale-api")],
      solution: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sale-api
  namespace: commerce
spec:
  minAvailable: 4
  selector:
    matchLabels:
      app: sale-api
`,
    },
    {
      path: "worker-pdb.yaml",
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      name: "sale-worker",
      namespace: "commerce",
      label: "Keep eight warm workers available during voluntary disruption",
      assertions: [eq("spec.selector.matchLabels.app", "sale-worker")],
      solution: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sale-worker
  namespace: commerce
spec:
  minAvailable: 8
  selector:
    matchLabels:
      app: sale-worker
`,
    },
    {
      path: "priority-class.yaml",
      apiVersion: "scheduling.k8s.io/v1",
      kind: "PriorityClass",
      name: "sale-critical",
      label: "Prioritize request admission without making the class a global default",
      assertions: [
        eq("value", 100000),
        eq("globalDefault", false),
        eq("preemptionPolicy", "PreemptLowerPriority"),
      ],
      solution: `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: sale-critical
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: Preserve customer request admission during the bounded sale window.
`,
    },
  ],
  semanticPolicy: {
    disruptionBudgets: {
      "sale-api": { baseline: 6, minimumAvailable: 4 },
      "sale-worker": { baseline: 10, minimumAvailable: 8 },
    },
  },
  hintBodies: [
    "Separate first-minute headroom from eventual autoscaling. The warm replica floor must absorb metric and provisioning delay before new Pods can become Ready.",
    "CPU is a useful API demand signal, but queue workers should scale from outstanding work. Give each workload its own ceiling so their combined maximum stays inside the ninety-Pod budget.",
    "Priority protects the customer-facing API under pressure but can evict lower-priority work. Keep it non-default, bound resources, and preserve enough worker capacity to avoid moving the outage into the queue.",
  ],
  review: {
    risk: "The starter repository had no warm capacity, scaling signals, priority, disruption floor, or cost ceiling, so the initial traffic step could overload the API before autoscaling reacted.",
    reasoning:
      "Burst resilience needs capacity already running, valid resource requests, separate synchronous and asynchronous demand signals, and explicit maximums that fit the budget.",
    accepted:
      "The accepted design starts six API replicas and ten workers, scales them independently to thirty and sixty, protects four API replicas during drains, and records the operating contract.",
    tradeoffs:
      "Warm replicas cost money outside sale windows and high priority can displace other workloads. Those costs are bounded and deliberate because cold autoscaling cannot satisfy the two-minute arrival curve or the latency SLO alone.",
  },
  docsHref: "/docs/operations/autoscaling",
  recommendedNextSlugs: ["build-incident-survivable-observability"],
};
