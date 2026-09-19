import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLevelBySlug } from "@/content/levels";
import { useLevelStore } from "@/features/problems/level-store";
import {
  clearLevelWorkspace,
  flushLevelWorkspace,
  saveLevelWorkspace,
} from "@/lib/storage/level-workspace";

describe("problem level file store", () => {
  const level = getLevelBySlug("broken-readiness-probe")!;

  beforeEach(() => {
    window.localStorage.clear();
    useLevelStore.getState().initLevel(level);
  });

  afterEach(() => clearLevelWorkspace(level.slug));

  it("invalidates the displayed verdict and quiet checks when the submitted files change", () => {
    const store = useLevelStore.getState();
    const passed = { passed: true, results: [] };
    store.setValidation(passed);
    store.setChecks(passed);
    store.setSolved(true);
    store.setFile("pod.yaml", "edited after submission");
    expect(useLevelStore.getState()).toMatchObject({
      validation: null,
      checks: null,
      solved: false,
    });
    store.setChecks(passed);
    store.resetFiles();
    expect(useLevelStore.getState().checks).toBeNull();
  });

  it("restores edits, active file, hints, and evidence from this content version", () => {
    const store = useLevelStore.getState();
    store.setFile("pod.yaml", "edited");
    store.setActiveFile("service.yaml");
    store.revealHint(level.hints[0]!.id);
    store.addEvidence([level.evidenceRules[0]!.evidenceId]);
    flushLevelWorkspace(level.slug);

    useLevelStore.getState().initLevel(level);
    const restored = useLevelStore.getState();
    expect(restored.files["pod.yaml"]).toBe("edited");
    expect(restored.activeFilePath).toBe("service.yaml");
    expect(restored.revealedHintIds).toContain(level.hints[0]!.id);
    expect(restored.collectedEvidence).toContain(level.evidenceRules[0]!.evidenceId);
    expect(restored.restoredFromStorage).toBe(true);
  });

  it("does not restore a workspace authored for another content version", () => {
    saveLevelWorkspace({
      slug: level.slug,
      contentVersion: level.contentVersion + 1,
      files: { "pod.yaml": "stale" },
      activeFilePath: "pod.yaml",
      revealedHintIds: [],
      collectedEvidence: [],
    });
    flushLevelWorkspace(level.slug);

    useLevelStore.getState().initLevel(level);
    expect(useLevelStore.getState().files["pod.yaml"]).toBe(
      level.files.find((file) => file.path === "pod.yaml")!.initialValue,
    );
    expect(useLevelStore.getState().restoredFromStorage).toBe(false);
  });

  it("exposes editable and reference files and starts on the editable file", () => {
    expect(Object.keys(useLevelStore.getState().files).sort()).toEqual([
      "pod.yaml",
      "service.yaml",
    ]);
    expect(useLevelStore.getState().activeFilePath).toBe("pod.yaml");
  });

  it("updates editable files but rejects writes to reference files", () => {
    const initial = useLevelStore.getState().files;
    useLevelStore.getState().setFile("pod.yaml", "edited");
    useLevelStore.getState().setFile("service.yaml", "forbidden");

    expect(useLevelStore.getState().files["pod.yaml"]).toBe("edited");
    expect(useLevelStore.getState().files["service.yaml"]).toBe(initial["service.yaml"]);
  });
});
