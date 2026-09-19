import type { ArchitectureBuildSpec } from "./spec";
import { eq, gte, lte, present } from "./spec";

export const buildThreeZoneApi: ArchitectureBuildSpec = {
  id: "build-three-zone-api",
  title: "Build a Three-Zone API",
  severity: "critical",
  estimatedMinutes: 65,
  successRate: 31,
  concepts: [
    "deployments",
    "services",
    "scheduling",
    "disruptions",
    "autoscaling",
    "resources",
    "readiness-probes",
  ],
  capabilities: ["pods", "services", "deployments", "scheduling", "http-probes", "rollouts"],
  blurb:
    "Design an API that keeps serving through a zone loss without buying unlimited idle capacity.",
  story:
    "A checkout API must sustain 900 requests per second at normal load and three times that rate during promotions. The error budget permits less than one minute of unavailability per month. One availability zone may disappear without warning, and the platform budget allows four baseline replicas with growth to twelve. Build the workload, traffic, disruption, placement, and scaling contracts from an empty repository.",
  objective:
    "Deliver a three-zone API design with four baseline replicas, zero-unavailable rollouts, safe voluntary disruption, even zone placement, and bounded autoscaling from four to twelve replicas.",
  learningObjectives: [
    "Translate availability and traffic targets into replica, disruption, and autoscaling policy.",
    "Combine topology spread with a PodDisruptionBudget without making drains impossible.",
    "Bound capacity cost while keeping enough headroom for a full zone failure.",
  ],
  prerequisites: [
    "rollout-cannot-fit-maxsurge",
    "recreate-strategy-outage",
    "slow-start-without-startup-probe",
    "graceful-shutdown-502s",
  ],
  files: [
    {
      path: "namespace.yaml",
      apiVersion: "v1",
      kind: "Namespace",
      name: "resilient-api",
      label: "Place the API in a restricted, explicitly owned namespace",
      assertions: [
        eq("metadata.labels.securityProfile", "restricted"),
        eq("/metadata/labels/pod-security.kubernetes.io~1enforce", "restricted"),
        eq("metadata.labels.owner", "checkout-platform"),
      ],
      solution: `apiVersion: v1
kind: Namespace
metadata:
  name: resilient-api
  labels:
    owner: checkout-platform
    securityProfile: restricted
    pod-security.kubernetes.io/enforce: restricted
`,
    },
    {
      path: "deployment.yaml",
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "checkout-api",
      namespace: "resilient-api",
      label: "Run four bounded replicas across zones with safe probes and rollout capacity",
      goals: [{ goal: "zero-downtime-rollout", maxSurge: 1 }],
      assertions: [
        eq("spec.replicas", 4),
        eq("spec.selector.matchLabels.app", "checkout-api"),
        eq("spec.template.metadata.labels.app", "checkout-api"),
        eq(
          "spec.template.spec.topologySpreadConstraints[topologyKey=topology.kubernetes.io/zone].topologyKey",
          "topology.kubernetes.io/zone",
        ),
        eq(
          "spec.template.spec.topologySpreadConstraints[topologyKey=topology.kubernetes.io/zone].maxSkew",
          1,
        ),
        eq(
          "spec.template.spec.topologySpreadConstraints[topologyKey=topology.kubernetes.io/zone].whenUnsatisfiable",
          "DoNotSchedule",
        ),
        eq(
          "spec.template.spec.topologySpreadConstraints[topologyKey=topology.kubernetes.io/zone].labelSelector.matchLabels.app",
          "checkout-api",
        ),
        present("spec.template.spec.containers[name=api].image"),
        present("spec.template.spec.containers[name=api].ports[name=http].containerPort"),
        present("spec.template.spec.containers[name=api].readinessProbe"),
        present("spec.template.spec.containers[name=api].livenessProbe"),
        present("spec.template.spec.containers[name=api].resources.requests.cpu"),
        present("spec.template.spec.containers[name=api].resources.requests.memory"),
        present("spec.template.spec.containers[name=api].resources.limits.cpu"),
        present("spec.template.spec.containers[name=api].resources.limits.memory"),
      ],
      solution: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
  namespace: resilient-api
spec:
  replicas: 4
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: checkout-api
  template:
    metadata:
      labels:
        app: checkout-api
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
              app: checkout-api
      containers:
        - name: api
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          image: registry.example/checkout-api@sha256:1111111111111111111111111111111111111111111111111111111111111111
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
          livenessProbe:
            httpGet:
              path: /healthz
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
      path: "service.yaml",
      apiVersion: "v1",
      kind: "Service",
      name: "checkout-api",
      namespace: "resilient-api",
      label: "Expose only Ready checkout-api Pods through a stable internal address",
      assertions: [
        eq("spec.type", "ClusterIP"),
        eq("spec.selector.app", "checkout-api"),
        eq("spec.ports[name=http].port", 80),
        eq("spec.ports[name=http].targetPort", "http"),
      ],
      solution: `apiVersion: v1
kind: Service
metadata:
  name: checkout-api
  namespace: resilient-api
spec:
  type: ClusterIP
  selector:
    app: checkout-api
  ports:
    - name: http
      port: 80
      targetPort: http
`,
    },
    {
      path: "pdb.yaml",
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      name: "checkout-api",
      namespace: "resilient-api",
      label: "Keep at least three API replicas available during voluntary disruption",
      assertions: [eq("spec.selector.matchLabels.app", "checkout-api")],
      solution: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-api
  namespace: resilient-api
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: checkout-api
`,
    },
    {
      path: "hpa.yaml",
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      name: "checkout-api",
      namespace: "resilient-api",
      label: "Scale between the four-replica failure floor and the twelve-replica budget ceiling",
      assertions: [
        eq("spec.minReplicas", 4),
        eq("spec.maxReplicas", 12),
        eq("spec.scaleTargetRef.apiVersion", "apps/v1"),
        eq("spec.scaleTargetRef.kind", "Deployment"),
        eq("spec.scaleTargetRef.name", "checkout-api"),
        eq("spec.metrics[type=Resource].resource.name", "cpu"),
        eq("spec.metrics[type=Resource].resource.target.type", "Utilization"),
        gte("spec.metrics[type=Resource].resource.target.averageUtilization", 40),
        lte("spec.metrics[type=Resource].resource.target.averageUtilization", 80),
      ],
      solution: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout-api
  namespace: resilient-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-api
  minReplicas: 4
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
`,
    },
  ],
  semanticPolicy: {
    disruptionBudgets: { "checkout-api": { baseline: 4, minimumAvailable: 3 } },
  },
  hintBodies: [
    "Model the loss of one zone before choosing replicas. The surviving zones must retain enough Ready capacity while the disruption budget still permits routine maintenance.",
    "The autoscaler needs resource requests to interpret utilization. Its minimum is also the failure-capacity floor, not just an idle-cost preference.",
    "A hard zone spread protects availability but can leave Pods Pending during a zone outage. That is acceptable here because four replicas and two surviving zones retain the SLO while capacity recovers.",
  ],
  review: {
    risk: "The starter repository had no capacity, placement, or disruption contract, so a single-zone loss could remove the entire API or a drain could consume the error budget.",
    reasoning:
      "Healthy Pods alone do not prove zonal resilience. Replica count, rollout surge, scheduling spread, resource requests, autoscaling, and voluntary disruption must agree on the same failure model.",
    accepted:
      "The accepted design establishes four baseline replicas, zone-aware placement, three required available replicas, zero-unavailable rollout behavior, and bounded scaling to twelve.",
    tradeoffs:
      "Hard zone spread may delay replacement Pods while a zone is absent, and minAvailable three may slow drains. Those constraints intentionally favor the availability SLO over fastest maintenance while the HPA ceiling protects the budget.",
  },
  docsHref: "/docs/operations/scheduling",
  recommendedNextSlugs: ["build-default-deny-service-graph"],
};
