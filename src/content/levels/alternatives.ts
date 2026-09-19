/**
 * Adversarial corpus for the acceptance rules, keyed by slug.
 *
 * `LEVEL_SOLUTIONS` only proves a level *can* be solved. It says nothing about the two
 * failures that actually hurt a learner:
 *
 *  - a **false negative**: they diagnosed the incident and fixed it a different but
 *    equally correct way, and the rubric failed them anyway;
 *  - a **false positive**: they changed something adjacent that looks like the fix and
 *    the level congratulated them for it.
 *
 * Every entry here is one of those two cases, written out as the workspace a learner
 * would actually submit. Nothing in the app imports this module.
 */

export interface LevelVariant {
  /** Why this submission is correct, or why it must not be accepted. */
  reason: string;
  /** Editable file contents, keyed by path. */
  files: Record<string, string>;
}

export interface LevelVariants {
  /** Different, genuinely correct answers. These MUST pass validation. */
  accepted: LevelVariant[];
  /** Plausible answers that do not fix the incident. These MUST fail. */
  rejected: LevelVariant[];
}

const CHECKOUT_ZONE_ANTI_AFFINITY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: checkout
  template:
    metadata:
      labels:
        app: checkout
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: topology.kubernetes.io/zone
              labelSelector:
                matchLabels:
                  app: checkout
      containers:
        - name: api
          image: registry.example/checkout@sha256:4c104c104c104c104c104c104c104c104c104c104c104c104c104c104c104c10
`;

const CHECKOUT_ZONE_PREFERRED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: checkout
  template:
    metadata:
      labels:
        app: checkout
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: topology.kubernetes.io/zone
                labelSelector:
                  matchLabels:
                    app: checkout
      containers:
        - name: api
          image: registry.example/checkout@sha256:4c104c104c104c104c104c104c104c104c104c104c104c104c104c104c104c10
`;

const CHECKOUT_HOSTNAME_SPREAD = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: checkout
  template:
    metadata:
      labels:
        app: checkout
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: checkout
      containers:
        - name: api
          image: registry.example/checkout@sha256:4c104c104c104c104c104c104c104c104c104c104c104c104c104c104c104c10
`;

const checkoutRollout = (rollingUpdate: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: default
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
${rollingUpdate}
  selector:
    matchLabels:
      app: checkout
  template:
    metadata:
      labels:
        app: checkout
    spec:
      containers:
        - name: api
          image: klab/checkout:2.1.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
`;

const analyticsRollout = (rollingUpdate: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics
  namespace: default
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
${rollingUpdate}
  selector:
    matchLabels:
      app: analytics
  template:
    metadata:
      labels:
        app: analytics
        track: v2
    spec:
      containers:
        - name: api
          image: klab/analytics:2.0.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
          resources:
            requests:
              cpu: "2"
            limits:
              cpu: "2"
`;

const edgeApiDrain = (grace: number, preStop: string) => `apiVersion: apps/v1
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
      terminationGracePeriodSeconds: ${grace}
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
          lifecycle:
            preStop:
${preStop}
`;

const paymentsProbe = (readinessPort: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: payments-api
  template:
    metadata:
      labels:
        app: payments-api
    spec:
      containers:
        - name: api
          image: klab/web-app:1.0.0
          ports:
            - name: http
              containerPort: 8080
            - name: admin
              containerPort: 9090
          readinessProbe:
            httpGet:
              path: /healthz
              port: ${readinessPort}
            periodSeconds: 2
            failureThreshold: 2
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 5
            failureThreshold: 3
`;

const privateApi = (pullSecrets: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: private-api
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: private-api
  template:
    metadata:
      labels:
        app: private-api
    spec:
${pullSecrets}
      containers:
        - name: api
          image: registry.example/private/api:1.0.0
          ports:
            - name: http
              containerPort: 8080
`;

const ordersApi = (upstream: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: orders-api
  template:
    metadata:
      labels:
        app: orders-api
    spec:
      containers:
        - name: orders-api
          image: klab/api:1.0.0
          env:
            - name: UPSTREAM_URL
              value: ${upstream}
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 1
            periodSeconds: 2
            timeoutSeconds: 2
`;

const reportsApi = (
  startupPort: string,
  startupPeriod: number,
  startupFailures: number,
  livenessFailures = 2,
) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: reports-api
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: reports-api
  template:
    metadata:
      labels:
        app: reports-api
    spec:
      containers:
        - name: api
          image: klab/slow-api:1.0.0
          ports:
            - name: http
              containerPort: 8080
          startupProbe:
            tcpSocket:
              port: ${startupPort}
            periodSeconds: ${startupPeriod}
            failureThreshold: ${startupFailures}
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 1
            failureThreshold: 2
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 1
            failureThreshold: ${livenessFailures}
`;

const searchDeployment = (
  selectorTier: boolean,
  templateTier: boolean,
  replicas = 2,
) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: search
  namespace: default
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: search
${selectorTier ? "      tier: api\n" : ""}  template:
    metadata:
      labels:
        app: search
${templateTier ? "        tier: api\n        component: backend\n" : ""}    spec:
      containers:
        - name: api
          image: klab/search:1.4.0
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
`;

const securityAgent = (
  dnsPolicy: string,
  hostNetwork = true,
  image = "registry.example/security-agent@sha256:71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef",
  nameserver?: string,
) => `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: security-agent
  namespace: security
spec:
  selector:
    matchLabels:
      app: security-agent
  template:
    metadata:
      labels:
        app: security-agent
    spec:
      hostNetwork: ${hostNetwork}
      dnsPolicy: ${dnsPolicy}
${nameserver ? `      dnsConfig:\n        nameservers: [${nameserver}]\n` : ""}      containers:
        - name: metrics
          image: registry.example/metrics@sha256:2929292929292929292929292929292929292929292929292929292929292929
        - name: agent
          image: ${image}
`;

const databaseService = (
  publishNotReady: boolean,
  selector = "database",
  clusterIP = "None",
  peerPort = 7000,
  protocol = "TCP",
) => `apiVersion: v1
kind: Service
metadata:
  name: database
  namespace: data
spec:
  type: ClusterIP
  clusterIP: ${clusterIP}
  publishNotReadyAddresses: ${publishNotReady}
  selector:
    app: ${selector}
  ports:
    - name: metrics
      port: 9090
    - name: peer
      port: ${peerPort}
      protocol: ${protocol}
`;

const storefrontIngress = (
  ingressClassName: string,
  backend = "storefront",
  extraRule = "",
) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: storefront
  namespace: shop
spec:
  ingressClassName: ${ingressClassName}
  rules:
${extraRule}    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${backend}
                port:
                  number: 80
`;

const paymentsPublicService = (
  externalTrafficPolicy: "Local" | "Cluster" | undefined,
  selector = "payments",
  annotation = true,
  protocol = "TCP",
) => `apiVersion: v1
kind: Service
metadata:
  name: payments-public
  namespace: payments
${annotation ? "  annotations:\n    incident-exception: client-ip-loss-approved\n" : ""}spec:
  type: LoadBalancer
${externalTrafficPolicy ? `  externalTrafficPolicy: ${externalTrafficPolicy}\n` : ""}  selector:
    app: ${selector}
  ports:
    - name: https
      port: 443
      targetPort: 8443
      protocol: ${protocol}
`;

export const LEVEL_VARIANTS: Record<string, LevelVariants> = {
  "all-replicas-one-failure-domain": {
    accepted: [
      {
        reason:
          "Required zone anti-affinity spreads replicas exactly as a topology spread rule does",
        files: { "deployment.yaml": CHECKOUT_ZONE_ANTI_AFFINITY },
      },
    ],
    rejected: [
      {
        reason: "Preferred anti-affinity only asks nicely; the scheduler may still stack one zone",
        files: { "deployment.yaml": CHECKOUT_ZONE_PREFERRED },
      },
      {
        reason:
          "Spreading across hostnames survives a node loss, not the zone loss that caused the outage",
        files: { "deployment.yaml": CHECKOUT_HOSTNAME_SPREAD },
      },
    ],
  },

  "recreate-strategy-outage": {
    accepted: [
      {
        reason: "maxUnavailable 0% is the same promise as 0 for any replica count",
        files: {
          "deployment.yaml": checkoutRollout("      maxUnavailable: 0%\n      maxSurge: 1"),
        },
      },
    ],
    rejected: [
      {
        reason: "RollingUpdate that still surrenders a replica reproduces the outage at half scale",
        files: { "deployment.yaml": checkoutRollout("      maxUnavailable: 1\n      maxSurge: 1") },
      },
      {
        reason: "50% of two replicas is one pod, so availability is still sacrificed",
        files: {
          "deployment.yaml": checkoutRollout("      maxUnavailable: 50%\n      maxSurge: 1"),
        },
      },
      {
        reason:
          "Zero unavailable and zero surge preserves traffic but leaves the rollout deadlocked",
        files: {
          "deployment.yaml": checkoutRollout("      maxUnavailable: 0\n      maxSurge: 0"),
        },
      },
    ],
  },

  "immutable-deployment-selector": {
    accepted: [
      {
        reason: "Additional pod labels are safe when the stable Deployment selector is preserved",
        files: { "deployment.yaml": searchDeployment(false, true) },
      },
    ],
    rejected: [
      {
        reason: "Adding tier to the Deployment selector still attempts the forbidden mutation",
        files: { "deployment.yaml": searchDeployment(true, true) },
      },
      {
        reason: "Scaling to zero creates no endpoints even when the template labels match",
        files: { "deployment.yaml": searchDeployment(false, true, 0) },
      },
      {
        reason: "Adding a selector expression is still an immutable selector mutation",
        files: {
          "deployment.yaml": searchDeployment(false, true).replace(
            "      app: search\n  template:",
            "      app: search\n    matchExpressions:\n      - key: tier\n        operator: In\n        values: [api]\n  template:",
          ),
        },
      },
    ],
  },

  "dns-resolution-failure": {
    accepted: [
      {
        reason: "The fully qualified Service DNS name reaches the same in-cluster upstream",
        files: {
          "orders-api.yaml": ordersApi("http://web-svc.default.svc.cluster.local.:80/"),
        },
      },
    ],
    rejected: [
      {
        reason: "The original transposed hostname is still NXDOMAIN",
        files: { "orders-api.yaml": ordersApi("http://web-scv/") },
      },
      {
        reason: "Resolving the Service is not enough when the configured endpoint returns 404",
        files: { "orders-api.yaml": ordersApi("http://web-svc/not-found") },
      },
    ],
  },

  "slow-start-without-startup-probe": {
    accepted: [
      {
        reason:
          "A TCP startup gate on the named serving port with a six-second budget protects the same warm-up",
        files: { "deployment.yaml": reportsApi("http", 2, 3) },
      },
    ],
    rejected: [
      {
        reason: "A two-second startup budget still kills the process before warm-up completes",
        files: { "deployment.yaml": reportsApi("http", 1, 2) },
      },
      {
        reason: "A long startup budget on a port the application never serves can never succeed",
        files: { "deployment.yaml": reportsApi("9090", 2, 3) },
      },
      {
        reason: "Weakening steady-state liveness violates the incident's health-detection contract",
        files: { "deployment.yaml": reportsApi("http", 2, 3, 30) },
      },
    ],
  },

  "hostnetwork-lost-cluster-dns": {
    accepted: [
      {
        reason: "An unrelated sidecar listed first does not change the agent's DNS policy",
        files: { "security-agent.yaml": securityAgent("ClusterFirstWithHostNet") },
      },
    ],
    rejected: [
      {
        reason: "ClusterFirst falls back to host DNS for a hostNetwork Pod",
        files: { "security-agent.yaml": securityAgent("ClusterFirst") },
      },
      {
        reason: "Disabling host networking violates the node-observation requirement",
        files: { "security-agent.yaml": securityAgent("ClusterFirstWithHostNet", false) },
      },
      {
        reason: "Replacing the reviewed agent image is not a DNS repair",
        files: {
          "security-agent.yaml": securityAgent(
            "ClusterFirstWithHostNet",
            true,
            "registry.example/security-agent:unreviewed",
          ),
        },
      },
      {
        reason:
          "A public-only nameserver overrides the cluster DNS policy and still loses Services",
        files: {
          "security-agent.yaml": securityAgent(
            "ClusterFirstWithHostNet",
            true,
            "registry.example/security-agent@sha256:71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef71ef",
            "8.8.8.8",
          ),
        },
      },
    ],
  },

  "stateful-peers-cannot-discover": {
    accepted: [
      {
        reason: "An additional metrics port does not change headless peer discovery",
        files: { "database-service.yaml": databaseService(true) },
      },
    ],
    rejected: [
      {
        reason: "Publishing not-ready addresses on a normal ClusterIP loses peer-specific DNS",
        files: { "database-service.yaml": databaseService(true, "database", "10.96.30.10") },
      },
      {
        reason: "A selector drift still leaves every database member undiscoverable",
        files: { "database-service.yaml": databaseService(true, "database-v2") },
      },
      {
        reason: "Publishing the wrong peer port breaks consensus bootstrap",
        files: { "database-service.yaml": databaseService(true, "database", "None", 7001) },
      },
      {
        reason: "Publishing the peer port over UDP cannot carry the database's TCP protocol",
        files: {
          "database-service.yaml": databaseService(true, "database", "None", 7000, "UDP"),
        },
      },
    ],
  },

  "orphaned-ingress": {
    accepted: [
      {
        reason: "An unrelated host rule listed first does not change the storefront route",
        files: {
          "ingress.yaml": storefrontIngress(
            "nginx",
            "storefront",
            "    - host: status.example.com\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: status\n                port:\n                  number: 80\n",
          ),
        },
      },
    ],
    rejected: [
      {
        reason: "The active class cannot reconcile a route to the wrong backend Service",
        files: { "ingress.yaml": storefrontIngress("nginx", "storefront-v2") },
      },
      {
        reason: "Keeping the retired class leaves the Ingress unclaimed",
        files: { "ingress.yaml": storefrontIngress("legacy-edge") },
      },
    ],
  },

  "local-traffic-black-hole": {
    accepted: [
      {
        reason: "Omitting externalTrafficPolicy uses Kubernetes' Cluster default",
        files: { "payments-service.yaml": paymentsPublicService(undefined) },
      },
    ],
    rejected: [
      {
        reason: "Local continues to black-hole nodes without a payments endpoint",
        files: { "payments-service.yaml": paymentsPublicService("Local") },
      },
      {
        reason: "Changing the selector removes every healthy payments endpoint",
        files: { "payments-service.yaml": paymentsPublicService("Cluster", "payments-v2") },
      },
      {
        reason: "The approved client-IP exception must be recorded for the temporary mitigation",
        files: {
          "payments-service.yaml": paymentsPublicService("Cluster", "payments", false),
        },
      },
      {
        reason: "Changing the public HTTPS port to UDP leaves TCP clients disconnected",
        files: {
          "payments-service.yaml": paymentsPublicService("Cluster", "payments", true, "UDP"),
        },
      },
    ],
  },

  "rollout-cannot-fit-maxsurge": {
    accepted: [
      {
        reason: "0% surge with 50% unavailable rolls two replicas one at a time, within capacity",
        files: {
          "deployment.yaml": analyticsRollout("      maxSurge: 0%\n      maxUnavailable: 50%"),
        },
      },
    ],
    rejected: [
      {
        reason: "A surge replica needs a third node that this cluster does not have",
        files: {
          "deployment.yaml": analyticsRollout("      maxSurge: 1\n      maxUnavailable: 1"),
        },
      },
      {
        reason: "Zero surge and zero unavailable leaves the rollout no way to make progress",
        files: {
          "deployment.yaml": analyticsRollout("      maxSurge: 0\n      maxUnavailable: 0"),
        },
      },
    ],
  },

  "graceful-shutdown-502s": {
    accepted: [
      {
        reason: "A twelve-second delay also covers propagation inside a twenty-second grace window",
        files: {
          "deployment.yaml": edgeApiDrain(
            20,
            '                exec:\n                  command: ["/bin/sh", "-c", "sleep 12"]',
          ),
        },
      },
    ],
    rejected: [
      {
        reason: "A 30s drain inside a 15s budget is killed early, so connections still break",
        files: {
          "deployment.yaml": edgeApiDrain(
            15,
            '                exec:\n                  command: ["sh", "-c", "sleep 30"]',
          ),
        },
      },
      {
        reason:
          "Extending the grace period alone changes nothing: the listener still closes at once",
        files: {
          "deployment.yaml": edgeApiDrain(
            60,
            "                exec:\n                  command: []",
          ),
        },
      },
    ],
  },

  "probe-hits-wrong-port": {
    accepted: [
      {
        reason: "Addressing the serving port by its declared name is idiomatic and equivalent",
        files: { "deployment.yaml": paymentsProbe("http") },
      },
    ],
    rejected: [
      {
        reason: "The admin port name still resolves to 9090, which serves nothing",
        files: { "deployment.yaml": paymentsProbe("admin") },
      },
      {
        reason: "A port the container never declares cannot answer the probe",
        files: { "deployment.yaml": paymentsProbe("7070") },
      },
    ],
  },

  "private-registry-pull-secret": {
    accepted: [
      {
        reason: "An unrelated pull secret listed first does not stop the right one from being used",
        files: {
          "deployment.yaml": privateApi(
            "      imagePullSecrets:\n        - name: mirror-credentials\n        - name: registry-credentials",
          ),
        },
      },
    ],
    rejected: [
      {
        reason: "Referencing a Secret the cluster does not hold leaves the kubelet unauthenticated",
        files: {
          "deployment.yaml": privateApi(
            "      imagePullSecrets:\n        - name: wrong-credentials",
          ),
        },
      },
      {
        reason: "Mounting the credential as a volume does not give the kubelet registry access",
        files: {
          "deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: private-api
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: private-api
  template:
    metadata:
      labels:
        app: private-api
    spec:
      volumes:
        - name: creds
          secret:
            secretName: registry-credentials
      containers:
        - name: api
          image: registry.example/private/api:1.0.0
          ports:
            - name: http
              containerPort: 8080
          volumeMounts:
            - mountPath: /creds
              name: creds
`,
        },
      },
    ],
  },
};
