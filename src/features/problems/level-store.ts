import { create } from "zustand";

import type { ProblemLevel } from "@/lib/domain/types";
import type { ValidationReport } from "@/lib/kube/validators";
import {
  clearLevelWorkspace,
  readLevelWorkspace,
  readArchivedWorkspace,
  saveLevelWorkspace,
} from "@/lib/storage/level-workspace";

/** Tabs in the center workspace's upper pane. */
export type CenterTab = "terminal" | "logs" | "events" | "network" | "diff";

export interface SelectedObject {
  kind: string;
  name: string;
  namespace: string;
}

interface LevelState {
  level: ProblemLevel | null;
  /** Current editor contents keyed by file path (starts from each file's initialValue). */
  files: Record<string, string>;
  activeFilePath: string;
  collectedEvidence: string[];
  revealedHintIds: string[];
  validation: ValidationReport | null;
  /**
   * Quietly refreshed check results (on boot, after Apply/Reset) that power the
   * "Failing checks" card and the challenge-status chip: separate from `validation`,
   * which is the formal Run Validation submission that can win the level.
   */
  checks: ValidationReport | null;
  validating: boolean;
  solved: boolean;
  centerTab: CenterTab;
  selected: SelectedObject | null;
  /** Hints are collapsed by default so investigation surfaces come first. */
  hintsOpen: boolean;
  /** True when this session's workspace was rehydrated from a previous visit. */
  restoredFromStorage: boolean;
  recoveredFiles: Record<string, string> | null;
  restoreDraft: (files: Record<string, string>) => void;

  initLevel: (level: ProblemLevel) => void;
  /** Discard saved work and return every editable file to its authored state. */
  resetFiles: () => void;
  setFile: (path: string, content: string) => void;
  setActiveFile: (path: string) => void;
  /** Merge newly-collected evidence ids; returns the ids that were not already present. */
  addEvidence: (ids: readonly string[]) => string[];
  revealHint: (id: string) => void;
  setValidation: (report: ValidationReport | null) => void;
  setChecks: (report: ValidationReport | null) => void;
  setValidating: (value: boolean) => void;
  setSolved: (value: boolean) => void;
  setCenterTab: (tab: CenterTab) => void;
  select: (object: SelectedObject | null) => void;
  setHintsOpen: (open: boolean) => void;
}

function filesFromLevel(level: ProblemLevel): Record<string, string> {
  return Object.fromEntries(
    level.files
      .filter((file) => file.access !== "hidden")
      .map((file) => [file.path, file.initialValue]),
  );
}

/**
 * Rehydrate saved work, but only where it still lines up with the authored level.
 * Content ships with the app, so a level can gain, lose, or lock a file between
 * visits; stale paths and edits to now-readonly files are dropped rather than
 * resurrected into a workspace that can no longer accept them.
 */
function restoreFiles(
  level: ProblemLevel,
  saved: Readonly<Record<string, string>>,
): { files: Record<string, string>; changed: boolean } {
  const files = filesFromLevel(level);
  let changed = false;
  for (const file of level.files) {
    if (file.access !== "editable") continue;
    const content = saved[file.path];
    if (typeof content !== "string" || content === file.initialValue) continue;
    files[file.path] = content;
    changed = true;
  }
  return { files, changed };
}

function persist(
  state: Pick<
    LevelState,
    "level" | "files" | "activeFilePath" | "revealedHintIds" | "collectedEvidence"
  >,
): void {
  if (!state.level) return;
  saveLevelWorkspace({
    slug: state.level.slug,
    contentVersion: state.level.contentVersion,
    files: state.files,
    activeFilePath: state.activeFilePath,
    revealedHintIds: state.revealedHintIds,
    collectedEvidence: state.collectedEvidence,
  });
}

export const useLevelStore = create<LevelState>((set, get) => ({
  level: null,
  files: {},
  activeFilePath: "",
  collectedEvidence: [],
  revealedHintIds: [],
  validation: null,
  checks: null,
  validating: false,
  solved: false,
  centerTab: "terminal",
  selected: null,
  hintsOpen: false,
  restoredFromStorage: false,
  recoveredFiles: null,

  restoreDraft: (saved) => {
    const state = get();
    if (!state.level) return;
    const { files } = restoreFiles(state.level, saved);
    persist({ ...state, files });
    set({ files, validation: null, checks: null, solved: false, restoredFromStorage: true });
  },

  initLevel: (level) => {
    const stored = readLevelWorkspace(level.slug, level.contentVersion);
    const saved = stored?.contentVersion === level.contentVersion ? stored : null;
    const { files, changed } = restoreFiles(level, saved?.files ?? {});
    const visiblePaths = new Set(
      level.files.filter((file) => file.access !== "hidden").map((file) => file.path),
    );
    const fallbackPath =
      level.files.find((file) => file.access === "editable")?.path ??
      level.files.find((file) => file.access !== "hidden")?.path ??
      "";
    const ruleIds = new Set(level.evidenceRules.map((rule) => rule.evidenceId));
    const hintIds = new Set(level.hints.map((hint) => hint.id));

    set({
      level,
      files,
      activeFilePath:
        saved && visiblePaths.has(saved.activeFilePath) ? saved.activeFilePath : fallbackPath,
      collectedEvidence: (saved?.collectedEvidence ?? []).filter((id) => ruleIds.has(id)),
      revealedHintIds: (saved?.revealedHintIds ?? []).filter((id) => hintIds.has(id)),
      validation: null,
      checks: null,
      validating: false,
      solved: false,
      centerTab: "terminal",
      selected: null,
      hintsOpen: false,
      restoredFromStorage: changed,
      recoveredFiles:
        stored && !saved ? stored.files : (readArchivedWorkspace(level.slug)?.files ?? null),
    });
  },

  resetFiles: () => {
    const level = get().level;
    if (!level) return;
    clearLevelWorkspace(level.slug);
    set({
      files: filesFromLevel(level),
      activeFilePath:
        level.files.find((file) => file.access === "editable")?.path ??
        level.files.find((file) => file.access !== "hidden")?.path ??
        "",
      validation: null,
      checks: null,
      solved: false,
      restoredFromStorage: false,
    });
  },

  setFile: (path, content) =>
    set((state) => {
      const file = state.level?.files.find((candidate) => candidate.path === path);
      if (!file || file.access !== "editable" || state.files[path] === content) return state;
      const next = { ...state, files: { ...state.files, [path]: content } };
      persist(next);
      return { files: next.files, validation: null, checks: null, solved: false };
    }),

  setActiveFile: (path) =>
    set((state) => {
      persist({ ...state, activeFilePath: path });
      return { activeFilePath: path };
    }),

  addEvidence: (ids) => {
    const state = get();
    const fresh = ids.filter((id) => !state.collectedEvidence.includes(id));
    if (fresh.length === 0) return fresh;
    const collectedEvidence = [...state.collectedEvidence, ...fresh];
    persist({ ...state, collectedEvidence });
    set({ collectedEvidence });
    return fresh;
  },

  revealHint: (id) =>
    set((state) => {
      if (state.revealedHintIds.includes(id)) return state;
      const revealedHintIds = [...state.revealedHintIds, id];
      persist({ ...state, revealedHintIds });
      return { revealedHintIds };
    }),

  setValidation: (report) => set({ validation: report }),
  setChecks: (report) => set({ checks: report }),
  setValidating: (value) => set({ validating: value }),
  setSolved: (value) => set({ solved: value }),
  setCenterTab: (tab) => set({ centerTab: tab }),
  select: (object) => set({ selected: object }),
  setHintsOpen: (open) => set({ hintsOpen: open }),
}));
