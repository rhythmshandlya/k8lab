import { describe, expect, it } from "vitest";

import { mergeGuestProgress } from "@/lib/db/merge-repo";
import { applyIntents, readProgress } from "@/lib/db/progress-repo";
import { mergeLog } from "@/lib/db/schema";
import { EMPTY_PROGRESS, type Progress } from "@/lib/storage/local-progress";

import { createTestDb, seedUser } from "./pglite";

// Uses real code-catalog slugs so xp reconstruction is exercised end to end.
// broken-readiness-probe is a 100-xp beginner level.
const GUEST: Progress = {
  ...EMPTY_PROGRESS,
  xp: 85,
  streakDays: 1,
  lastSolvedDay: "2026-07-08",
  solvedLevelSlugs: ["broken-readiness-probe"],
  hintReveals: { "broken-readiness-probe": { "hint-1": 9_999 } },
  attemptedLevelSlugs: ["service-selector-mismatch"],
  savedProblemSlugs: ["port-routing-bug"],
};

describe("mergeGuestProgress over pglite", () => {
  it("imports guest learning facts without trusting guest XP claims", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await mergeGuestProgress(db, uid, GUEST);
      const p = await readProgress(db, uid);

      expect(p.solvedLevelSlugs).toEqual([]);
      expect(p.attemptedLevelSlugs).toEqual(["service-selector-mismatch"]);
      expect(p.savedProblemSlugs).toEqual(["port-routing-bug"]);
      expect(p.hintReveals).toEqual({ "broken-readiness-probe": { "hint-1": 15 } });
      expect(p.xp).toBe(0); // Catalog XP and hint penalty replace forged guest values.
    } finally {
      await client.close();
    }
  });

  it("is idempotent: merging twice equals once", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await mergeGuestProgress(db, uid, GUEST);
      await mergeGuestProgress(db, uid, GUEST);
      const p = await readProgress(db, uid);

      expect(p.solvedLevelSlugs).toEqual([]);
      expect(p.hintReveals).toEqual({ "broken-readiness-probe": { "hint-1": 15 } });
      expect(p.xp).toBe(0); // NOT doubled
    } finally {
      await client.close();
    }
  });

  it("logs the semantic fingerprint so an exact replay cannot resurrect a bookmark", async () => {
    const { db, client } = await createTestDb();
    try {
      const uid = await seedUser(db);
      await mergeGuestProgress(db, uid, GUEST);
      await applyIntents(db, uid, [{ kind: "setSaved", slug: "port-routing-bug", saved: false }]);
      const replay = await mergeGuestProgress(db, uid, {
        ...GUEST,
        solvedLevelSlugs: ["broken-readiness-probe", "broken-readiness-probe"],
        attemptedLevelSlugs: ["service-selector-mismatch", "service-selector-mismatch"],
      });

      expect(replay.merged).toBe(false);
      expect((await readProgress(db, uid)).savedProblemSlugs).toEqual([]);
      expect(await db.select().from(mergeLog)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("scopes an identical fingerprint independently to each user", async () => {
    const { db, client } = await createTestDb();
    try {
      const a = await seedUser(db, "userA");
      const b = await seedUser(db, "userB");
      const first = await mergeGuestProgress(db, a, GUEST);
      const second = await mergeGuestProgress(db, b, GUEST);

      expect(first.fingerprint).toBe(second.fingerprint);
      expect(await db.select().from(mergeLog)).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
