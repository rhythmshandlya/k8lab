import { getLevelBySlug } from "@/content/levels";
import { createProblemEngine } from "@/lib/kube/problem-engine";
import { evaluateLevelConstraints } from "@/lib/kube/manifest-constraints";
import { evaluateWorkspaceSemantics } from "@/lib/kube/workspace-semantics";
import { initialWorkspace } from "@/lib/kube/workspace-revision";
import type { ValidationReport } from "@/lib/kube/validators";
import { JUDGE_VERSION, type SubmissionInput, type SubmissionRecord } from "./submission";

/** Execute a new, bounded simulator for this immutable submission. No client verdict is trusted. */
export async function judgeSubmission(input: SubmissionInput): Promise<SubmissionRecord> {
  const level = getLevelBySlug(input.slug);
  if (!level || level.contentVersion !== input.contentVersion)
    throw new Error(
      "This problem version is no longer available. Reload the problem and submit again.",
    );
  const known = new Map(level.files.map((file) => [file.path, file]));
  for (const [path, value] of Object.entries(input.files)) {
    const file = known.get(path);
    if (
      !file ||
      file.access === "hidden" ||
      (file.access !== "editable" && value !== file.initialValue)
    )
      throw new Error(`File ${path} is not editable in this problem`);
  }
  for (const file of level.files.filter((file) => file.access === "editable")) {
    if (!(file.path in input.files)) throw new Error(`Missing submitted file ${file.path}`);
  }
  const files = { ...initialWorkspace(level), ...input.files };
  const issues = evaluateWorkspaceSemantics(level, files);
  const constraints = evaluateLevelConstraints(level, files);
  let report: ValidationReport = {
    passed: false,
    results: [
      ...constraints,
      ...issues.map((detail, index) => ({
        id: `validity-${index}`,
        title: "Kubernetes validity",
        detail,
        diagnostic: detail,
        passed: false,
        label: "Correct the manifest",
      })),
    ],
  };
  if (issues.length === 0 && constraints.every((check) => check.passed)) {
    const engine = createProblemEngine(level.engine);
    try {
      const boot = await engine.boot(level);
      if (!boot.ok) throw new Error(`Judge could not start: ${boot.error}`);
      const applied = await engine.applyFiles(
        Object.fromEntries(
          level.files
            .filter((file) => file.access === "editable")
            .map((file) => [file.path, files[file.path]!]),
        ),
      );
      if (!applied.ok) {
        report.results.push({
          id: "apply",
          title: "Apply submitted files",
          passed: false,
          detail: applied.error,
          label: "Apply failed",
        });
      } else {
        const deadline = Date.now() + 60_000;
        do {
          report = await engine.validate(level, files);
          if (report.passed || level.engine.kind !== "webernetes") break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
      }
    } finally {
      await engine.close();
    }
  }
  return {
    id: input.clientMutationId,
    slug: level.slug,
    contentVersion: level.contentVersion,
    judgeVersion: JUDGE_VERSION,
    files,
    report,
    createdAt: new Date().toISOString(),
    verified: true,
  };
}
