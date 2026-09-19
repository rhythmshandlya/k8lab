import { describe, expect, it } from "vitest";

import { applyIntents, deriveStreak, readProgress } from "@/lib/db/progress-repo";
import { submissions } from "@/lib/db/schema";
import type { ProgressIntent } from "@/lib/storage/progress-intent";

import { createTestDb, seedUser } from "./pglite";

describe("deriveStreak", () => {
  it("is zero with no solves", () => {
    expect(deriveStreak([])).toEqual({ streakDays: 0 });
  });

  it("counts a single day as a 1-day streak", () => {
    expect(deriveStreak(["2026-07-09"], "2026-07-09")).toEqual({
      streakDays: 1,
      lastSolvedDay: "2026-07-09",
    });
  });

  it("counts consecutive days and ignores duplicates", () => {
    expect(
      deriveStreak(["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-09"], "2026-07-09"),
    ).toEqual({
      streakDays: 3,
      lastSolvedDay: "2026-07-09",
    });
  });

  it("resets the run at a gap, counting only the streak ending on the last day", () => {
    expect(deriveStreak(["2026-07-01", "2026-07-08", "2026-07-09"], "2026-07-09")).toEqual({
      streakDays: 2,
      lastSolvedDay: "2026-07-09",
    });
  });

  it("crosses a month boundary", () => {
    expect(deriveStreak(["2026-06-30", "2026-07-01"], "2026-07-01")).toEqual({
      streakDays: 2,
      lastSolvedDay: "2026-07-01",
    });
  });
});

describe("progress-repo over pglite", () => {
  const LEVEL = "broken-readiness-probe";
  const INTENTS: ProgressIntent[] = [
    { kind: "attempted", slug: LEVEL },
    { kind: "revealHint", slug: LEVEL, hintId: "hint-1", penalty: 9_999 },
    { kind: "solved", slug: LEVEL, xp: 9_999, day: "2026-07-08" },
    { kind: "setSaved", slug: "port-routing-bug", saved: true },
    { kind: "completedLesson", slug: "networking/services" },
    {
      kind: "submission",
      slug: LEVEL,
      passed: true,
      checksTotal: 3,
      checksPassed: 3,
      durationMs: 42_000,
      clientMutationId: "submission-test-00000001",
    },
  ];

  it("applies intents and projects the derived Progress snapshot", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await applyIntents(db, uid, INTENTS);
      const p = await readProgress(db, uid);

      expect(p.solvedLevelSlugs).toEqual([]);
      expect(p.attemptedLevelSlugs).toEqual([LEVEL]);
      expect(p.savedProblemSlugs).toEqual(["port-routing-bug"]);
      expect(p.completedLessonSlugs).toEqual(["networking/services"]);
      expect(p.hintReveals).toEqual({ [LEVEL]: { "hint-1": 15 } });
      expect(p.xp).toBe(0); // Catalog values win over the forged client values.
      expect(p.streakDays).toBe(0);
      expect(p.lastSolvedDay).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("is idempotent: applying the same batch twice equals once", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await applyIntents(db, uid, INTENTS);
      await applyIntents(db, uid, INTENTS);
      const p = await readProgress(db, uid);

      expect(p.solvedLevelSlugs).toEqual([]);
      expect(p.hintReveals).toEqual({ [LEVEL]: { "hint-1": 15 } });
      expect(p.xp).toBe(0); // NOT doubled
      expect(p.savedProblemSlugs).toEqual(["port-routing-bug"]);
      expect(p.completedLessonSlugs).toEqual(["networking/services"]); // NOT duplicated
    } finally {
      await client.close();
    }
  });

  it("setSaved is absolute: a false intent removes the bookmark", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await applyIntents(db, uid, [{ kind: "setSaved", slug: "port-routing-bug", saved: true }]);
      await applyIntents(db, uid, [{ kind: "setSaved", slug: "port-routing-bug", saved: false }]);
      const p = await readProgress(db, uid);
      expect(p.savedProblemSlugs).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("keeps two users' progress isolated", async () => {
    const { db, client } = await createTestDb();
    try {
      const a = await seedUser(db, "userA");
      const b = await seedUser(db, "userB");
      await applyIntents(db, a, [
        { kind: "solved", slug: "broken-readiness-probe", xp: 1, day: "2026-07-08" },
      ]);
      await applyIntents(db, b, [
        { kind: "solved", slug: "rolling-update-gone-wrong", xp: 1, day: "2026-07-08" },
      ]);

      expect((await readProgress(db, a)).solvedLevelSlugs).toEqual([]);
      expect((await readProgress(db, a)).xp).toBe(0);
      expect((await readProgress(db, b)).solvedLevelSlugs).toEqual([]);
      expect((await readProgress(db, b)).xp).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("deduplicates submission retries per user rather than globally", async () => {
    const { db, client } = await createTestDb();
    try {
      const a = await seedUser(db, "userA");
      const b = await seedUser(db, "userB");
      const submission: ProgressIntent = {
        kind: "submission",
        slug: LEVEL,
        passed: true,
        checksTotal: 3,
        checksPassed: 3,
        clientMutationId: "shared-submission-000001",
      };

      await applyIntents(db, a, [submission]);
      await applyIntents(db, a, [submission]);
      await applyIntents(db, b, [submission]);

      expect(await db.select().from(submissions)).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("rejects unknown catalog facts before applying any part of a batch", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await expect(
        applyIntents(db, uid, [
          { kind: "attempted", slug: LEVEL },
          { kind: "revealHint", slug: LEVEL, hintId: "not-a-hint", penalty: 0 },
        ]),
      ).rejects.toThrow("Unknown hint");

      expect((await readProgress(db, uid)).attemptedLevelSlugs).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
