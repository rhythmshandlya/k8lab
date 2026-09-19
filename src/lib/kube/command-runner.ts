import type {
  CoreV1Event,
  V1Container,
  V1Deployment,
  V1Node,
  V1Pod,
  V1ReplicaSet,
  V1Service,
} from "@ngrok/webernetes";
import { load } from "js-yaml";

import { BRAND } from "@/config/brand";

import { parseKubernetesManifests, stringifyManifest } from "./manifest-parser";
import { createProbeSignal, type InvestigationSignal } from "./evidence";
import {
  deploymentReadyReplicas,
  eventAge,
  formatTable,
  humanizeAge,
  podPhase,
  podReadyCounts,
  podRestarts,
  servicePortsSummary,
} from "./kubectl/format";
import type { AppliedResourceRef, ClusterSnapshot, ProbeResult } from "./simulator";
import type { LogLine } from "./images/log-sink";
import type { Result } from "@/lib/utils/result";

/**
 * A small, deliberately limited kubectl-like command runner. It does not aim to be a
 * real shell: it must *feel* real. Commands parse into a discriminated union, then
 * execute against the simulator's live snapshot. Unknown/unsupported input returns
 * helpful, educational output (never throws), per the product UX rules.
 */

export interface CommandRuntime {
  getSnapshot(): ClusterSnapshot;
  probe(url: string, namespace?: string): Promise<ProbeResult>;
  getLogs(namespace: string, pod: string, container?: string): LogLine[];
  applyYaml(yamlText: string): Promise<Result<AppliedResourceRef[], string>>;
  deleteYaml(yamlText: string): Promise<Result<AppliedResourceRef[], string>>;
  /**
   * Present only for scenarios that grade the submitted files as one workspace and
   * cannot act on a single manifest. `kubectl apply -f <file>` then re-runs the whole
   * review, so the terminal agrees with the Apply button instead of erroring out.
   */
  applyWorkspace?(files: Record<string, string>): Promise<Result<AppliedResourceRef[], string>>;
  // Optional capabilities: KubeSimulator provides them all; scripted problem
  // engines may omit them, and the matching commands degrade with a clear message.
  exec?(
    namespace: string,
    pod: string,
    container: string | undefined,
    argv: string[],
  ): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, string>>;
  scaleDeployment?(
    name: string,
    namespace: string,
    replicas: number,
  ): Promise<Result<void, string>>;
  restartDeployment?(name: string, namespace: string): Promise<Result<void, string>>;
  deleteResource?(kind: string, name: string, namespace: string): Promise<Result<void, string>>;
}

export interface TerminalContext {
  simulator: CommandRuntime;
  /** Default namespace when a command omits `-n`. */
  namespace: string;
  /** Current editor file contents, keyed by path, for `kubectl apply -f <file>`. */
  files: Record<string, string>;
}

export interface CommandResult {
  output: string;
  isError: boolean;
  /** Signals emitted for the evidence engine. */
  signals: InvestigationSignal[];
  /** When true, the terminal should clear its buffer. */
  clear?: boolean;
}

type GetResource =
  | "pods"
  | "services"
  | "deployments"
  | "replicasets"
  | "endpoints"
  | "endpointslices"
  | "events"
  | "namespaces"
  | "nodes"
  | "all";

export type Command =
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "curl"; url: string }
  | { kind: "dig"; name: string }
  | {
      kind: "get";
      resource: string;
      name?: string;
      outputYaml: boolean;
      outputWide: boolean;
      namespace?: string;
      allNamespaces: boolean;
      selector?: string;
      sortByLastTimestamp: boolean;
    }
  | {
      kind: "describe";
      resource: string;
      name: string;
      namespace?: string;
    }
  | { kind: "logs"; pod: string; container?: string; namespace?: string }
  | { kind: "apply"; file: string }
  | { kind: "kustomize"; path: string }
  | { kind: "delete"; file: string }
  | { kind: "delete-resource"; manifestKind: string; name: string; namespace?: string }
  | { kind: "scale"; name: string; replicas: number; namespace?: string }
  | { kind: "rollout"; verb: "status" | "restart" | "history"; name: string; namespace?: string }
  | { kind: "exec"; pod: string; container?: string; argv: string[]; namespace?: string }
  | { kind: "create-namespace"; name: string }
  | { kind: "unsupported"; message: string };

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

/** Split a command line into tokens, honoring single and double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

const GET_RESOURCE_ALIASES: Record<string, GetResource> = {
  pod: "pods",
  pods: "pods",
  po: "pods",
  svc: "services",
  service: "services",
  services: "services",
  deploy: "deployments",
  deployment: "deployments",
  deployments: "deployments",
  rs: "replicasets",
  replicaset: "replicasets",
  replicasets: "replicasets",
  ep: "endpoints",
  endpoint: "endpoints",
  endpoints: "endpoints",
  endpointslice: "endpointslices",
  endpointslices: "endpointslices",
  eps: "endpointslices",
  event: "events",
  events: "events",
  ev: "events",
  ns: "namespaces",
  namespace: "namespaces",
  namespaces: "namespaces",
  node: "nodes",
  nodes: "nodes",
  no: "nodes",
  all: "all",
};

/** Manifest kinds for `kubectl delete <resource> <name>` and `-o yaml` lookups. */
const MANIFEST_KINDS: Partial<Record<GetResource, string>> = {
  pods: "Pod",
  services: "Service",
  deployments: "Deployment",
  replicasets: "ReplicaSet",
  namespaces: "Namespace",
  nodes: "Node",
};

interface ParsedArgs {
  positionals: string[];
  outputYaml: boolean;
  outputWide: boolean;
  namespace?: string;
  allNamespaces: boolean;
  selector?: string;
  container?: string;
  file?: string;
  replicas?: number;
  sortByLastTimestamp: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const parsed: ParsedArgs = {
    positionals,
    outputYaml: false,
    outputWide: false,
    allNamespaces: false,
    sortByLastTimestamp: false,
  };
  const setOutput = (value: string | undefined) => {
    if (value !== "yaml" && value !== "wide")
      throw new Error(
        `Output format ${JSON.stringify(value)} is not supported. Use -o yaml or -o wide.`,
      );
    parsed.outputYaml = value === "yaml";
    parsed.outputWide = value === "wide";
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (
      [
        "-o",
        "--output",
        "-n",
        "--namespace",
        "-l",
        "--selector",
        "-c",
        "--container",
        "-f",
        "--filename",
        "--replicas",
        "--sort-by",
      ].includes(arg) &&
      (!args[i + 1] || args[i + 1]!.startsWith("-"))
    )
      throw new Error(`${arg} requires a value.`);
    if (arg === "-o" || arg === "--output") {
      setOutput(args[++i]);
    } else if (arg.startsWith("-o=") || arg.startsWith("--output=")) {
      setOutput(arg.split("=")[1]);
    } else if (arg === "-oyaml") {
      parsed.outputYaml = true;
    } else if (arg === "-owide") {
      parsed.outputWide = true;
    } else if (arg === "-n" || arg === "--namespace") {
      parsed.namespace = args[++i];
    } else if (arg.startsWith("--namespace=")) {
      parsed.namespace = arg.split("=")[1];
    } else if (arg === "-A" || arg === "--all-namespaces") {
      parsed.allNamespaces = true;
    } else if (arg === "-l" || arg === "--selector") {
      parsed.selector = args[++i];
    } else if (arg.startsWith("-l=") || arg.startsWith("--selector=")) {
      parsed.selector = arg.split("=").slice(1).join("=");
    } else if (arg === "-c" || arg === "--container") {
      parsed.container = args[++i];
    } else if (arg === "-f" || arg === "--filename") {
      parsed.file = args[++i];
    } else if (arg.startsWith("-f=") || arg.startsWith("--filename=")) {
      parsed.file = arg.split("=")[1];
    } else if (arg === "--replicas") {
      parsed.replicas = Number(args[++i]);
    } else if (arg.startsWith("--replicas=")) {
      parsed.replicas = Number(arg.split("=")[1]);
    } else if (arg === "--sort-by" || arg.startsWith("--sort-by=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (value !== ".lastTimestamp")
        throw new Error("Only --sort-by=.lastTimestamp is supported.");
      parsed.sortByLastTimestamp = true;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    } else {
      throw new Error(
        `Unsupported option ${arg}. Type help to see the supported command contract.`,
      );
    }
  }
  return parsed;
}

function parseFor(
  args: string[],
  allowed: readonly (keyof ParsedArgs)[],
  maxPositionals: number,
): ParsedArgs {
  const parsed = parseArgs(args);
  for (const [field, value] of Object.entries(parsed)) {
    if (
      field !== "positionals" &&
      value !== false &&
      value !== undefined &&
      !allowed.includes(field as keyof ParsedArgs)
    )
      throw new Error(
        `The ${field} option is not supported for this command. Type help for supported commands.`,
      );
  }
  if (parsed.positionals.length > maxPositionals)
    throw new Error("Too many arguments for this command.");
  return parsed;
}

/**
 * Match labels against an equality-based selector: `k=v`, `k==v`, `k!=v`, or a bare
 * key (existence), comma-separated. Set-based expressions (`in`, `notin`) are not
 * supported: the parse simply fails the match, mirroring "no results".
 */
export function matchesLabelSelector(
  labels: Record<string, string> | undefined,
  selector: string,
): boolean {
  const have = labels ?? {};
  return selector.split(",").every((term) => {
    const clause = term.trim();
    if (!clause) return true;
    const notEqual = clause.match(/^([^!=]+)!=(.*)$/);
    if (notEqual) return have[notEqual[1]!.trim()] !== notEqual[2]!.trim();
    const equal = clause.match(/^([^!=]+)==?(.*)$/);
    if (equal) return have[equal[1]!.trim()] === equal[2]!.trim();
    return clause in have;
  });
}

export function parseCommand(line: string): Command {
  try {
    return parseCommandUnchecked(line);
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : "Unsupported command options");
  }
}

function parseCommandUnchecked(line: string): Command {
  const tokens = tokenize(line.trim());
  const head = tokens[0];
  if (!head) return { kind: "unsupported", message: "" };

  switch (head) {
    case "clear":
      return { kind: "clear" };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "curl": {
      const url = parseFor(tokens.slice(1), [], 1).positionals[0];
      if (!url) return unsupported("curl: no URL specified. Try: curl http://web-svc/");
      return { kind: "curl", url };
    }
    case "dig": {
      const name = parseFor(tokens.slice(1), [], 1).positionals[0];
      if (!name) return unsupported("dig: no name specified. Try: dig web-svc");
      return { kind: "dig", name };
    }
    case "kubectl":
    case "k":
      return parseKubectl(tokens.slice(1));
    default:
      return unsupported(
        `${head}: command not found. This is a simulated shell: type 'help' for supported commands.`,
      );
  }
}

function parseKubectl(args: string[]): Command {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "get": {
      const parsed = parseFor(
        rest,
        [
          "namespace",
          "outputYaml",
          "outputWide",
          "allNamespaces",
          "selector",
          "sortByLastTimestamp",
        ],
        2,
      );
      const resourceToken = parsed.positionals[0];
      if (!resourceToken)
        return unsupported("kubectl get: specify a resource, e.g. 'kubectl get pods'.");
      // Known resources use the strongly-rendered core views. Fixture-backed
      // incidents can also expose arbitrary Kubernetes APIs (CRDs, StorageClasses,
      // admission webhooks, operator resources), which keep their normalized token.
      const resource =
        GET_RESOURCE_ALIASES[resourceToken.toLowerCase()] ?? resourceToken.toLowerCase();
      if (parsed.sortByLastTimestamp && resource !== "events")
        return unsupported("Sorting by lastTimestamp is only supported for events.");
      return {
        kind: "get",
        resource,
        name: parsed.positionals[1],
        outputYaml: parsed.outputYaml,
        outputWide: parsed.outputWide,
        namespace: parsed.namespace,
        allNamespaces: parsed.allNamespaces,
        selector: parsed.selector,
        sortByLastTimestamp: parsed.sortByLastTimestamp,
      };
    }
    case "describe": {
      const parsed = parseFor(rest, ["namespace"], 2);
      const typeToken = (parsed.positionals[0] ?? "").toLowerCase();
      const name = parsed.positionals[1];
      const describable: Partial<Record<GetResource, string>> = {
        pods: "pod",
        services: "service",
        deployments: "deployment",
        replicasets: "replicaset",
        namespaces: "namespace",
        nodes: "node",
      };
      const alias = GET_RESOURCE_ALIASES[typeToken];
      const resource = alias ? (describable[alias] ?? typeToken) : typeToken;
      if (!resource) return unsupported("kubectl describe: specify a resource type.");
      if (!name) return unsupported(`kubectl describe ${typeToken}: specify a name.`);
      return { kind: "describe", resource, name, namespace: parsed.namespace };
    }
    case "scale": {
      const parsed = parseFor(rest, ["namespace", "replicas"], 2);
      const target = parseKindNameTarget(parsed.positionals, "deployments");
      if (!target || target.resource !== "deployments") {
        return unsupported(
          "kubectl scale: specify a deployment, e.g. 'kubectl scale deployment web --replicas=3'.",
        );
      }
      if (
        parsed.replicas === undefined ||
        !Number.isInteger(parsed.replicas) ||
        parsed.replicas < 0 ||
        parsed.replicas > 50
      ) {
        return unsupported(
          "kubectl scale: this learning runtime supports --replicas between 0 and 50.",
        );
      }
      return {
        kind: "scale",
        name: target.name,
        replicas: parsed.replicas,
        namespace: parsed.namespace,
      };
    }
    case "rollout": {
      const verb = rest[0];
      if (verb !== "status" && verb !== "restart" && verb !== "history") {
        return unsupported("kubectl rollout: supported verbs are status, restart, history.");
      }
      const parsed = parseFor(rest.slice(1), ["namespace"], 2);
      const target = parseKindNameTarget(parsed.positionals, "deployments");
      if (!target || target.resource !== "deployments") {
        return unsupported(
          `kubectl rollout ${verb}: specify a deployment, e.g. 'kubectl rollout ${verb} deployment/web'.`,
        );
      }
      return { kind: "rollout", verb, name: target.name, namespace: parsed.namespace };
    }
    case "exec": {
      // `--` separates kubectl flags from the command to run inside the container.
      const separator = rest.indexOf("--");
      const own = separator === -1 ? rest : rest.slice(0, separator);
      const argv = separator === -1 ? [] : rest.slice(separator + 1);
      // Tolerate the ubiquitous -it/-i/-t; this terminal is not a TTY either way.
      const parsed = parseFor(
        own.filter((a) => !["-it", "-ti", "-i", "-t"].includes(a)),
        ["namespace", "container"],
        1,
      );
      const pod = parsed.positionals[0];
      if (!pod || argv.length === 0) {
        return unsupported(
          "kubectl exec: usage 'kubectl exec <pod> [-c <container>] -- <command>', e.g. 'kubectl exec web -- env'.",
        );
      }
      return { kind: "exec", pod, container: parsed.container, argv, namespace: parsed.namespace };
    }
    case "create": {
      const parsed = parseFor(rest, [], 2);
      const what = (parsed.positionals[0] ?? "").toLowerCase();
      const name = parsed.positionals[1];
      if (GET_RESOURCE_ALIASES[what] !== "namespaces") {
        return unsupported(
          "kubectl create: only 'kubectl create namespace <name>' is supported: apply a manifest for anything else.",
        );
      }
      if (!name) return unsupported("kubectl create namespace: specify a name.");
      return { kind: "create-namespace", name };
    }
    case "logs": {
      const parsed = parseFor(rest, ["namespace", "container"], 1);
      const pod = parsed.positionals[0];
      if (!pod) return unsupported("kubectl logs: specify a pod name.");
      return { kind: "logs", pod, container: parsed.container, namespace: parsed.namespace };
    }
    case "apply": {
      const file = parseFor(rest, ["file"], 0).file;
      if (!file)
        return unsupported(
          "kubectl apply: specify a file with -f, e.g. 'kubectl apply -f deployment.yaml'.",
        );
      return { kind: "apply", file };
    }
    case "kustomize": {
      const path = parseFor(rest, [], 1).positionals[0];
      if (!path) {
        return unsupported(
          "kubectl kustomize: specify a directory, e.g. 'kubectl kustomize overlays/production'.",
        );
      }
      return { kind: "kustomize", path };
    }
    case "delete": {
      const parsed = parseFor(rest, ["namespace", "file"], 2);
      if (parsed.file && (parsed.namespace || parsed.positionals.length))
        return unsupported(
          "delete -f uses the namespaces in the file and does not accept additional targets or options.",
        );
      if (parsed.file) return { kind: "delete", file: parsed.file };
      // `kubectl delete <resource> <name>` / `<resource>/<name>`
      const target = parseKindNameTarget(parsed.positionals);
      const manifestKind = target ? MANIFEST_KINDS[target.resource] : undefined;
      if (!target || !manifestKind) {
        return unsupported(
          "kubectl delete: use 'kubectl delete <pod|svc|deploy|rs|ns|node> <name>' or '-f <file>'.",
        );
      }
      return {
        kind: "delete-resource",
        manifestKind,
        name: target.name,
        namespace: parsed.namespace,
      };
    }
    default:
      return unsupported(
        `kubectl ${sub ?? ""}: unsupported subcommand. Supported: get, describe, logs, exec, scale, rollout, create, apply, delete, kustomize.`,
      );
  }
}

/** Parse `<kind> <name>` or `<kind>/<name>` positionals into a resource + name. */
function parseKindNameTarget(
  positionals: string[],
  expect?: GetResource,
): { resource: GetResource; name: string } | null {
  const first = positionals[0] ?? "";
  let kindToken: string;
  let name: string | undefined;
  if (first.includes("/")) {
    const [k, n] = first.split("/");
    kindToken = k ?? "";
    name = n;
  } else {
    kindToken = first;
    name = positionals[1];
  }
  const resource = GET_RESOURCE_ALIASES[kindToken.toLowerCase()];
  if (!resource || !name) return null;
  if (expect && resource !== expect) return null;
  return { resource, name };
}

function unsupported(message: string): Command {
  return { kind: "unsupported", message };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function runCommandLine(line: string, ctx: TerminalContext): Promise<CommandResult> {
  return executeCommand(parseCommand(line), line, ctx);
}

export async function executeCommand(
  command: Command,
  rawLine: string,
  ctx: TerminalContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "clear":
      return { output: "", isError: false, signals: [], clear: true };
    case "help":
      return { output: HELP_TEXT, isError: false, signals: [] };
    case "curl":
      return runCurl(command.url, ctx);
    case "dig":
      return runDig(command.name, ctx);
    case "get":
      return runGet(command, rawLine, ctx);
    case "describe":
      return runDescribe(command, rawLine, ctx);
    case "logs":
      return runLogs(command, rawLine, ctx);
    case "apply":
      return runApply(command.file, ctx);
    case "kustomize":
      return runKustomize(command.path, ctx);
    case "delete":
      return runDelete(command.file, ctx);
    case "delete-resource":
      return runDeleteResource(command, ctx);
    case "scale":
      return runScale(command, ctx);
    case "rollout":
      return runRollout(command, rawLine, ctx);
    case "exec":
      return runExec(command, rawLine, ctx);
    case "create-namespace":
      return runCreateNamespace(command.name, ctx);
    case "unsupported":
      return { output: command.message, isError: command.message !== "", signals: [] };
  }
}

async function runCurl(url: string, ctx: TerminalContext): Promise<CommandResult> {
  const result = await ctx.simulator.probe(url, ctx.namespace);
  const signals: InvestigationSignal[] = [createProbeSignal(url, result)];
  if (result.status === 0) {
    return {
      output: `curl: could not connect to ${url}${result.reason ? `\n${result.reason}` : ""}`,
      isError: true,
      signals,
    };
  }
  const body = result.body.trimEnd();
  return {
    output: `HTTP ${result.status}\n${body}`.trimEnd(),
    isError: false,
    signals,
  };
}

function runDig(name: string, ctx: TerminalContext): CommandResult {
  const snapshot = ctx.simulator.getSnapshot();
  const query = parseServiceDnsName(name, ctx.namespace);
  const service = snapshot.services.find(
    (s) =>
      query !== null &&
      s.metadata?.name === query.service &&
      (s.metadata?.namespace ?? "default") === query.namespace,
  );
  if (!service?.spec?.clusterIP) {
    const output = [
      `; <<>> ${BRAND.name} dig <<>> ${name}`,
      ";; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN",
      ";; QUESTION SECTION:",
      `;${name}.\tIN\tA`,
    ].join("\n");
    return {
      output,
      isError: false,
      signals: [{ type: "command", command: `dig ${name}`, output: "NXDOMAIN" }],
    };
  }
  const fqdn = `${service.metadata?.name}.${service.metadata?.namespace}.svc.cluster.local`;
  const output = [
    `; <<>> ${BRAND.name} dig <<>> ${name}`,
    ";; ANSWER SECTION:",
    `${fqdn}\t30\tIN\tA\t${service.spec.clusterIP}`,
  ].join("\n");
  return { output, isError: false, signals: [{ type: "command", command: `dig ${name}`, output }] };
}

/** Resolve the Service DNS forms Kubernetes exposes inside a Pod search domain. */
function parseServiceDnsName(
  rawName: string,
  defaultNamespace: string,
): { service: string; namespace: string } | null {
  const parts = rawName.replace(/\.$/, "").split(".");
  if (parts.length === 1 && parts[0]) {
    return { service: parts[0], namespace: defaultNamespace };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { service: parts[0], namespace: parts[1] };
  }
  const validSuffix =
    parts[2] === "svc" &&
    (parts.length === 3 || (parts.length === 5 && parts[3] === "cluster" && parts[4] === "local"));
  return validSuffix && parts[0] && parts[1] ? { service: parts[0], namespace: parts[1] } : null;
}

function runGet(
  command: Extract<Command, { kind: "get" }>,
  rawLine: string,
  ctx: TerminalContext,
): CommandResult {
  const snapshot = ctx.simulator.getSnapshot();
  const namespace = command.namespace ?? ctx.namespace;
  const output = renderGet(command, namespace, snapshot);
  return {
    output,
    isError: false,
    signals: buildGetSignals(command, rawLine, output, snapshot, namespace),
  };
}

interface RenderOpts {
  /** Prefix a NAMESPACE column (kubectl -A behavior). */
  showNamespace: boolean;
  /** -o wide: extra columns where kubectl has them. */
  wide: boolean;
}

function renderGet(
  command: Extract<Command, { kind: "get" }>,
  namespace: string,
  snapshot: ClusterSnapshot,
): string {
  const { resource, name, outputYaml, outputWide, allNamespaces, selector } = command;

  if (outputYaml && name) {
    const object = findByName(resource, name, namespace, snapshot);
    if (!object) return notFound(resource, name, namespace);
    return stringifyManifest(object);
  }

  const opts: RenderOpts = { showNamespace: allNamespaces, wide: outputWide };
  const pick = <
    T extends { metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } },
  >(
    items: T[],
  ): T[] => scopeItems(items, { namespace, allNamespaces, name, selector });

  switch (resource) {
    case "pods":
      return renderPods(pick(snapshot.pods), opts);
    case "services":
      return renderServices(pick(snapshot.services), opts);
    case "deployments":
      return renderDeployments(pick(snapshot.deployments), opts);
    case "replicasets":
      return renderReplicaSets(pick(snapshot.replicaSets), opts);
    case "endpoints":
      return renderEndpoints(pick(snapshot.services), snapshot, opts);
    case "endpointslices":
      return renderEndpointSlices(pick(snapshot.endpointSlices), opts);
    case "events":
      return renderEvents(snapshot.events, namespace, command.sortByLastTimestamp, allNamespaces);
    case "namespaces":
      return renderNamespaces(clusterScoped(snapshot.namespaces, name, selector));
    case "nodes":
      return renderNodes(clusterScoped(snapshot.nodes, name, selector), snapshot);
    case "all":
      return [
        renderPods(pick(snapshot.pods), opts),
        "",
        renderServices(pick(snapshot.services), opts),
        "",
        renderDeployments(pick(snapshot.deployments), opts),
        "",
        renderReplicaSets(pick(snapshot.replicaSets), opts),
      ].join("\n");
    default:
      return renderGenericResources(pick(genericResourcesFor(snapshot, resource)), opts);
  }
}

function renderGenericResources(
  resources: NonNullable<ClusterSnapshot["resources"]>,
  opts: RenderOpts,
): string {
  if (resources.length === 0) return "No resources found.";
  const rows = resources.map((resource) => {
    const cells = [resource.metadata.name, resource.kind, resource.apiVersion];
    return { namespace: resource.metadata.namespace ?? "default", cells };
  });
  return withNamespaceColumn(opts, ["NAME", "KIND", "API-VERSION"], rows);
}

function withNamespaceColumn(
  opts: RenderOpts,
  headers: string[],
  rows: { namespace: string; cells: string[] }[],
): string {
  if (!opts.showNamespace)
    return formatTable(
      headers,
      rows.map((r) => r.cells),
    );
  return formatTable(
    ["NAMESPACE", ...headers],
    rows.map((r) => [r.namespace, ...r.cells]),
  );
}

function renderPods(pods: V1Pod[], opts: RenderOpts): string {
  if (pods.length === 0) return "No resources found.";
  const rows = pods.map((pod) => {
    const { ready, total } = podReadyCounts(pod);
    const cells = [
      pod.metadata?.name ?? "<unknown>",
      `${ready}/${total}`,
      podPhase(pod),
      String(podRestarts(pod)),
      humanizeAge(pod.metadata?.creationTimestamp),
    ];
    if (opts.wide) {
      cells.push(pod.status?.podIP ?? "<none>", pod.spec?.nodeName ?? "<none>");
    }
    return { namespace: pod.metadata?.namespace ?? "default", cells };
  });
  const headers = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
  if (opts.wide) headers.push("IP", "NODE");
  return withNamespaceColumn(opts, headers, rows);
}

function renderServices(services: V1Service[], opts: RenderOpts): string {
  if (services.length === 0) return "No resources found.";
  const rows = services.map((svc) => {
    const cells = [
      svc.metadata?.name ?? "<unknown>",
      svc.spec?.type ?? "ClusterIP",
      svc.spec?.clusterIP ?? "<none>",
      "<none>",
      servicePortsSummary(svc),
      humanizeAge(svc.metadata?.creationTimestamp),
    ];
    if (opts.wide) cells.push(formatSelector(svc.spec?.selector));
    return { namespace: svc.metadata?.namespace ?? "default", cells };
  });
  const headers = ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"];
  if (opts.wide) headers.push("SELECTOR");
  return withNamespaceColumn(opts, headers, rows);
}

function renderDeployments(deployments: ClusterSnapshot["deployments"], opts: RenderOpts): string {
  if (deployments.length === 0) return "No resources found.";
  const rows = deployments.map((d) => ({
    namespace: d.metadata?.namespace ?? "default",
    cells: [
      d.metadata?.name ?? "<unknown>",
      `${deploymentReadyReplicas(d)}/${d.spec?.replicas ?? 0}`,
      String(d.status?.updatedReplicas ?? 0),
      String(d.status?.availableReplicas ?? 0),
      humanizeAge(d.metadata?.creationTimestamp),
    ],
  }));
  return withNamespaceColumn(opts, ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"], rows);
}

function renderReplicaSets(replicaSets: ClusterSnapshot["replicaSets"], opts: RenderOpts): string {
  if (replicaSets.length === 0) return "No resources found.";
  const rows = replicaSets.map((rs) => ({
    namespace: rs.metadata?.namespace ?? "default",
    cells: [
      rs.metadata?.name ?? "<unknown>",
      String(rs.spec?.replicas ?? 0),
      String(rs.status?.replicas ?? 0),
      String(rs.status?.readyReplicas ?? 0),
      humanizeAge(rs.metadata?.creationTimestamp),
    ],
  }));
  return withNamespaceColumn(opts, ["NAME", "DESIRED", "CURRENT", "READY", "AGE"], rows);
}

function renderEndpoints(
  services: V1Service[],
  snapshot: ClusterSnapshot,
  opts: RenderOpts,
): string {
  if (services.length === 0) return "No resources found.";
  const rows = services.map((svc) => {
    const addresses = readyAddresses(svc, snapshot);
    return {
      namespace: svc.metadata?.namespace ?? "default",
      cells: [
        svc.metadata?.name ?? "<unknown>",
        addresses.length > 0 ? addresses.join(",") : "<none>",
        humanizeAge(svc.metadata?.creationTimestamp),
      ],
    };
  });
  return withNamespaceColumn(opts, ["NAME", "ENDPOINTS", "AGE"], rows);
}

function renderNamespaces(namespaces: ClusterSnapshot["namespaces"]): string {
  if (namespaces.length === 0) return "No resources found.";
  const rows = namespaces.map((n) => [
    n.metadata?.name ?? "<unknown>",
    n.status?.phase ?? "Active",
    humanizeAge(n.metadata?.creationTimestamp),
  ]);
  return formatTable(["NAME", "STATUS", "AGE"], rows);
}

function renderNodes(nodes: V1Node[], snapshot: ClusterSnapshot): string {
  if (nodes.length === 0) return "No resources found.";
  const rows = nodes.map((node) => {
    const name = node.metadata?.name ?? "<unknown>";
    const ready = (node.status?.conditions ?? []).find((c) => c.type === "Ready");
    const roles = Object.keys(node.metadata?.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.split("/")[1])
      .filter(Boolean)
      .join(",");
    const podCount = snapshot.pods.filter((p) => p.spec?.nodeName === name).length;
    return [
      name,
      ready?.status === "True" ? "Ready" : "NotReady",
      roles || "<none>",
      String(podCount),
      humanizeAge(node.metadata?.creationTimestamp),
      node.status?.nodeInfo?.kubeletVersion ?? "<unknown>",
    ];
  });
  return formatTable(["NAME", "STATUS", "ROLES", "PODS", "AGE", "VERSION"], rows);
}

function renderEndpointSlices(slices: ClusterSnapshot["endpointSlices"], opts: RenderOpts): string {
  if (slices.length === 0) return "No resources found.";
  const rows = slices.map((slice) => {
    const ports = (slice.ports ?? []).map((p) => String(p.port ?? "")).join(",") || "<none>";
    const addresses = (slice.endpoints ?? []).flatMap((e) => e.addresses ?? []);
    return {
      namespace: slice.metadata?.namespace ?? "default",
      cells: [
        slice.metadata?.name ?? "<unknown>",
        slice.addressType ?? "IPv4",
        ports,
        addresses.length > 0 ? addresses.join(",") : "<none>",
        humanizeAge(slice.metadata?.creationTimestamp),
      ],
    };
  });
  return withNamespaceColumn(opts, ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"], rows);
}

function renderEvents(
  events: CoreV1Event[],
  namespace: string,
  sortByLastTimestamp: boolean,
  allNamespaces = false,
): string {
  const filtered = allNamespaces
    ? events
    : events.filter((e) => (e.metadata?.namespace ?? "default") === namespace);
  if (filtered.length === 0) return "No events found.";
  const sorted = sortByLastTimestamp
    ? [...filtered].sort((a, b) => timeOf(a) - timeOf(b))
    : filtered;
  const rows = sorted.map((e) => {
    const cells = [
      eventAge(e),
      e.type ?? "Normal",
      e.reason ?? "",
      `${e.involvedObject?.kind ?? ""}/${e.involvedObject?.name ?? ""}`,
      e.message ?? "",
    ];
    return allNamespaces ? [e.metadata?.namespace ?? "default", ...cells] : cells;
  });
  const headers = ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"];
  return formatTable(allNamespaces ? ["NAMESPACE", ...headers] : headers, rows);
}

function runDescribe(
  command: Extract<Command, { kind: "describe" }>,
  rawLine: string,
  ctx: TerminalContext,
): CommandResult {
  const snapshot = ctx.simulator.getSnapshot();
  const namespace = command.namespace ?? ctx.namespace;
  const named = <T extends { metadata?: { name?: string; namespace?: string } }>(
    items: T[],
    namespaced = true,
  ): T | undefined =>
    items.find(
      (item) =>
        item.metadata?.name === command.name &&
        (!namespaced || (item.metadata?.namespace ?? "default") === namespace),
    );
  const generic = () => findGenericResource(snapshot, command.resource, command.name, namespace);
  const missingOrGeneric = () => {
    const resource = generic();
    return resource
      ? describeGenericResource(resource, snapshot)
      : notFound(command.resource, command.name, namespace);
  };

  let output: string;
  switch (command.resource) {
    case "pod": {
      const pod = named(snapshot.pods);
      output = pod ? describePod(pod, snapshot) : missingOrGeneric();
      break;
    }
    case "service": {
      const svc = named(snapshot.services);
      output = svc ? describeService(svc, snapshot) : missingOrGeneric();
      break;
    }
    case "deployment": {
      const dep = named(snapshot.deployments);
      output = dep ? describeDeployment(dep, snapshot) : missingOrGeneric();
      break;
    }
    case "replicaset": {
      const rs = named(snapshot.replicaSets);
      output = rs ? describeReplicaSet(rs, snapshot) : missingOrGeneric();
      break;
    }
    case "namespace": {
      const ns = named(snapshot.namespaces, false);
      output = ns ? describeNamespace(ns, snapshot) : missingOrGeneric();
      break;
    }
    case "node": {
      const node = named(snapshot.nodes, false);
      output = node ? describeNode(node, snapshot) : missingOrGeneric();
      break;
    }
    default: {
      const resource = findGenericResource(snapshot, command.resource, command.name, namespace);
      output = resource
        ? describeGenericResource(resource, snapshot)
        : notFound(command.resource, command.name, namespace);
      break;
    }
  }
  return {
    output,
    isError: false,
    signals: [{ type: "command", command: rawLine, output }],
  };
}

function describeGenericResource(
  resource: NonNullable<ClusterSnapshot["resources"]>[number],
  snapshot: ClusterSnapshot,
): string {
  const namespace = resource.metadata.namespace ?? "default";
  const lines = [
    `Name:               ${resource.metadata.name}`,
    `Namespace:          ${namespace}`,
    `Kind:               ${resource.kind}`,
    `API Version:        ${resource.apiVersion}`,
    `Labels:             ${formatSelector(resource.metadata.labels)}`,
    "Manifest:",
    ...stringifyManifest(resource)
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`),
  ];
  const events = relatedEvents(snapshot.events, resource.metadata.name);
  if (events.length > 0) {
    lines.push("Events:");
    for (const event of events) {
      lines.push(`  ${event.type ?? "Normal"}  ${event.reason ?? ""}  ${event.message ?? ""}`);
    }
  }
  return lines.join("\n");
}

function describeDeployment(dep: V1Deployment, snapshot: ClusterSnapshot): string {
  const name = dep.metadata?.name ?? "<unknown>";
  const strategy = dep.spec?.strategy?.type ?? "RollingUpdate";
  const rolling = dep.spec?.strategy?.rollingUpdate;
  const lines = [
    `Name:               ${name}`,
    `Namespace:          ${dep.metadata?.namespace ?? "default"}`,
    `Labels:             ${formatSelector(dep.metadata?.labels)}`,
    `Selector:           ${formatSelector(dep.spec?.selector?.matchLabels)}`,
    `Replicas:           ${dep.spec?.replicas ?? 0} desired | ${dep.status?.updatedReplicas ?? 0} updated | ${dep.status?.replicas ?? 0} total | ${dep.status?.availableReplicas ?? 0} available`,
    `StrategyType:       ${strategy}`,
  ];
  if (strategy === "RollingUpdate" && rolling) {
    lines.push(
      `RollingUpdateStrategy:  ${String(rolling.maxUnavailable ?? "25%")} max unavailable, ${String(rolling.maxSurge ?? "25%")} max surge`,
    );
  }
  const images = (dep.spec?.template?.spec?.containers ?? [])
    .map((c) => c.image)
    .filter(Boolean)
    .join(", ");
  if (images) lines.push(`Image(s):           ${images}`);
  const conditions = dep.status?.conditions ?? [];
  if (conditions.length > 0) {
    lines.push("Conditions:", "  Type           Status  Reason");
    for (const c of conditions) {
      lines.push(`  ${(c.type ?? "").padEnd(15)}${(c.status ?? "").padEnd(8)}${c.reason ?? ""}`);
    }
  }
  const events = relatedEvents(snapshot.events, name);
  if (events.length > 0) {
    lines.push("Events:");
    for (const e of events)
      lines.push(`  ${e.type ?? "Normal"}  ${e.reason ?? ""}  ${e.message ?? ""}`);
  }
  return lines.join("\n");
}

function describeReplicaSet(rs: V1ReplicaSet, snapshot: ClusterSnapshot): string {
  const name = rs.metadata?.name ?? "<unknown>";
  const owner = (rs.metadata?.ownerReferences ?? [])[0];
  const lines = [
    `Name:               ${name}`,
    `Namespace:          ${rs.metadata?.namespace ?? "default"}`,
    `Selector:           ${formatSelector(rs.spec?.selector?.matchLabels)}`,
    `Labels:             ${formatSelector(rs.metadata?.labels)}`,
    `Controlled By:      ${owner ? `${owner.kind}/${owner.name}` : "<none>"}`,
    `Replicas:           ${rs.status?.replicas ?? 0} current / ${rs.spec?.replicas ?? 0} desired`,
    `Pods Status:        ${rs.status?.readyReplicas ?? 0} ready`,
  ];
  const events = relatedEvents(snapshot.events, name);
  if (events.length > 0) {
    lines.push("Events:");
    for (const e of events)
      lines.push(`  ${e.type ?? "Normal"}  ${e.reason ?? ""}  ${e.message ?? ""}`);
  }
  return lines.join("\n");
}

function describeNamespace(
  ns: ClusterSnapshot["namespaces"][number],
  snapshot: ClusterSnapshot,
): string {
  const name = ns.metadata?.name ?? "<unknown>";
  const podCount = snapshot.pods.filter(
    (p) => (p.metadata?.namespace ?? "default") === name,
  ).length;
  const svcCount = snapshot.services.filter(
    (s) => (s.metadata?.namespace ?? "default") === name,
  ).length;
  return [
    `Name:         ${name}`,
    `Labels:       ${formatSelector(ns.metadata?.labels)}`,
    `Status:       ${ns.status?.phase ?? "Active"}`,
    "",
    `Resources in namespace: ${podCount} pod(s), ${svcCount} service(s)`,
    "",
    "No resource quota.",
    "No LimitRange resource.",
  ].join("\n");
}

function describeNode(node: V1Node, snapshot: ClusterSnapshot): string {
  const name = node.metadata?.name ?? "<unknown>";
  const lines = [
    `Name:               ${name}`,
    `Labels:             ${formatSelector(node.metadata?.labels)}`,
    `Kubelet Version:    ${node.status?.nodeInfo?.kubeletVersion ?? "<unknown>"}`,
    `Pod CIDR:           ${node.spec?.podCIDR ?? "<none>"}`,
  ];
  const conditions = node.status?.conditions ?? [];
  if (conditions.length > 0) {
    lines.push("Conditions:", "  Type    Status");
    for (const c of conditions) lines.push(`  ${(c.type ?? "").padEnd(8)}${c.status ?? ""}`);
  }
  const pods = snapshot.pods.filter((p) => p.spec?.nodeName === name);
  lines.push(`Non-terminated Pods:  (${pods.length} in total)`);
  for (const p of pods) {
    lines.push(`  ${p.metadata?.namespace ?? "default"}/${p.metadata?.name ?? "<unknown>"}`);
  }
  return lines.join("\n");
}

function describePod(pod: V1Pod, snapshot: ClusterSnapshot): string {
  const name = pod.metadata?.name ?? "<unknown>";
  const readyCond = (pod.status?.conditions ?? []).find((c) => c.type === "Ready");
  const lines = [
    `Name:             ${name}`,
    `Namespace:        ${pod.metadata?.namespace ?? "default"}`,
    `Node:             ${pod.spec?.nodeName ?? "<none>"}`,
    `Status:           ${podPhase(pod)}`,
    `IP:               ${pod.status?.podIP ?? "<none>"}`,
    `Labels:           ${formatSelector(pod.metadata?.labels)}`,
    `Termination Grace Period: ${pod.spec?.terminationGracePeriodSeconds ?? 30}s`,
    "Containers:",
  ];

  for (const container of pod.spec?.containers ?? []) {
    const status = (pod.status?.containerStatuses ?? []).find(
      (candidate) => candidate.name === container.name,
    );
    lines.push(
      `  ${container.name}:`,
      `    Image:          ${container.image ?? "<none>"}`,
      `    Port:           ${containerPortsSummary(container)}`,
      `    Ready:          ${status?.ready ? "True" : "False"}`,
      `    Restart Count:  ${status?.restartCount ?? 0}`,
    );
    if ((container.command ?? []).length > 0) {
      lines.push(`    Command:        ${container.command!.join(" ")}`);
    }
    if ((container.args ?? []).length > 0) {
      lines.push(`    Args:           ${container.args!.join(" ")}`);
    }
    if (container.lifecycle?.preStop?.exec?.command?.length) {
      lines.push(`    PreStop:        exec ${container.lifecycle.preStop.exec.command.join(" ")}`);
    }
    const env = container.env ?? [];
    if (env.length > 0) {
      lines.push("    Environment:");
      for (const entry of env) {
        lines.push(`      ${entry.name}:  ${entry.value ?? "<set from source>"}`);
      }
    }
    if (container.startupProbe?.httpGet) {
      const probe = container.startupProbe.httpGet;
      lines.push(
        `    Startup:        http-get ${probe.path ?? "/"} port ${String(probe.port ?? "")}`,
      );
    }
    if (container.readinessProbe?.httpGet) {
      const probe = container.readinessProbe.httpGet;
      lines.push(
        `    Readiness:      http-get ${probe.path ?? "/"} port ${String(probe.port ?? "")}`,
      );
    }
    if (container.livenessProbe?.httpGet) {
      const probe = container.livenessProbe.httpGet;
      lines.push(
        `    Liveness:       http-get ${probe.path ?? "/"} port ${String(probe.port ?? "")}`,
      );
    }
  }
  lines.push(`Conditions:`, `  Ready           ${readyCond?.status ?? "Unknown"}`);
  const events = relatedEvents(snapshot.events, name);
  if (events.length > 0) {
    lines.push("Events:");
    for (const e of events) {
      lines.push(`  ${e.type ?? "Normal"}  ${e.reason ?? ""}  ${e.message ?? ""}`);
    }
  }
  return lines.join("\n");
}

function describeService(svc: V1Service, snapshot: ClusterSnapshot): string {
  const addresses = readyAddresses(svc, snapshot);
  const targetPorts =
    (svc.spec?.ports ?? [])
      .map((p) => String(p.targetPort ?? p.port ?? ""))
      .filter(Boolean)
      .map((p) => `${p}/TCP`)
      .join(",") || "<none>";
  return [
    `Name:              ${svc.metadata?.name}`,
    `Namespace:         ${svc.metadata?.namespace ?? "default"}`,
    `Selector:          ${formatSelector(svc.spec?.selector)}`,
    `Type:              ${svc.spec?.type ?? "ClusterIP"}`,
    `IP:                ${svc.spec?.clusterIP ?? "<none>"}`,
    `Port:              ${servicePortsSummary(svc)}`,
    `TargetPort:        ${targetPorts}`,
    `Endpoints:         ${addresses.length > 0 ? addresses.join(",") : "<none>"}`,
  ].join("\n");
}

function runLogs(
  command: Extract<Command, { kind: "logs" }>,
  rawLine: string,
  ctx: TerminalContext,
): CommandResult {
  const snapshot = ctx.simulator.getSnapshot();
  const namespace = command.namespace ?? ctx.namespace;
  const pod = snapshot.pods.find(
    (p) => p.metadata?.name === command.pod && (p.metadata?.namespace ?? "default") === namespace,
  );
  if (!pod) return { output: notFound("pod", command.pod, namespace), isError: true, signals: [] };
  const lines = ctx.simulator.getLogs(namespace, command.pod, command.container);
  const output =
    lines.length > 0
      ? lines.map((l) => l.message).join("\n")
      : `No logs yet for pod/${command.pod}.`;
  return { output, isError: false, signals: [{ type: "command", command: rawLine, output }] };
}

function runKustomize(path: string, ctx: TerminalContext): CommandResult {
  const rendered = renderKustomization(path, ctx.files, new Set());
  if (!rendered.ok) {
    return { output: `error: ${rendered.error}`, isError: true, signals: [] };
  }
  const output = rendered.resources.map(stringifyManifest).join("---\n").trimEnd();
  return {
    output: output || "no resources rendered",
    isError: false,
    signals: [{ type: "command", command: `kubectl kustomize ${path}`, output }],
  };
}

type KustomizeRenderResult =
  { ok: true; resources: Record<string, unknown>[] } | { ok: false; error: string };

function renderKustomization(
  requestedPath: string,
  files: Readonly<Record<string, string>>,
  visited: Set<string>,
): KustomizeRenderResult {
  const normalized = normalizeWorkspacePath(requestedPath);
  const directory =
    normalized.endsWith(".yaml") || normalized.endsWith(".yml")
      ? workspaceDirname(normalized)
      : normalized;
  const kustomizationPath =
    files[normalized] !== undefined
      ? normalized
      : files[`${directory}/kustomization.yaml`] !== undefined
        ? `${directory}/kustomization.yaml`
        : `${directory}/kustomization.yml`;
  const source = files[kustomizationPath];
  if (source === undefined) {
    return { ok: false, error: `the kustomization path "${requestedPath}" does not exist` };
  }
  if (visited.has(kustomizationPath)) {
    return { ok: false, error: `recursive kustomization reference at "${kustomizationPath}"` };
  }
  visited.add(kustomizationPath);

  let document: unknown;
  try {
    document = load(source);
  } catch (error) {
    return { ok: false, error: `${kustomizationPath}: ${(error as Error).message}` };
  }
  const kustomization = plainObject(document);
  if (!kustomization || kustomization.kind !== "Kustomization") {
    return { ok: false, error: `${kustomizationPath} is not a Kustomization` };
  }

  const resources: Record<string, unknown>[] = [];
  for (const reference of stringValues(kustomization.resources)) {
    const resourcePath = normalizeWorkspacePath(`${directory}/${reference}`);
    const sourceFile = files[resourcePath];
    if (sourceFile === undefined) {
      const nested = renderKustomization(resourcePath, files, visited);
      if (!nested.ok) return nested;
      resources.push(...nested.resources);
      continue;
    }
    const parsed = parseKubernetesManifests(sourceFile);
    if (!parsed.ok) return { ok: false, error: `${resourcePath}: ${parsed.error.message}` };
    resources.push(...parsed.value.map((manifest) => structuredClone(manifest.raw)));
  }

  const namespace =
    typeof kustomization.namespace === "string" ? kustomization.namespace : undefined;
  for (const resource of resources) {
    if (namespace && !KUSTOMIZE_CLUSTER_SCOPED_KINDS.has(String(resource.kind ?? ""))) {
      const metadata = plainObject(resource.metadata) ?? {};
      metadata.namespace = namespace;
      resource.metadata = metadata;
    }
    applyImageTransforms(resource, kustomization.images);
  }
  visited.delete(kustomizationPath);
  return { ok: true, resources };
}

const KUSTOMIZE_CLUSTER_SCOPED_KINDS = new Set([
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "Namespace",
  "Node",
  "PersistentVolume",
  "StorageClass",
]);

function applyImageTransforms(resource: unknown, transformsValue: unknown): void {
  const transforms = Array.isArray(transformsValue)
    ? transformsValue.map(plainObject).filter((value) => value !== undefined)
    : [];
  if (transforms.length === 0) return;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = plainObject(value);
    if (!object) return;
    if (typeof object.image === "string") {
      const currentImage = object.image;
      const transform = transforms.find(
        (candidate) =>
          typeof candidate.name === "string" && imageRepository(currentImage) === candidate.name,
      );
      if (transform && typeof transform.name === "string") {
        const repository =
          typeof transform.newName === "string" ? transform.newName : transform.name;
        if (typeof transform.digest === "string")
          object.image = `${repository}@${transform.digest}`;
        else if (typeof transform.newTag === "string")
          object.image = `${repository}:${transform.newTag}`;
      }
    }
    Object.values(object).forEach(visit);
  };
  visit(resource);
}

function imageRepository(image: string): string {
  const withoutDigest = image.split("@", 1)[0] ?? image;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

function normalizeWorkspacePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function workspaceDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function runApply(file: string, ctx: TerminalContext): Promise<CommandResult> {
  const content = ctx.files[file];
  if (content === undefined) {
    return {
      output: `error: the path "${file}" does not exist. Available files: ${Object.keys(ctx.files).join(", ") || "(none)"}.`,
      isError: true,
      signals: [],
    };
  }
  if (ctx.simulator.applyWorkspace) {
    const reviewed = await ctx.simulator.applyWorkspace(ctx.files);
    if (!reviewed.ok) return { output: `error: ${reviewed.error}`, isError: true, signals: [] };
    const resources = reviewed.value.map((r) => `${r.kind.toLowerCase()}/${r.name} reviewed`);
    return {
      output: [
        `static review re-run over the submitted workspace (${Object.keys(ctx.files).length} files)`,
        ...resources,
      ].join("\n"),
      isError: false,
      signals: [],
    };
  }

  const result = await ctx.simulator.applyYaml(content);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  const output = result.value.map((r) => `${r.kind.toLowerCase()}/${r.name} configured`).join("\n");
  return { output: output || "no resources to apply", isError: false, signals: [] };
}

async function runDelete(file: string, ctx: TerminalContext): Promise<CommandResult> {
  const content = ctx.files[file];
  if (content === undefined) {
    return { output: `error: the path "${file}" does not exist.`, isError: true, signals: [] };
  }
  const result = await ctx.simulator.deleteYaml(content);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  const output = result.value.map((r) => `${r.kind.toLowerCase()}/${r.name} deleted`).join("\n");
  return { output: output || "no resources to delete", isError: false, signals: [] };
}

const CAPABILITY_UNAVAILABLE = "this command is not available in this scenario.";

async function runDeleteResource(
  command: Extract<Command, { kind: "delete-resource" }>,
  ctx: TerminalContext,
): Promise<CommandResult> {
  if (!ctx.simulator.deleteResource) {
    return { output: `kubectl delete: ${CAPABILITY_UNAVAILABLE}`, isError: true, signals: [] };
  }
  const namespace = command.namespace ?? ctx.namespace;
  const result = await ctx.simulator.deleteResource(command.manifestKind, command.name, namespace);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  return {
    output: `${command.manifestKind.toLowerCase()} "${command.name}" deleted`,
    isError: false,
    signals: [],
  };
}

async function runScale(
  command: Extract<Command, { kind: "scale" }>,
  ctx: TerminalContext,
): Promise<CommandResult> {
  if (!ctx.simulator.scaleDeployment) {
    return { output: `kubectl scale: ${CAPABILITY_UNAVAILABLE}`, isError: true, signals: [] };
  }
  const namespace = command.namespace ?? ctx.namespace;
  const result = await ctx.simulator.scaleDeployment(command.name, namespace, command.replicas);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  return { output: `deployment.apps/${command.name} scaled`, isError: false, signals: [] };
}

async function runRollout(
  command: Extract<Command, { kind: "rollout" }>,
  rawLine: string,
  ctx: TerminalContext,
): Promise<CommandResult> {
  const namespace = command.namespace ?? ctx.namespace;
  const snapshot = ctx.simulator.getSnapshot();
  const deployment = snapshot.deployments.find(
    (d) => d.metadata?.name === command.name && (d.metadata?.namespace ?? "default") === namespace,
  );
  if (!deployment) {
    return { output: notFound("deployment", command.name, namespace), isError: true, signals: [] };
  }

  if (command.verb === "restart") {
    if (!ctx.simulator.restartDeployment) {
      return {
        output: `kubectl rollout restart: ${CAPABILITY_UNAVAILABLE}`,
        isError: true,
        signals: [],
      };
    }
    const result = await ctx.simulator.restartDeployment(command.name, namespace);
    if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
    return { output: `deployment.apps/${command.name} restarted`, isError: false, signals: [] };
  }

  if (command.verb === "history") {
    const owned = snapshot.replicaSets
      .filter(
        (rs) =>
          (rs.metadata?.namespace ?? "default") === namespace &&
          (rs.metadata?.ownerReferences ?? []).some(
            (ref) => ref.kind === "Deployment" && ref.name === command.name,
          ),
      )
      .map((rs) => ({
        revision: Number(rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
        rs,
      }))
      .sort((a, b) => a.revision - b.revision);
    const rows = owned.map(({ revision, rs }) => [
      String(revision || "<none>"),
      rs.metadata?.name ?? "<unknown>",
      `${rs.status?.readyReplicas ?? 0}/${rs.spec?.replicas ?? 0} ready`,
    ]);
    const output =
      rows.length > 0
        ? `deployment.apps/${command.name}\n${formatTable(["REVISION", "REPLICASET", "STATUS"], rows)}`
        : `deployment.apps/${command.name}\nNo rollout history found.`;
    return { output, isError: false, signals: [{ type: "command", command: rawLine, output }] };
  }

  // status: mirror kubectl's phrasing from live status fields.
  const desired = deployment.spec?.replicas ?? 0;
  const updated = deployment.status?.updatedReplicas ?? 0;
  const available = deployment.status?.availableReplicas ?? 0;
  const total = deployment.status?.replicas ?? 0;
  let output: string;
  if (updated < desired) {
    output = `Waiting for deployment "${command.name}" rollout to finish: ${updated} out of ${desired} new replicas have been updated...`;
  } else if (total > updated) {
    output = `Waiting for deployment "${command.name}" rollout to finish: ${total - updated} old replicas are pending termination...`;
  } else if (available < desired) {
    output = `Waiting for deployment "${command.name}" rollout to finish: ${available} of ${desired} updated replicas are available...`;
  } else {
    output = `deployment "${command.name}" successfully rolled out`;
  }
  return { output, isError: false, signals: [{ type: "command", command: rawLine, output }] };
}

async function runExec(
  command: Extract<Command, { kind: "exec" }>,
  rawLine: string,
  ctx: TerminalContext,
): Promise<CommandResult> {
  if (!ctx.simulator.exec) {
    return { output: `kubectl exec: ${CAPABILITY_UNAVAILABLE}`, isError: true, signals: [] };
  }
  const namespace = command.namespace ?? ctx.namespace;
  const snapshot = ctx.simulator.getSnapshot();
  const pod = snapshot.pods.find(
    (p) => p.metadata?.name === command.pod && (p.metadata?.namespace ?? "default") === namespace,
  );
  if (!pod) return { output: notFound("pod", command.pod, namespace), isError: true, signals: [] };
  const result = await ctx.simulator.exec(namespace, command.pod, command.container, command.argv);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  const { exitCode, stdout, stderr } = result.value;
  const parts = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean);
  if (exitCode !== 0) parts.push(`command terminated with exit code ${exitCode}`);
  const output = parts.join("\n") || "";
  return {
    output,
    isError: exitCode !== 0,
    signals: [{ type: "command", command: rawLine, output }],
  };
}

async function runCreateNamespace(name: string, ctx: TerminalContext): Promise<CommandResult> {
  const manifest = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${name}\n`;
  const result = await ctx.simulator.applyYaml(manifest);
  if (!result.ok) return { output: `error: ${result.error}`, isError: true, signals: [] };
  return { output: `namespace/${name} created`, isError: false, signals: [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGetSignals(
  command: Extract<Command, { kind: "get" }>,
  rawLine: string,
  output: string,
  snapshot: ClusterSnapshot,
  namespace: string,
): InvestigationSignal[] {
  const signals: InvestigationSignal[] = [{ type: "command", command: rawLine, output }];
  // Viewing events also surfaces their reasons as evidence signals.
  if (command.resource === "events") {
    for (const event of snapshot.events) {
      if ((event.metadata?.namespace ?? "default") !== namespace) continue;
      if (event.reason) {
        signals.push({
          type: "event-reason",
          reason: event.reason,
          message: event.message ?? "",
          namespace,
        });
      }
    }
  }
  return signals;
}

/** Namespace + name + label-selector filtering for namespaced resources. */
function scopeItems<
  T extends { metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } },
>(
  items: T[],
  scope: { namespace: string; allNamespaces: boolean; name?: string; selector?: string },
): T[] {
  return items.filter(
    (item) =>
      (scope.allNamespaces || (item.metadata?.namespace ?? "default") === scope.namespace) &&
      (scope.name === undefined || item.metadata?.name === scope.name) &&
      (scope.selector === undefined || matchesLabelSelector(item.metadata?.labels, scope.selector)),
  );
}

/** Name + label-selector filtering for cluster-scoped resources (nodes, namespaces). */
function clusterScoped<T extends { metadata?: { name?: string; labels?: Record<string, string> } }>(
  items: T[],
  name?: string,
  selector?: string,
): T[] {
  return items.filter(
    (item) =>
      (name === undefined || item.metadata?.name === name) &&
      (selector === undefined || matchesLabelSelector(item.metadata?.labels, selector)),
  );
}

function findByName(
  resource: string,
  name: string,
  namespace: string,
  snapshot: ClusterSnapshot,
): unknown {
  if (resource === "nodes") return snapshot.nodes.find((n) => n.metadata?.name === name);
  if (resource === "namespaces") return snapshot.namespaces.find((n) => n.metadata?.name === name);
  const map: Partial<Record<GetResource, { metadata?: { name?: string; namespace?: string } }[]>> =
    {
      pods: snapshot.pods,
      services: snapshot.services,
      deployments: snapshot.deployments,
      replicasets: snapshot.replicaSets,
      endpointslices: snapshot.endpointSlices,
    };
  const core = map[resource as GetResource]?.find(
    (item) => item.metadata?.name === name && (item.metadata?.namespace ?? "default") === namespace,
  );
  return core ?? findGenericResource(snapshot, resource, name, namespace);
}

function genericResourcesFor(
  snapshot: ClusterSnapshot,
  requestedKind: string,
): NonNullable<ClusterSnapshot["resources"]> {
  return (snapshot.resources ?? []).filter((resource) =>
    resourceTokenMatchesKind(requestedKind, resource.kind),
  );
}

function findGenericResource(
  snapshot: ClusterSnapshot,
  requestedKind: string,
  name: string,
  namespace: string,
): NonNullable<ClusterSnapshot["resources"]>[number] | undefined {
  return genericResourcesFor(snapshot, requestedKind).find(
    (resource) =>
      resource.metadata.name === name && (resource.metadata.namespace ?? "default") === namespace,
  );
}

const RESOURCE_KIND_ALIASES: Readonly<Record<string, string>> = {
  crd: "customresourcedefinition",
  hpa: "horizontalpodautoscaler",
  pdb: "poddisruptionbudget",
  sc: "storageclass",
};

function resourceTokenMatchesKind(token: string, kind: string): boolean {
  const normalizedToken = (RESOURCE_KIND_ALIASES[token] ?? token).replaceAll("-", "").toLowerCase();
  const normalizedKind = kind.replaceAll("-", "").toLowerCase();
  return (
    normalizedToken === normalizedKind ||
    normalizedToken === `${normalizedKind}s` ||
    (normalizedKind.endsWith("s") && normalizedToken === `${normalizedKind}es`)
  );
}

function readyAddresses(service: V1Service, snapshot: ClusterSnapshot): string[] {
  const serviceName = service.metadata?.name;
  const namespace = service.metadata?.namespace;
  const addresses: string[] = [];
  for (const slice of snapshot.endpointSlices) {
    if (slice.metadata?.namespace !== namespace) continue;
    if (slice.metadata?.labels?.["kubernetes.io/service-name"] !== serviceName) continue;
    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.conditions?.ready === false) continue;
      addresses.push(...(endpoint.addresses ?? []));
    }
  }
  return addresses;
}

function relatedEvents(events: CoreV1Event[], objectName: string): CoreV1Event[] {
  return events
    .filter((e) => e.involvedObject?.name === objectName)
    .sort((a, b) => timeOf(a) - timeOf(b))
    .slice(-8);
}

function timeOf(event: CoreV1Event): number {
  const value = event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp;
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
}

function containerPortsSummary(container: V1Container | undefined): string {
  const ports = container?.ports ?? [];
  if (ports.length === 0) return "<none>";
  return ports.map((p) => `${p.containerPort ?? "?"}/TCP`).join(",");
}

function formatSelector(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return "<none>";
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function notFound(resource: string, name: string, namespace: string): string {
  return `Error from server (NotFound): ${resource} "${name}" not found in namespace "${namespace}".`;
}

export interface CommandReferenceEntry {
  command: string;
  description: string;
  category: "Read" | "Change" | "Debug" | "Network" | "Shell";
}

/**
 * The single source of truth for what the simulated shell supports: rendered by
 * `help` in the terminal and by the searchable command reference in the UI.
 */
export const COMMAND_REFERENCE: CommandReferenceEntry[] = [
  {
    command: "kubectl get pods|svc|deploy|rs|endpoints|eps|ns|nodes|events|all",
    description: "List resources (aliases work: po, svc, deploy, rs, ns, no)",
    category: "Read",
  },
  {
    command: "kubectl get <resource> <name> -o yaml",
    description: "Print a resource's full manifest",
    category: "Read",
  },
  {
    command: "kubectl kustomize <directory>",
    description: "Render an editor-backed Kustomize overlay",
    category: "Read",
  },
  {
    command: "kubectl get pods -o wide",
    description: "List pods with IP and node columns",
    category: "Read",
  },
  {
    command: "kubectl get pods -l app=web",
    description: "Filter by label selector (k=v, k!=v, bare key)",
    category: "Read",
  },
  {
    command: "kubectl get pods -A",
    description: "List across all namespaces",
    category: "Read",
  },
  {
    command: "kubectl get events --sort-by=.lastTimestamp",
    description: "Events, oldest first",
    category: "Read",
  },
  {
    command: "kubectl describe pod|svc|deploy|rs|ns|node <name>",
    description: "Detailed state, probes, conditions, and recent events",
    category: "Read",
  },
  {
    command: "kubectl apply -f <file>",
    description: "Apply a manifest from the editor",
    category: "Change",
  },
  {
    command: "kubectl delete -f <file>",
    description: "Delete everything a manifest file declares",
    category: "Change",
  },
  {
    command: "kubectl delete <pod|svc|deploy|rs|ns|node> <name>",
    description: "Delete one resource by name",
    category: "Change",
  },
  {
    command: "kubectl scale deployment <name> --replicas=<n>",
    description: "Set a deployment's desired replica count",
    category: "Change",
  },
  {
    command: "kubectl rollout status deployment/<name>",
    description: "Report rollout progress",
    category: "Change",
  },
  {
    command: "kubectl rollout restart deployment/<name>",
    description: "Trigger a rolling restart",
    category: "Change",
  },
  {
    command: "kubectl rollout history deployment/<name>",
    description: "List a deployment's ReplicaSet revisions",
    category: "Change",
  },
  {
    command: "kubectl create namespace <name>",
    description: "Create a namespace",
    category: "Change",
  },
  {
    command: "kubectl logs <pod> [-c <container>]",
    description: "Print a pod's container logs",
    category: "Debug",
  },
  {
    command: "kubectl exec <pod> [-c <container>] -- <cmd>",
    description: "Run a command inside a container (env, cat, sh -c ...)",
    category: "Debug",
  },
  {
    command: "curl <url>",
    description: "Probe a Service or pod URL through the cluster network",
    category: "Network",
  },
  {
    command: "dig <service>",
    description: "Resolve a Service's cluster IP (DNS forms supported)",
    category: "Network",
  },
  { command: "clear", description: "Clear the terminal (Ctrl+L)", category: "Shell" },
  { command: "help", description: "Show this message", category: "Shell" },
];

const HELP_TEXT = [
  `${BRAND.name} simulated shell: supported commands:`,
  "",
  ...COMMAND_REFERENCE.map((entry) => `  ${entry.command.padEnd(56)} ${entry.description}`),
  "",
  "Flags: -n <namespace>, -A, -l <selector>, -o yaml|wide. This is a learning simulator, not a real shell.",
].join("\n");
