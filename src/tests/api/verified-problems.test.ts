import { expect, it } from "vitest";
import { getLevelBySlug } from "@/content/levels";
import { recordVerifiedSubmission, listSubmissions } from "@/lib/db/submission-repo";
import { readProblemDraft, writeProblemDraft } from "@/lib/db/problem-draft-repo";
import { applyIntents, deriveStreak, readProgress } from "@/lib/db/progress-repo";
import { mergeGuestProgress } from "@/lib/db/merge-repo";
import { EMPTY_PROGRESS } from "@/lib/storage/local-progress";
import type { SubmissionRecord } from "@/lib/problems/submission";
import { createTestDb, seedUser } from "./pglite";

it("awards only a verified current verdict, once, with server hint costs and immutable history", async () => {
  const { db, client } = await createTestDb();
  try {
    const owner = await seedUser(db),
      other = await seedUser(db, "other");
    const level = getLevelBySlug("broken-readiness-probe")!;
    await applyIntents(db, owner, [
      { kind: "revealHint", slug: level.slug, hintId: "hint-1", penalty: 0 },
    ]);
    const input = {
      slug: level.slug,
      contentVersion: level.contentVersion,
      files: { "pod.yaml": "immutable snapshot" },
      clientMutationId: crypto.randomUUID(),
    };
    const record: SubmissionRecord = {
      id: input.clientMutationId,
      slug: input.slug,
      contentVersion: input.contentVersion,
      judgeVersion: "test",
      files: input.files,
      report: {
        passed: true,
        results: [
          { id: "verified", title: "Pass", passed: true, detail: "Passed", label: "Passed" },
        ],
      },
      verified: true,
      createdAt: new Date().toISOString(),
    };
    await recordVerifiedSubmission(db, owner, input, record);
    await recordVerifiedSubmission(db, owner, input, record);
    expect((await readProgress(db, owner)).xp).toBe(85);
    expect((await readProgress(db, other)).xp).toBe(0);
    expect(await listSubmissions(db, owner, level.slug)).toEqual([record]);
    expect(await listSubmissions(db, other, level.slug)).toEqual([]);
    await expect(
      recordVerifiedSubmission(db, owner, { ...input, files: { "pod.yaml": "changed" } }, record),
    ).rejects.toThrow("another revision");
    await expect(
      recordVerifiedSubmission(db, owner, { ...input, contentVersion: 1 }, record),
    ).rejects.toThrow("no longer available");
    await mergeGuestProgress(db, owner, {
      ...EMPTY_PROGRESS,
      xp: 99999,
      solvedLevelSlugs: [level.slug],
    });
    expect((await readProgress(db, owner)).xp).toBe(85);
  } finally {
    await client.close();
  }
});

it("uses owner-scoped optimistic revisions for drafts and retains previous versions", async () => {
  const { db, client } = await createTestDb();
  try {
    const owner = await seedUser(db),
      other = await seedUser(db, "other");
    const draft = {
      slug: "broken-readiness-probe",
      contentVersion: 2,
      files: { "pod.yaml": "first" },
      activeFilePath: "pod.yaml",
      revealedHintIds: [],
      collectedEvidence: [],
      updatedAt: 1,
      serverRevision: 0,
    };
    const saved = await writeProblemDraft(db, owner, draft);
    expect(saved?.serverRevision).toBe(1);
    expect(
      await writeProblemDraft(db, owner, { ...draft, files: { "pod.yaml": "stale overwrite" } }),
    ).toBeNull();
    expect((await readProblemDraft(db, owner, draft.slug))?.files).toEqual(draft.files);
    expect(await readProblemDraft(db, other, draft.slug)).toBeNull();
    expect(
      (
        await writeProblemDraft(db, owner, {
          ...draft,
          serverRevision: 1,
          files: { "pod.yaml": "second" },
        })
      )?.serverRevision,
    ).toBe(2);
    expect((await writeProblemDraft(db, other, draft))?.serverRevision).toBe(1);
  } finally {
    await client.close();
  }
});

it("expires stale streaks and preserves a streak through the next UTC day", () => {
  expect(deriveStreak(["2026-09-17", "2026-09-18"], "2026-09-19").streakDays).toBe(2);
  expect(deriveStreak(["2026-09-17", "2026-09-18"], "2026-09-20").streakDays).toBe(0);
});
