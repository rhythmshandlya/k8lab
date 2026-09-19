import type {
  ClusterFixture,
  FixtureResource,
  LevelFixture,
  ProblemCapability,
  ProblemEngineSpec,
  ProblemLevel,
} from "@/lib/domain/types";
import { err, ok, type Result } from "@/lib/utils/result";

import { fixtureLogs, fixtureProbe, renderFixtureSnapshot } from "./cluster-fixture";
import { parseCommand, runCommandLine, type CommandResult } from "./command-runner";
import { initialWorkspace, workspaceRevision } from "./workspace-revision";
import { evaluateLevelConstraints } from "./manifest-constraints";
import { evaluateWorkspaceSemantics } from "./workspace-semantics";
import type { LogLine } from "./images/log-sink";
import { parseKubernetesManifests, parseManifests } from "./manifest-parser";
import { applyProblemBoot } from "./problem-boot";
import { capabilitiesForEngine, unsupportedProblemCapabilities } from "./problem-capabilities";
import {
  createScriptedScenarioRuntime,
  emptyScriptedSnapshot,
  type ScriptedScenarioRuntime,
} from "./scripted-scenarios";
import {
  KubeSimulator,
  type AppliedResourceRef,
  type ClusterSnapshot,
  type ProbeResult,
} from "./simulator";
import { runLevelValidation, type ValidationReport } from "./validators";

export type ProblemSnapshotListener = (snapshot: ClusterSnapshot) => void;

export interface ProblemEngine {
  readonly kind: ProblemEngineSpec["kind"];
  readonly capabilities: ReadonlySet<ProblemCapability>;
  boot(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>>;
  reset(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>>;
  close(): Promise<void>;
  subscribe(listener: ProblemSnapshotListener): () => void;
  getSnapshot(): ClusterSnapshot;
  applyFiles(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<AppliedResourceRef[], string>>;
  probe(url: string): Promise<ProbeResult>;
  getLogs(namespace: string, pod: string, container?: string): LogLine[];
  validate(level: ProblemLevel, files: Readonly<Record<string, string>>): Promise<ValidationReport>;
  runCommand(
    line: string,
    namespace: string,
    files: Record<string, string>,
  ): Promise<CommandResult>;
}

function joinDocs(documents: readonly string[]): string {
  return documents.filter((document) => document.trim() !== "").join("\n---\n");
}

export class WebernetesProblemEngine implements ProblemEngine {
  readonly kind = "webernetes" as const;
  readonly capabilities = capabilitiesForEngine({ kind: "webernetes" });
  private readonly simulator = new KubeSimulator();

  async boot(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    const unsupported = unsupportedProblemCapabilities(level);
    if (unsupported.length > 0) {
      return err(`Webernetes does not support: ${unsupported.join(", ")}`);
    }
    const booted = await this.simulator.boot();
    if (!booted.ok) return booted;
    return applyProblemBoot(this.simulator, level);
  }

  async reset(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    const reset = await this.simulator.reset();
    if (!reset.ok) return reset;
    return applyProblemBoot(this.simulator, level);
  }

  close(): Promise<void> {
    return this.simulator.close();
  }

  subscribe(listener: ProblemSnapshotListener): () => void {
    return this.simulator.subscribe(listener);
  }

  getSnapshot(): ClusterSnapshot {
    return this.simulator.getSnapshot();
  }

  applyFiles(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<AppliedResourceRef[], string>> {
    return this.simulator.applyYaml(joinDocs(Object.values(files)));
  }

  probe(url: string): Promise<ProbeResult> {
    return this.simulator.probe(url);
  }

  getLogs(namespace: string, pod: string, container?: string): LogLine[] {
    return this.simulator.getLogs(namespace, pod, container);
  }

  validate(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Promise<ValidationReport> {
    return runLevelValidation(level, files, { simulator: this.simulator });
  }

  runCommand(
    line: string,
    namespace: string,
    files: Record<string, string>,
  ): Promise<CommandResult> {
    return runCommandLine(line, { simulator: this.simulator, namespace, files });
  }
}

export class ScriptedIncidentEngine implements ProblemEngine {
  readonly kind = "scripted" as const;
  readonly capabilities: ReadonlySet<ProblemCapability>;
  private readonly listeners = new Set<ProblemSnapshotListener>();
  private readonly runtime: ScriptedScenarioRuntime | undefined;
  private activeLevel: ProblemLevel | undefined;
  /**
   * Defined only for scenarios that review the workspace as a whole, so the command
   * runner can tell `kubectl apply -f` to re-run the review rather than reject a
   * single manifest the scenario was never able to act on.
   */
  readonly applyWorkspace?: (
    files: Record<string, string>,
  ) => Promise<Result<AppliedResourceRef[], string>>;

  constructor(private readonly scenarioId: string) {
    this.capabilities = capabilitiesForEngine({ kind: "scripted", scenarioId });
    this.runtime = createScriptedScenarioRuntime(scenarioId);
    if (this.runtime?.appliesWholeWorkspace) {
      this.applyWorkspace = (files) => this.applyFiles(files);
    }
  }

  async boot(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    if (!this.runtime) return err(`Unknown scripted scenario: ${this.scenarioId}`);
    this.activeLevel = level;
    const unsupported = unsupportedProblemCapabilities(level);
    if (unsupported.length > 0) {
      return err(`Scripted scenario does not support: ${unsupported.join(", ")}`);
    }
    const booted = this.runtime.boot();
    this.emit();
    return booted;
  }

  reset(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    return this.boot(level);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  subscribe(listener: ProblemSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ClusterSnapshot {
    return this.runtime?.snapshot() ?? emptyScriptedSnapshot();
  }

  async applyFiles(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<AppliedResourceRef[], string>> {
    if (this.runtime?.applyFiles && this.activeLevel) {
      const applied = this.runtime.applyFiles(this.activeLevel, files);
      if (applied.ok) this.emit();
      return applied;
    }
    return this.applyYaml(joinDocs(Object.values(files)));
  }

  async applyYaml(yamlText: string): Promise<Result<AppliedResourceRef[], string>> {
    if (!this.runtime) return err(`Unknown scripted scenario: ${this.scenarioId}`);
    const parsed = parseManifests(yamlText);
    if (!parsed.ok) return err(parsed.error.message);
    const applied = this.runtime.apply(parsed.value);
    if (applied.ok) this.emit();
    return applied;
  }

  async deleteYaml(_yamlText: string): Promise<Result<AppliedResourceRef[], string>> {
    return err("Deleting scripted scenario resources is not supported.");
  }

  async probe(url: string): Promise<ProbeResult> {
    return (
      this.runtime?.probe(url) ?? {
        ok: false,
        status: 0,
        body: "",
        reason: `Unknown scripted scenario: ${this.scenarioId}`,
      }
    );
  }

  validate(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Promise<ValidationReport> {
    return runLevelValidation(level, files, { simulator: this });
  }

  runCommand(
    line: string,
    namespace: string,
    files: Record<string, string>,
  ): Promise<CommandResult> {
    return runCommandLine(line, { simulator: this, namespace, files });
  }

  getLogs(namespace: string, pod: string, container?: string): LogLine[] {
    return this.runtime?.logs(namespace, pod, container) ?? [];
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * Runs a level's own declarative cluster. The learner investigates the workload the
 * incident brief describes, in the namespace it names; submitting a workspace that
 * satisfies every acceptance rule moves the cluster to its healthy state.
 */
export class FixtureIncidentEngine implements ProblemEngine {
  readonly kind = "fixture" as const;
  readonly capabilities: ReadonlySet<ProblemCapability>;
  readonly appliesWholeWorkspace = true;
  private readonly listeners = new Set<ProblemSnapshotListener>();
  private state: ClusterFixture;
  private activeLevel: ProblemLevel | undefined;
  private currentResources: FixtureResource[];

  constructor(private readonly fixture: LevelFixture) {
    this.capabilities = capabilitiesForEngine({ kind: "fixture", fixture });
    this.state = fixture.broken;
    this.currentResources = fixture.broken.resources ?? [];
  }

  async boot(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    this.activeLevel = level;
    this.state = this.fixture.broken;
    this.currentResources = mergeFixtureResources(
      this.state.resources ?? [],
      resourcesFromWorkspace(level, {}),
    );
    this.emit();
    return ok(
      (this.state.workloads ?? []).map((workload) => ({
        kind: "Deployment",
        name: workload.name,
        namespace: this.state.namespace,
      })),
    );
  }

  reset(level: ProblemLevel): Promise<Result<AppliedResourceRef[], string>> {
    return this.boot(level);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  subscribe(listener: ProblemSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ClusterSnapshot {
    return renderFixtureSnapshot({ ...this.state, resources: this.currentResources });
  }

  async applyFiles(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<AppliedResourceRef[], string>> {
    const level = this.activeLevel;
    if (!level) return err("The scenario has not booted yet.");

    const merged = Object.fromEntries(
      level.files.map((file) => [file.path, files[file.path] ?? file.initialValue]),
    );
    const applied: AppliedResourceRef[] = [];
    for (const file of level.files.filter((candidate) => candidate.access === "editable")) {
      // The permissive parser: a fixture only reports what was submitted, so it must
      // accept every Kubernetes kind, not just the six the browser control plane runs.
      const parsed = parseKubernetesManifests(merged[file.path] ?? file.initialValue);
      if (!parsed.ok) return err(`${file.path}: ${parsed.error.message}`);
      applied.push(
        ...parsed.value.map((manifest) => ({
          kind: manifest.kind,
          name: manifest.name,
          namespace: manifest.namespace,
        })),
      );
    }

    const unresolved = [
      ...evaluateLevelConstraints(level, merged).filter((result) => !result.passed),
      ...evaluateWorkspaceSemantics(level, merged),
    ];
    this.state = unresolved.length === 0 ? this.fixture.healthy : this.fixture.broken;
    const submittedResources = resourcesFromWorkspace(level, merged);
    const resourcesToMerge =
      this.state === this.fixture.healthy
        ? submittedResources.filter(
            (resource) => !healthyResourceTombstones(this.fixture).has(resourceIdentity(resource)),
          )
        : submittedResources;
    this.currentResources = mergeFixtureResources(this.state.resources ?? [], resourcesToMerge);
    this.emit();
    return ok(applied);
  }

  async probe(url: string): Promise<ProbeResult> {
    return fixtureProbe(this.state, url);
  }

  getLogs(namespace: string, pod: string, container?: string): LogLine[] {
    return fixtureLogs(this.state, namespace, pod, container);
  }

  validate(
    level: ProblemLevel,
    files: Readonly<Record<string, string>>,
  ): Promise<ValidationReport> {
    return runLevelValidation(level, files, { simulator: this });
  }

  runCommand(
    line: string,
    namespace: string,
    files: Record<string, string>,
  ): Promise<CommandResult> {
    return runCommandLine(line, { simulator: this, namespace, files });
  }

  applyWorkspace = (files: Record<string, string>) => this.applyFiles(files);

  async applyYaml(_yamlText: string): Promise<Result<AppliedResourceRef[], string>> {
    return err("This incident is reviewed as a whole workspace; use Apply or `kubectl apply -f`.");
  }

  async deleteYaml(_yamlText: string): Promise<Result<AppliedResourceRef[], string>> {
    return err("Deleting fixture resources is not supported.");
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function resourcesFromWorkspace(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): FixtureResource[] {
  return level.files.flatMap((file) => {
    const parsed = parseKubernetesManifests(files[file.path] ?? file.initialValue);
    // Kustomization is an authoring document, not a cluster API object.
    return parsed.ok
      ? parsed.value
          .filter((manifest) => manifest.kind !== "Kustomization")
          .map((manifest) => manifest.raw as FixtureResource)
      : [];
  });
}

function mergeFixtureResources(
  supportingResources: readonly FixtureResource[],
  workspaceResources: readonly FixtureResource[],
): FixtureResource[] {
  const byIdentity = new Map<string, FixtureResource>();
  for (const resource of [...supportingResources, ...workspaceResources]) {
    const identity = resourceIdentity(resource);
    const existing = byIdentity.get(identity);
    byIdentity.set(
      identity,
      existing
        ? {
            ...existing,
            ...resource,
            metadata: { ...existing.metadata, ...resource.metadata },
          }
        : resource,
    );
  }
  return [...byIdentity.values()];
}

/** Resources intentionally present only in the broken fixture represent deletions. */
function healthyResourceTombstones(fixture: LevelFixture): ReadonlySet<string> {
  const healthyIdentities = new Set((fixture.healthy.resources ?? []).map(resourceIdentity));
  return new Set(
    (fixture.broken.resources ?? [])
      .map(resourceIdentity)
      .filter((identity) => !healthyIdentities.has(identity)),
  );
}

function resourceIdentity(resource: FixtureResource): string {
  return [
    resource.kind.toLowerCase(),
    resource.metadata.namespace ?? "",
    resource.metadata.name,
  ].join("/");
}

export function createProblemEngine(spec: ProblemEngineSpec): ProblemEngine {
  const engine =
    spec.kind === "webernetes"
      ? new WebernetesProblemEngine()
      : spec.kind === "fixture"
        ? new FixtureIncidentEngine(spec.fixture)
        : new ScriptedIncidentEngine(spec.scenarioId);
  return new RevisionedProblemEngine(engine);
}

/** Serialize mutations and bind formal verdicts to the files actually applied. */
class RevisionedProblemEngine implements ProblemEngine {
  private level: ProblemLevel | undefined;
  private appliedFiles: Record<string, string> = {};
  private imperativeChanges = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly runtime: ProblemEngine) {}
  get kind() {
    return this.runtime.kind;
  }
  get capabilities() {
    return this.runtime.capabilities;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
  boot(level: ProblemLevel) {
    return this.serialize(async () => {
      const result = await this.runtime.boot(level);
      if (result.ok) {
        this.level = level;
        this.appliedFiles = initialWorkspace(level);
        this.imperativeChanges = false;
      }
      return result;
    });
  }
  reset(level: ProblemLevel) {
    return this.serialize(async () => {
      const result = await this.runtime.reset(level);
      if (result.ok) {
        this.level = level;
        this.appliedFiles = initialWorkspace(level);
        this.imperativeChanges = false;
      }
      return result;
    });
  }
  close() {
    return this.serialize(() => this.runtime.close());
  }
  subscribe(listener: ProblemSnapshotListener) {
    return this.runtime.subscribe(listener);
  }
  getSnapshot() {
    return this.runtime.getSnapshot();
  }
  probe(url: string) {
    return this.runtime.probe(url);
  }
  getLogs(namespace: string, pod: string, container?: string) {
    return this.runtime.getLogs(namespace, pod, container);
  }
  applyFiles(files: Readonly<Record<string, string>>) {
    const revision = { ...files };
    return this.serialize(async () => {
      const result = await this.runtime.applyFiles(revision);
      if (result.ok) {
        this.appliedFiles = { ...this.appliedFiles, ...revision };
        if (
          this.level?.files
            .filter((file) => file.access === "editable")
            .every((file) => file.path in revision)
        )
          this.imperativeChanges = false;
      }
      return result;
    });
  }
  validate(level: ProblemLevel, files: Readonly<Record<string, string>>) {
    const revision = { ...files };
    return this.serialize(async () => {
      const report = await this.runtime.validate(level, revision);
      if (
        this.imperativeChanges ||
        this.level?.slug !== level.slug ||
        workspaceRevision(level, revision) !== workspaceRevision(level, this.appliedFiles)
      ) {
        report.results.push({
          id: "unapplied-files",
          title: "Submitted files are applied",
          passed: false,
          detail: this.imperativeChanges
            ? "The terminal changed the cluster. Reflect the intended solution in the editor and Apply Changes before submitting."
            : "The editor contains unapplied changes. Apply this revision before submitting.",
          label: "Apply the current files",
        });
        report.passed = false;
      }
      return report;
    });
  }
  runCommand(line: string, namespace: string, files: Record<string, string>) {
    const revision = { ...files };
    return this.serialize(async () => {
      const command = parseCommand(line);
      const result = await this.runtime.runCommand(line, namespace, revision);
      if (
        !result.isError &&
        (["delete", "delete-resource", "scale", "create-namespace"].includes(command.kind) ||
          (command.kind === "rollout" && command.verb === "restart"))
      )
        this.imperativeChanges = true;
      if (!result.isError && command.kind === "apply") {
        this.appliedFiles =
          this.kind === "fixture" || this.level?.challengeMode === "build"
            ? { ...this.appliedFiles, ...revision }
            : { ...this.appliedFiles, [command.file]: revision[command.file] ?? "" };
      }
      return result;
    });
  }
}
