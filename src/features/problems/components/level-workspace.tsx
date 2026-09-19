"use client";

import type { CoreV1Event } from "@ngrok/webernetes";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ErrorBoundary } from "@/components/app-shell/error-boundary";
import { DiffView } from "@/components/editor/diff-editor";
import { EventsTimeline } from "@/components/events/events-timeline";
import { icons } from "@/components/icons";
import { LogsView } from "@/components/logs/logs-view";
import { ClusterExplorer } from "@/components/object-explorer/cluster-explorer";
import { ObjectDetails } from "@/components/object-explorer/object-details";
import { XtermTerminal, type TerminalRunResult } from "@/components/terminal/xterm-terminal";
import { Badge } from "@/components/ui/badge";
import { handleTabKeyDown } from "@/components/ui/tabs";
import { BRAND } from "@/config/brand";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePane,
  usePersistedLayout,
} from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { YamlEditor } from "@/components/editor/yaml-editor";
import type { Hint, ProblemLevel, QuickCommand } from "@/lib/domain/types";
import { createProbeSignal, matchEvidence, type InvestigationSignal } from "@/lib/kube/evidence";
import type { LogLine } from "@/lib/kube/images/log-sink";
import { isPodReady, readyEndpointCount } from "@/lib/kube/kubectl/format";
import { resolveQuickCommand } from "@/lib/kube/quick-command";
import type { ClusterSnapshot } from "@/lib/kube/simulator";
import { flushLevelWorkspace } from "@/lib/storage/level-workspace";
import { createClientMutationId, PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";
import { flush, getIdentity, mutateProgress, pullRemote } from "@/lib/storage/progress-store";
import { utcDay } from "@/lib/storage/streak";
import { JUDGE_VERSION, type SubmissionRecord } from "@/lib/problems/submission";
import { workspaceRevision } from "@/lib/kube/workspace-revision";
import { cn } from "@/lib/utils/cn";

import { useCompactWorkspace } from "../hooks/use-compact-workspace";
import { useProblemOwner } from "../hooks/use-problem-owner";
import { useProblemEngine } from "../hooks/use-problem-engine";
import { useLevelStore, type CenterTab } from "../level-store";
import { EvidenceBoard } from "./evidence-board";
import { FailingChecks } from "./failing-checks";
import { HintsCard } from "./hints-card";
import { IncidentBrief } from "./incident-brief";
import { ArchitectureInventory } from "./architecture-inventory";
import { NetworkProbe } from "./network-probe";
import { ValidationDialog } from "./validation-dialog";
import { DraftStatus } from "./draft-status";
import { SubmissionHistory, saveGuestSubmission } from "./submission-history";

const ServiceTopology = dynamic(
  () => import("@/components/topology/service-topology").then((m) => m.ServiceTopology),
  { ssr: false, loading: () => <Skeleton className="m-3 h-[calc(100%-1.5rem)]" /> },
);

const NAMESPACE = "default";

const CENTER_TABS: { id: CenterTab; label: string; icon: keyof typeof icons }[] = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "logs", label: "Logs", icon: "logs" },
  { id: "events", label: "Events", icon: "events" },
  { id: "network", label: "Network", icon: "cluster" },
  { id: "diff", label: "Diff", icon: "diff" },
];

interface ApplyFeedback {
  tone: "success" | "error";
  title: string;
  message: string;
}

/** Include control-plane objects when an exercise exposes them. */
function isWorkloadNamespace(namespace: string | undefined): boolean {
  return namespace !== "";
}

/** Pick the most diagnostically interesting broken object for auto-selection. */
function findBrokenObject(
  snapshot: ClusterSnapshot,
): { kind: string; name: string; namespace: string } | null {
  const notReadyPod = snapshot.pods.find(
    (p) => !isPodReady(p) && p.metadata?.name && isWorkloadNamespace(p.metadata.namespace),
  );
  if (notReadyPod?.metadata?.name) {
    return {
      kind: "Pod",
      name: notReadyPod.metadata.name,
      namespace: notReadyPod.metadata.namespace ?? "default",
    };
  }
  const emptyService = snapshot.services.find(
    (s) =>
      s.metadata?.name &&
      isWorkloadNamespace(s.metadata.namespace) &&
      readyEndpointCount(s, snapshot.endpointSlices) === 0,
  );
  if (emptyService?.metadata?.name) {
    return {
      kind: "Service",
      name: emptyService.metadata.name,
      namespace: emptyService.metadata.namespace ?? "default",
    };
  }
  const strugglingDeployment = snapshot.deployments.find(
    (d) =>
      d.metadata?.name &&
      isWorkloadNamespace(d.metadata.namespace) &&
      (d.status?.readyReplicas ?? 0) < (d.spec?.replicas ?? 0),
  );
  if (strugglingDeployment?.metadata?.name) {
    return {
      kind: "Deployment",
      name: strugglingDeployment.metadata.name,
      namespace: strugglingDeployment.metadata.namespace ?? "default",
    };
  }
  return null;
}

export function LevelWorkspace({ level }: { level: ProblemLevel }) {
  const owner = useProblemOwner();
  return (
    <LevelWorkspaceSession key={`${level.slug}:${owner ?? "guest"}`} level={level} owner={owner} />
  );
}

function LevelWorkspaceSession({ level, owner }: { level: ProblemLevel; owner: string | null }) {
  const compact = useCompactWorkspace();
  const [compactPane, setCompactPane] = useState<"brief" | "work" | "inspect">("work");
  const initLevel = useLevelStore((s) => s.initLevel);
  useEffect(() => {
    initLevel(level);
    const flushDraft = () => flushLevelWorkspace(level.slug, owner);
    window.addEventListener("pagehide", flushDraft);
    // Saved edits are debounced; flush on the way out so the last keystroke before a
    // navigation or refresh is never the one that gets lost.
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, [level, initLevel, owner]);

  const files = useLevelStore((s) => s.files);
  const activeFilePath = useLevelStore((s) => s.activeFilePath);
  const setFile = useLevelStore((s) => s.setFile);
  const setActiveFile = useLevelStore((s) => s.setActiveFile);
  const centerTab = useLevelStore((s) => s.centerTab);
  const setCenterTab = useLevelStore((s) => s.setCenterTab);
  const selected = useLevelStore((s) => s.selected);
  const select = useLevelStore((s) => s.select);
  const addEvidence = useLevelStore((s) => s.addEvidence);
  const revealHint = useLevelStore((s) => s.revealHint);
  const validation = useLevelStore((s) => s.validation);
  const setValidation = useLevelStore((s) => s.setValidation);
  const checks = useLevelStore((s) => s.checks);
  const setChecks = useLevelStore((s) => s.setChecks);
  const setSolved = useLevelStore((s) => s.setSolved);
  const solved = useLevelStore((s) => s.solved);
  const revealedHintIds = useLevelStore((s) => s.revealedHintIds);
  const restoredFromStorage = useLevelStore((s) => s.restoredFromStorage);

  const sim = useProblemEngine(level);
  const isBuild = level.challengeMode === "build";
  const scenarioReady = sim.ready;
  const validateProblem = sim.validate;
  const [validationOpen, setValidationOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [validating, setValidating] = useState(false);
  const [refreshingChecks, setRefreshingChecks] = useState(false);
  const [applyFeedback, setApplyFeedback] = useState<ApplyFeedback | null>(null);
  const [latestSubmission, setLatestSubmission] = useState<SubmissionRecord | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pendingSubmission = useRef<{ revision: string; id: string } | null>(null);
  // Keyed by slug rather than reset in an effect, so navigating to another level
  // brings the notice back without a cascading render.
  const [restoreNoticeDismissedFor, setRestoreNoticeDismissedFor] = useState<string | null>(null);
  const restoreNoticeDismissed = restoreNoticeDismissedFor === level.slug;

  // Persisted, user-resizable pane layouts (drag the separators; arrow keys work too).
  const columnsLayout = usePersistedLayout("klab:layout:level-workspace:columns:v2");
  const centerLayout = usePersistedLayout("klab:layout:level-workspace:center:v2");
  const inspectorLayout = usePersistedLayout("klab:layout:level-workspace:inspector:v2");
  const explorerLayout = usePersistedLayout("klab:layout:level-workspace:explorer");

  const terminalRunnerRef = useRef<((line: string) => void) | null>(null);
  const autoSelectedRef = useRef(false);
  const attemptedRef = useRef(false);
  const checksTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // When the level opened, for measuring time-to-solve on each submission. Set in an
  // effect (not during render) so the render stays pure; the effect runs before any solve.
  const startedAtRef = useRef(0);
  useEffect(() => {
    startedAtRef.current = Date.now();
  }, [level.slug]);

  const markAttempted = useCallback(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;
    mutateProgress({ kind: "attempted", slug: level.slug });
  }, [level.slug]);

  const collectSignals = useCallback(
    (signals: InvestigationSignal[]) => {
      const matched = matchEvidence(level.evidenceRules, signals);
      if (matched.length > 0) addEvidence(matched);
    },
    [level.evidenceRules, addEvidence],
  );

  const inspectLogs = useCallback(
    (lines: readonly LogLine[]) => {
      collectSignals(
        lines.map((line) => ({
          type: "log" as const,
          namespace: line.namespace,
          pod: line.pod,
          message: line.message,
        })),
      );
    },
    [collectSignals],
  );

  const inspectEvents = useCallback(
    (events: readonly CoreV1Event[]) => {
      collectSignals(
        events
          .filter((event) => event.reason)
          .map((event) => ({
            type: "event-reason" as const,
            reason: event.reason ?? "",
            message: event.message ?? "",
            namespace: event.metadata?.namespace ?? "default",
          })),
      );
    },
    [collectSignals],
  );

  const inspectObject = useCallback(
    (object: { kind: string; name: string; namespace: string }) => {
      collectSignals([{ type: "object-view", ...object }]);
      select(object);
    },
    [collectSignals, select],
  );

  const inspectTopology = useCallback(
    (object: { kind: string; name: string; namespace: string }) => {
      collectSignals([{ type: "topology-view", ...object }]);
      select(object);
    },
    [collectSignals, select],
  );

  /** Quietly evaluate the level's checks (no dialog, no solve) for the status card. */
  const refreshChecks = useCallback(async () => {
    if (!scenarioReady) return;
    setRefreshingChecks(true);
    try {
      const report = await validateProblem(level, useLevelStore.getState().files);
      if (mounted.current && getIdentity() === owner) setChecks(report);
    } finally {
      setRefreshingChecks(false);
    }
  }, [scenarioReady, validateProblem, level, setChecks, owner]);

  /** Refresh now and again after the controllers have had time to reconcile. */
  const scheduleChecks = useCallback(
    (delays: number[] = [400, 2500]) => {
      for (const delay of delays) {
        checksTimersRef.current.push(setTimeout(() => void refreshChecks(), delay));
      }
    },
    [refreshChecks],
  );
  useEffect(() => {
    const timers = checksTimersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Reconciliation is asynchronous. Debounce against real cluster updates so a
  // correct change cannot remain stuck on an intermediate validation result.
  useEffect(() => {
    if (!sim.ready) return;
    const timer = setTimeout(() => void refreshChecks(), 350);
    return () => clearTimeout(timer);
  }, [sim.ready, sim.snapshot, refreshChecks]);

  // Auto-select the most relevant broken object once, so the details panel is never
  // an empty "select something" placeholder while the incident is live.
  useEffect(() => {
    if (autoSelectedRef.current || selected !== null) return;
    const broken = findBrokenObject(sim.snapshot);
    if (broken) {
      autoSelectedRef.current = true;
      select(broken);
    }
  }, [sim.snapshot, selected, select]);

  const runCommand = useCallback(
    async (line: string): Promise<TerminalRunResult> => {
      if (operation.current)
        return { output: "Wait for the current apply or submission to finish.", isError: true };
      if (!sim.ready) {
        return { output: "Cluster is still booting: try again in a moment.", isError: true };
      }
      markAttempted();
      const result = await sim.engine.runCommand(line, NAMESPACE, useLevelStore.getState().files);
      collectSignals(result.signals);
      return { output: result.output, isError: result.isError, clear: result.clear };
    },
    [sim.engine, sim.ready, collectSignals, markAttempted],
  );

  const handleProbe = useCallback(
    async (url: string) => {
      markAttempted();
      const result = await sim.probe(url);
      collectSignals([createProbeSignal(url, result)]);
      return result;
    },
    [sim, collectSignals, markAttempted],
  );

  const handleApply = useCallback(async () => {
    if (operation.current || !sim.ready) return;
    operation.current = true;
    setApplying(true);
    setApplyFeedback(null);
    markAttempted();
    try {
      const currentFiles = useLevelStore.getState().files;
      const editableFiles = Object.fromEntries(
        level.files
          .filter((file) => file.access === "editable")
          .map((file) => [file.path, currentFiles[file.path] ?? file.initialValue]),
      );
      const result = await sim.applyFiles(editableFiles);
      if (!mounted.current || getIdentity() !== owner) return;
      if (!result.ok) {
        setApplyFeedback({
          tone: "error",
          title: isBuild ? "Static review could not run" : "Changes were not applied",
          message: result.error,
        });
        return;
      }
      const resources = result.value.map(({ kind, name }) => `${kind}/${name}`);
      setApplyFeedback({
        tone: "success",
        title: isBuild ? "Static review completed" : "Changes applied",
        message:
          resources.length > 0
            ? isBuild
              ? `${resources.length} submitted resources were assessed.`
              : resources.join(", ")
            : "The manifest was accepted. No resources changed.",
      });
      scheduleChecks();
    } finally {
      operation.current = false;
      setApplying(false);
    }
  }, [sim, level.files, scheduleChecks, markAttempted, isBuild, owner]);

  const handleReset = useCallback(async () => {
    if (operation.current || !sim.ready) return;
    operation.current = true;
    setApplying(true);
    try {
      setApplyFeedback(null);
      await sim.reset();
      if (!mounted.current || getIdentity() !== owner) return;
      useLevelStore.getState().resetFiles();
      select(null);
      autoSelectedRef.current = false;
      setChecks(null);
      scheduleChecks([1200, 4000]);
    } finally {
      operation.current = false;
      setApplying(false);
    }
  }, [sim, select, setChecks, scheduleChecks, owner]);

  const handleValidate = useCallback(async () => {
    if (!scenarioReady || operation.current) return;
    operation.current = true;
    setValidating(true);
    try {
      const submittedFiles = { ...useLevelStore.getState().files };
      const revision = workspaceRevision(level, submittedFiles);
      const localReport = await validateProblem(level, submittedFiles);
      if (!mounted.current || getIdentity() !== owner) return;
      // A pending editor revision must be applied before either local or server validation.
      if (localReport.results.some((result) => result.id === "unapplied-files" && !result.passed)) {
        setValidation(localReport);
        setChecks(localReport);
        setValidationOpen(true);
        return;
      }
      const id =
        pendingSubmission.current?.revision === revision
          ? pendingSubmission.current.id
          : createClientMutationId();
      pendingSubmission.current = { revision, id };
      let record: SubmissionRecord;
      if (owner) {
        await flush(); // Commit hint reveals before the server calculates the award.
        const response = await fetch("/api/problems/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json", [PROGRESS_OWNER_HEADER]: owner },
          body: JSON.stringify({
            slug: level.slug,
            contentVersion: level.contentVersion,
            files: submittedFiles,
            clientMutationId: id,
            revealedHintIds: useLevelStore.getState().revealedHintIds,
            durationMs: Math.min(86_400_000, Date.now() - startedAtRef.current),
          }),
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error ?? "Submission could not be verified. Your draft is saved; retry.",
          );
        record = body as SubmissionRecord;
        if (!mounted.current || getIdentity() !== owner) return;
        await pullRemote();
      } else {
        record = {
          id,
          slug: level.slug,
          contentVersion: level.contentVersion,
          judgeVersion: JUDGE_VERSION,
          files: submittedFiles,
          report: localReport,
          createdAt: new Date().toISOString(),
          verified: false,
        };
        try {
          saveGuestSubmission(record);
        } catch {
          setApplyFeedback({
            tone: "error",
            title: "History could not be saved",
            message:
              "Your result is available this session. Export the draft before leaving this page.",
          });
        }
      }
      pendingSubmission.current = null;
      setLatestSubmission(record);
      const report = record.report;
      collectSignals(
        report.results.map((result) => ({
          type: "validator" as const,
          validatorId: result.id,
          passed: result.passed,
          detail: result.detail,
        })),
      );
      setValidation(report);
      setChecks(report);
      setValidationOpen(true);
      if (report.passed && workspaceRevision(level, useLevelStore.getState().files) === revision) {
        setSolved(true);
        if (!owner)
          mutateProgress({ kind: "solved", slug: level.slug, xp: level.xp, day: utcDay() });
      }
    } catch (error) {
      setApplyFeedback({
        tone: "error",
        title: "Submission was not saved",
        message:
          error instanceof Error
            ? error.message
            : "Submission failed. Retry without changing your files.",
      });
    } finally {
      operation.current = false;
      setValidating(false);
    }
  }, [
    scenarioReady,
    validateProblem,
    level,
    owner,
    setValidation,
    setChecks,
    setSolved,
    collectSignals,
  ]);

  const handleRevealHint = useCallback(
    (hint: Hint) => {
      if (operation.current) return;
      revealHint(hint.id);
      mutateProgress({
        kind: "revealHint",
        slug: level.slug,
        hintId: hint.id,
        penalty: hint.xpPenalty,
      });
    },
    [revealHint, level.slug],
  );

  // Submit from anywhere on the level without stealing the browser's reload shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const submitChord = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter";
      if (!submitChord) return;
      e.preventDefault();
      void handleValidate();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleValidate]);

  const activeFile = level.files.find((f) => f.path === activeFilePath);
  const visibleFiles = level.files.filter((file) => file.access !== "hidden");
  const activeFileTabIndex = visibleFiles.findIndex((file) => file.path === activeFilePath);
  const activeFileTabId =
    activeFileTabIndex >= 0 ? `problem-file-tab-${activeFileTabIndex}` : undefined;
  const activeInvestigationTabId = `investigation-tab-${centerTab}`;

  // Namespaces that actually hold workload objects (multi-namespace levels).
  // Include namespaces used by control-plane and infrastructure exercises.
  const workspaceNamespaces = useMemo(() => {
    const set = new Set<string>([NAMESPACE]);
    for (const object of [
      ...sim.snapshot.pods,
      ...sim.snapshot.services,
      ...sim.snapshot.deployments,
      ...sim.snapshot.replicaSets,
      ...(sim.snapshot.resources ?? []),
    ]) {
      const ns = object.metadata?.namespace ?? "default";
      if (isWorkloadNamespace(ns)) set.add(ns);
    }
    return [...set].sort((a, b) =>
      a === NAMESPACE ? -1 : b === NAMESPACE ? 1 : a.localeCompare(b),
    );
  }, [sim.snapshot]);

  const runQuickCommand = useCallback(
    (quickCommand: QuickCommand) => {
      const resolved = resolveQuickCommand(quickCommand, sim.snapshot.pods);
      if (!resolved) return;
      setCenterTab("terminal");
      // The terminal mounts lazily; give it a tick when switching tabs.
      setTimeout(() => terminalRunnerRef.current?.(resolved), 50);
    },
    [sim.snapshot.pods, setCenterTab],
  );

  const hintPenalty = level.hints
    .filter((h) => revealedHintIds.includes(h.id))
    .reduce((sum, h) => sum + h.xpPenalty, 0);
  const netXp = Math.max(0, level.xp - hintPenalty);
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col gap-2 overflow-x-auto p-3">
      <DraftStatus level={level} owner={owner} />
      {sim.error ? (
        <div
          role="alert"
          className="border-red/40 bg-red/10 text-red flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <icons.warning className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">The problem scenario could not start</p>
            <p className="text-red/90 mt-0.5 break-words">{sim.error}</p>
          </div>
        </div>
      ) : null}
      {compact ? (
        <nav aria-label="Problem workspace" className="flex shrink-0 gap-2">
          {(["brief", "work", "inspect"] as const).map((pane) => (
            <button
              key={pane}
              type="button"
              aria-pressed={compactPane === pane}
              onClick={() => setCompactPane(pane)}
              className={cn(
                "flex-1 rounded border px-3 py-2 text-sm",
                compactPane === pane && "bg-panel-elevated font-semibold",
              )}
            >
              {pane === "brief" ? "Problem" : pane === "work" ? "Editor & tools" : "Cluster"}
            </button>
          ))}
        </nav>
      ) : null}
      <ResizableGroup
        orientation="horizontal"
        id="level-columns"
        defaultLayout={columnsLayout.defaultLayout}
        onLayoutChanged={columnsLayout.onLayoutChanged}
        className={cn(
          "min-h-0 min-w-0 flex-1",
          compact && compactPane === "work" && "[&>#rail-left]:hidden! [&>#rail-right]:hidden!",
          compact && compactPane === "brief" && "[&>#center]:hidden! [&>#rail-right]:hidden!",
          compact && compactPane === "inspect" && "[&>#center]:hidden! [&>#rail-left]:hidden!",
        )}
      >
        {/* Left rail: resizable; one scroll container, cards keep their natural height. */}
        <ResizablePane
          id="rail-left"
          defaultSize="23%"
          minSize={compact ? "0px" : "240px"}
          maxSize="42%"
          className={cn("h-full", compact && compactPane !== "brief" && "hidden")}
        >
          <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1 pb-1">
            <div className="shrink-0">
              <IncidentBrief />
            </div>
            <div className="shrink-0">
              <FailingChecks onRefresh={() => void refreshChecks()} refreshing={refreshingChecks} />
            </div>
            <div className="shrink-0">
              <EvidenceBoard />
            </div>
            <div className="shrink-0">
              <HintsCard onReveal={handleRevealHint} />
            </div>
            <SubmissionHistory
              level={level}
              owner={owner}
              latest={latestSubmission}
              disabled={applying || validating}
            />
            {/* XP is a footnote during debugging, not a panel (UX: prioritize investigation). */}
            <p className="text-subtle flex shrink-0 items-center gap-1.5 px-1 text-xs">
              <icons.xp className="text-purple size-3.5" aria-hidden />
              Worth <span className="tabnums text-foreground font-medium">{netXp} XP</span>
              {hintPenalty > 0 ? (
                <span className="text-amber">(−{hintPenalty} from hints)</span>
              ) : null}
              {solved ? (
                <Badge tone="success">
                  <icons.trophy aria-hidden />
                  Solved
                </Badge>
              ) : null}
            </p>
          </div>
        </ResizablePane>

        <ResizableHandle
          orientation="vertical"
          className={compact ? "hidden" : undefined}
          aria-label="Resize incident rail"
        />

        {/* Center column: vertical split so the editor height is adjustable. */}
        <ResizablePane
          id="center"
          minSize={compact ? "0%" : "28%"}
          className={cn("h-full min-w-0", compact && compactPane !== "work" && "hidden")}
        >
          <ResizableGroup
            orientation="vertical"
            id="level-center"
            defaultLayout={centerLayout.defaultLayout}
            onLayoutChanged={centerLayout.onLayoutChanged}
            className="h-full"
          >
            {/* The manifest is the primary work surface. Investigation tools sit below it. */}
            <ResizablePane id="center-editor" defaultSize="58%" minSize="22%" className="h-full">
              <Panel className="h-full">
                <div
                  role="tablist"
                  aria-label="Problem files"
                  className="border-border flex h-9 min-w-0 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b px-1.5"
                >
                  {visibleFiles.map((file, index) => {
                    const active = file.path === activeFilePath;
                    return (
                      <button
                        key={file.path}
                        id={`problem-file-tab-${index}`}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls="problem-file-editor"
                        tabIndex={active ? 0 : -1}
                        onKeyDown={handleTabKeyDown}
                        onClick={() => setActiveFile(file.path)}
                        className={cn(
                          "flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2 font-mono text-xs transition-colors",
                          active
                            ? "border-foreground text-foreground"
                            : "text-muted hover:text-foreground border-transparent",
                        )}
                      >
                        <icons.yaml className="text-subtle size-3.5" aria-hidden />
                        <span>{file.path}</span>
                        {file.access === "readonly" ? (
                          <icons.lock className="text-subtle size-3" aria-hidden />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <PanelHeader
                  className={cn(
                    "h-auto min-h-10 flex-wrap py-1 [&>div:last-child]:max-w-full [&>div:last-child]:shrink",
                    compact && "[&>div:first-child]:hidden [&>div:last-child]:w-full",
                  )}
                  title={
                    activeFile?.access === "readonly"
                      ? isBuild
                        ? "Architecture reference"
                        : "Reference manifest"
                      : isBuild
                        ? "Architecture manifests"
                        : "Editable manifest"
                  }
                  icon={<icons.yaml />}
                  actions={
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ToolbarButton
                        onClick={() => void handleApply()}
                        disabled={applying || validating || !sim.ready}
                        primary
                      >
                        <icons.run aria-hidden />
                        {applying
                          ? isBuild
                            ? "Reviewing..."
                            : "Applying..."
                          : isBuild
                            ? "Run Static Review"
                            : "Apply Changes"}
                      </ToolbarButton>
                      <ToolbarButton
                        onClick={() => void handleValidate()}
                        disabled={validating || applying || !sim.ready}
                        primary
                      >
                        <icons.validate aria-hidden />
                        {validating
                          ? "Validating..."
                          : isBuild
                            ? "Submit Static Review"
                            : "Run Validation"}
                      </ToolbarButton>
                      <ToolbarButton onClick={() => setCenterTab("diff")}>
                        <icons.diff aria-hidden />
                        Show Diff
                      </ToolbarButton>
                      <ToolbarButton
                        onClick={() => void handleReset()}
                        disabled={applying || validating || !sim.ready}
                      >
                        <icons.reset aria-hidden />
                        Reset
                      </ToolbarButton>
                    </div>
                  }
                />
                {applyFeedback ? (
                  <ApplyFeedbackBanner
                    feedback={applyFeedback}
                    onDismiss={() => setApplyFeedback(null)}
                  />
                ) : restoredFromStorage && !restoreNoticeDismissed ? (
                  <RestoredWorkBanner
                    onStartOver={() => {
                      setRestoreNoticeDismissedFor(level.slug);
                      void handleReset();
                    }}
                    onDismiss={() => setRestoreNoticeDismissedFor(level.slug)}
                  />
                ) : null}
                <div
                  id="problem-file-editor"
                  role="tabpanel"
                  aria-labelledby={activeFileTabId}
                  className="min-h-0 flex-1"
                >
                  <ErrorBoundary label="Editor">
                    <YamlEditor
                      path={activeFilePath || "manifest.yaml"}
                      value={files[activeFilePath] ?? ""}
                      readOnly={applying || validating || activeFile?.access !== "editable"}
                      onChange={(value) => {
                        if (activeFile?.access !== "editable") return;
                        setApplyFeedback(null);
                        setFile(activeFilePath, value);
                      }}
                    />
                  </ErrorBoundary>
                </div>
              </Panel>
            </ResizablePane>

            <ResizableHandle orientation="horizontal" aria-label="Resize investigation tools" />

            <ResizablePane id="center-tools" minSize="18%" className="h-full">
              <Panel className="h-full">
                <div className="border-border flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b pr-2">
                  <div
                    className="flex items-center"
                    role="tablist"
                    aria-label="Investigation tools"
                  >
                    {CENTER_TABS.map((tab) => {
                      const Icon = icons[tab.icon];
                      return (
                        <button
                          key={tab.id}
                          id={`investigation-tab-${tab.id}`}
                          type="button"
                          role="tab"
                          aria-selected={centerTab === tab.id}
                          aria-controls="investigation-panel"
                          tabIndex={centerTab === tab.id ? 0 : -1}
                          onKeyDown={handleTabKeyDown}
                          onClick={() => setCenterTab(tab.id)}
                          className={cn(
                            "flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
                            compact && "px-2 text-xs",
                            centerTab === tab.id
                              ? "border-foreground text-foreground"
                              : "text-muted hover:text-foreground border-transparent",
                          )}
                        >
                          <Icon className={cn("size-4", compact && "hidden")} aria-hidden />
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <ChallengeStatus
                      failing={checks ? checks.results.filter((r) => !r.passed).length : null}
                      total={
                        checks?.results.length ?? level.validators.length + level.constraints.length
                      }
                    />
                    <ScenarioStatus status={sim.status} />
                  </div>
                </div>

                <div
                  id="investigation-panel"
                  role="tabpanel"
                  aria-labelledby={activeInvestigationTabId}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {/* Quick commands: one-click investigation starters (beginner training wheels). */}
                  {centerTab === "terminal" ? (
                    <div
                      className={cn(
                        "border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-2",
                        compact ? "overflow-x-auto whitespace-nowrap" : "flex-wrap",
                      )}
                    >
                      <span className="text-subtle text-[11px] font-medium tracking-wide uppercase">
                        Try:
                      </span>
                      {level.quickCommands.map((quickCommand) => {
                        const resolvable =
                          resolveQuickCommand(quickCommand, sim.snapshot.pods) !== null;
                        return (
                          <button
                            key={quickCommand.id}
                            type="button"
                            disabled={!sim.ready || !resolvable}
                            onClick={() => runQuickCommand(quickCommand)}
                            className="border-border bg-panel-elevated text-muted hover:border-border-strong hover:text-foreground shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-40"
                          >
                            {quickCommand.command}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="min-h-0 flex-1">
                    <div className={cn("h-full", centerTab !== "terminal" && "hidden")}>
                      <ErrorBoundary label="Terminal">
                        <XtermTerminal
                          onCommand={runCommand}
                          registerRunner={(run) => {
                            terminalRunnerRef.current = run;
                          }}
                          welcome={[
                            `${BRAND.name} simulated shell, type 'help' for commands.`,
                            `Engine: ${
                              level.engine.kind === "webernetes"
                                ? "Webernetes"
                                : isBuild
                                  ? "static architecture policy review"
                                  : "scripted incident"
                            }`,
                            `Try: ${level.quickCommands[0]?.command ?? "kubectl get pods"}`,
                          ]}
                        />
                      </ErrorBoundary>
                    </div>
                    {centerTab === "logs" ? (
                      <LogsView
                        snapshot={sim.snapshot}
                        getLogs={(namespace, pod) => sim.engine.getLogs(namespace, pod)}
                        onInspect={inspectLogs}
                      />
                    ) : centerTab === "events" ? (
                      <div className="h-full overflow-auto">
                        <EventsTimeline
                          events={sim.snapshot.events}
                          namespace="*"
                          onInspect={inspectEvents}
                        />
                      </div>
                    ) : centerTab === "network" ? (
                      <NetworkProbe onProbe={handleProbe} presets={level.probeTargets} />
                    ) : centerTab === "diff" ? (
                      <ErrorBoundary label="Diff">
                        <DiffView
                          original={activeFile?.initialValue ?? ""}
                          modified={files[activeFilePath] ?? ""}
                        />
                      </ErrorBoundary>
                    ) : null}
                  </div>
                </div>
              </Panel>
            </ResizablePane>
          </ResizableGroup>
        </ResizablePane>

        <ResizableHandle
          orientation="vertical"
          className={compact ? "hidden" : undefined}
          aria-label="Resize cluster rail"
        />

        {/* A wider right rail keeps the topology square while leaving the explorer below it. */}
        <ResizablePane
          id="rail-right"
          defaultSize="33%"
          minSize={compact ? "0px" : "320px"}
          maxSize="42%"
          className={cn("h-full", compact && compactPane !== "inspect" && "hidden")}
        >
          <ResizableGroup
            orientation="vertical"
            id="level-inspector"
            defaultLayout={inspectorLayout.defaultLayout}
            onLayoutChanged={inspectorLayout.onLayoutChanged}
            className="h-full"
          >
            <ResizablePane id="level-topology" defaultSize="33vw" minSize="35%" className="h-full">
              <Panel className="h-full">
                <PanelHeader
                  title={isBuild ? "Design Inventory" : "Service Topology"}
                  icon={isBuild ? <icons.cluster /> : <icons.service />}
                />
                <PanelBody scroll={false} className="p-0" data-testid="problem-topology-body">
                  <ErrorBoundary label="Topology">
                    {isBuild ? (
                      <ArchitectureInventory level={level} files={files} />
                    ) : (
                      <ServiceTopology
                        snapshot={sim.snapshot}
                        namespaces={workspaceNamespaces}
                        onSelect={inspectTopology}
                      />
                    )}
                  </ErrorBoundary>
                </PanelBody>
              </Panel>
            </ResizablePane>

            <ResizableHandle orientation="horizontal" aria-label="Resize topology" />

            <ResizablePane id="level-inspector-details" minSize="15%" className="h-full">
              <Panel className="h-full">
                <PanelHeader
                  title={isBuild ? "Static Review Runtime" : "Cluster Explorer"}
                  icon={<icons.cluster />}
                />
                <ResizableGroup
                  orientation="vertical"
                  id="level-explorer"
                  defaultLayout={explorerLayout.defaultLayout}
                  onLayoutChanged={explorerLayout.onLayoutChanged}
                  className="min-h-0 flex-1"
                >
                  <ResizablePane
                    id="explorer-tree"
                    defaultSize="55%"
                    minSize="20%"
                    className="h-full"
                  >
                    <div className="h-full overflow-auto">
                      <ClusterExplorer
                        snapshot={sim.snapshot}
                        namespaces={workspaceNamespaces}
                        selected={selected}
                        onSelect={inspectObject}
                      />
                    </div>
                  </ResizablePane>
                  <ResizableHandle orientation="horizontal" aria-label="Resize object details" />
                  <ResizablePane id="explorer-details" minSize="20%" className="h-full">
                    <div className="h-full min-h-0 overflow-hidden">
                      <ObjectDetails snapshot={sim.snapshot} selected={selected} />
                    </div>
                  </ResizablePane>
                </ResizableGroup>
              </Panel>
            </ResizablePane>
          </ResizableGroup>
        </ResizablePane>
      </ResizableGroup>

      <ValidationDialog
        open={validationOpen}
        onOpenChange={setValidationOpen}
        report={validation}
        level={level}
      />
    </div>
  );
}

/** The simulator's own lifecycle: deliberately labeled so it can't be read as cluster health. */
function ApplyFeedbackBanner({
  feedback,
  onDismiss,
}: {
  feedback: ApplyFeedback;
  onDismiss: () => void;
}) {
  const isError = feedback.tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs",
        isError ? "border-red/30 bg-red/10 text-red" : "border-green/30 bg-green/10 text-green",
      )}
    >
      {isError ? (
        <icons.warning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <icons.success className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{feedback.title}</p>
        <p className="mt-0.5 break-words opacity-90">{feedback.message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="focus-visible:ring-ring -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
        aria-label="Dismiss apply status"
      >
        <icons.close className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Restoring silently would be worse than losing the work: the learner needs to know
 * the editor is not showing the authored starting point, and needs one obvious way
 * back to it.
 */
function RestoredWorkBanner({
  onStartOver,
  onDismiss,
}: {
  onStartOver: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-blue/30 bg-blue/10 text-blue flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs"
    >
      <icons.reset className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        Your previous edits were restored from this browser.
        <button
          type="button"
          onClick={onStartOver}
          className="focus-visible:ring-ring ml-1.5 font-medium underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Reset files
        </button>
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="focus-visible:ring-ring -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
        aria-label="Dismiss restored work notice"
      >
        <icons.close className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function ScenarioStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; dot: string }> = {
    booting: { label: "Scenario booting…", className: "text-amber", dot: "bg-amber" },
    ready: { label: "Scenario ready", className: "text-subtle", dot: "bg-green" },
    error: { label: "Scenario error", className: "text-red", dot: "bg-red" },
    idle: { label: "Scenario idle", className: "text-subtle", dot: "bg-amber" },
  };
  const entry = map[status] ?? map.idle!;
  return (
    <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span className={cn("size-1.5 rounded-full", entry.dot)} aria-hidden />
      <span className={entry.className}>{entry.label}</span>
    </span>
  );
}

/** The challenge's live health: the thing the learner is actually fixing. */
function ChallengeStatus({ failing, total }: { failing: number | null; total: number }) {
  if (failing === null) {
    return (
      <span className="border-border text-subtle rounded-full border px-2 py-0.5 text-xs whitespace-nowrap">
        Challenge: assessing…
      </span>
    );
  }
  if (failing === 0) {
    return (
      <span className="border-green/40 bg-green/10 text-green rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
        Challenge passing: run validation
      </span>
    );
  }
  return (
    <span className="border-red/40 bg-red/10 text-red rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      Challenge failing · {failing}/{total} checks
    </span>
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 [&_svg]:size-3.5",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-border bg-panel-elevated text-muted hover:bg-panel-hover hover:text-foreground border",
      )}
    >
      {children}
    </button>
  );
}
