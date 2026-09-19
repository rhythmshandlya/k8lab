import { describe, expect, it, vi } from "vitest";
import { loadAll, dump } from "js-yaml";
import { getLevelBySlug } from "@/content/levels";
import { LEVEL_SOLUTIONS } from "@/content/levels/solutions";
import { createProblemEngine } from "@/lib/kube/problem-engine";
import { evaluateWorkspaceSemantics } from "@/lib/kube/workspace-semantics";
import { parseKubernetesManifests } from "@/lib/kube/manifest-parser";
import { parseCommand } from "@/lib/kube/command-runner";
import { evaluateLevelConstraints } from "@/lib/kube/manifest-constraints";
import {
  draftSaveStatus,
  flushLevelWorkspace,
  readLevelWorkspace,
  saveLevelWorkspace,
} from "@/lib/storage/level-workspace";

function solved(slug: string) {
  const level = getLevelBySlug(slug)!;
  return {
    level,
    files: {
      ...Object.fromEntries(
        level.files
          .filter((file) => file.access !== "hidden")
          .map((file) => [file.path, file.initialValue]),
      ),
      ...LEVEL_SOLUTIONS[slug]!.files,
    },
  };
}
describe("production regression probes", () => {
  it.each(["true", "echo drained", "exit 0", "sleep 1", "sleep 10; exit 1"])(
    "does not count an unproven preStop hook as a drain: %s",
    (command) => {
      const { level, files } = solved("graceful-shutdown-502s");
      for (const [path, source] of Object.entries(files)) {
        const docs = loadAll(source) as any[];
        const deployment = docs.find((doc) => doc?.kind === "Deployment");
        if (!deployment) continue;
        deployment.spec.template.spec.containers[0].lifecycle = {
          preStop: { exec: { command: ["sh", "-c", command] } },
        };
        files[path] = docs.map((doc) => dump(doc)).join("---\n");
      }
      expect(evaluateLevelConstraints(level, files).some((result) => !result.passed)).toBe(true);
    },
  );
  it("binds a verdict to the applied revision, including queued operations", async () => {
    const { level, files } = solved("all-replicas-one-failure-domain");
    const engine = createProblemEngine(level.engine);
    try {
      await engine.boot(level);
      expect((await engine.validate(level, files)).passed).toBe(false);
      const applying = engine.applyFiles(files);
      const validating = engine.validate(level, files);
      expect((await applying).ok).toBe(true);
      expect((await validating).passed).toBe(true);
      const changed = {
        ...files,
        [Object.keys(files)[0]!]: `${Object.values(files)[0]}\n# edited after apply`,
      };
      expect((await engine.validate(level, changed)).results).toContainEqual(
        expect.objectContaining({ id: "unapplied-files", passed: false }),
      );
    } finally {
      await engine.close();
    }
  });

  it.each(["nodeName", "nodeSelector", "command", "port", "probe"])(
    "rejects a valid-looking fixture with contradictory %s",
    (mutation) => {
      const { level, files } = solved("all-replicas-one-failure-domain");
      for (const [path, source] of Object.entries(files)) {
        const docs = loadAll(source) as any[];
        const deployment = docs.find((doc) => doc?.kind === "Deployment");
        if (!deployment) continue;
        const pod = deployment.spec.template.spec;
        if (mutation === "nodeName") pod.nodeName = "not-a-node";
        if (mutation === "nodeSelector") pod.nodeSelector = { impossible: "true" };
        if (mutation === "command") pod.containers[0].command = ["sh", "-c", "exit 1"];
        if (mutation === "port") pod.containers[0].ports = [{ containerPort: 70000 }];
        if (mutation === "probe")
          pod.containers[0].readinessProbe = {
            httpGet: { path: "/", port: 8080 },
            exec: { command: ["true"] },
          };
        files[path] = docs.map((doc) => dump(doc)).join("---\n");
      }
      expect(evaluateWorkspaceSemantics(level, files).length).toBeGreaterThan(0);
    },
  );

  it.each([
    "kubectl apply -f deployment.yaml --dry-run=server",
    "kubectl delete pod app --force",
    "kubectl get pods -o json",
    "kubectl get pods --sort-by=.metadata.name",
  ])("rejects unsupported semantics: %s", (command) =>
    expect(parseCommand(command).kind).toBe("unsupported"),
  );
  it("rejects cyclic aliases before schema or runtime evaluation", () => {
    expect(
      parseKubernetesManifests(
        "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: test}\ndata: &loop {recursive: *loop}",
      ).ok,
    ).toBe(false);
  });
  it("isolates drafts by owner, retains over 40 levels, and exposes quota failures", () => {
    localStorage.clear();
    const draft = {
      slug: "draft-test",
      contentVersion: 2,
      files: { "pod.yaml": "private" },
      activeFilePath: "pod.yaml",
      revealedHintIds: [],
      collectedEvidence: [],
    };
    saveLevelWorkspace(draft, "a");
    flushLevelWorkspace(draft.slug, "a");
    expect(readLevelWorkspace(draft.slug, 2, "b")).toBeNull();
    expect(readLevelWorkspace(draft.slug, 2, null)).toBeNull();
    for (let index = 0; index < 45; index++) {
      saveLevelWorkspace({ ...draft, slug: `extra-${index}` }, "a");
      flushLevelWorkspace(`extra-${index}`, "a");
    }
    expect(readLevelWorkspace(draft.slug, 2, "a")?.files).toEqual(draft.files);
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    saveLevelWorkspace({ ...draft, files: { "pod.yaml": "unsaved" } }, "a");
    expect(flushLevelWorkspace(draft.slug, "a")).toBe(false);
    expect(draftSaveStatus(draft.slug, "a")).toBe("failed");
    expect(readLevelWorkspace(draft.slug, 2, "a")?.files["pod.yaml"]).toBe("unsaved");
    storage.mockRestore();
    expect(flushLevelWorkspace(draft.slug, "a")).toBe(true);
  });
});
