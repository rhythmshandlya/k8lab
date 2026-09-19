import { describe, expect, it } from "vitest";

import { applyIntents } from "@/lib/db/progress-repo";
import { readLevelStats } from "@/lib/db/stats-repo";
import type { ProgressIntent } from "@/lib/storage/progress-intent";
import { submissions } from "@/lib/db/schema";

import { createTestDb, seedUser } from "./pglite";

let submissionSequence = 0;
const sub = (slug: string, passed: boolean, durationMs?: number): ProgressIntent => {
  submissionSequence += 1;
  return {
    kind: "submission",
    slug,
    passed,
    checksTotal: 3,
    checksPassed: passed ? 3 : 1,
    durationMs,
    clientMutationId: `stats-submission-${submissionSequence.toString().padStart(6, "0")}`,
  };
};

describe("readLevelStats over pglite", () => {
  it("computes success rate and avg solve time per slug across users", async () => {
    const { db, client } = await createTestDb();
    try {
      const a = await seedUser(db, "userA");
      const b = await seedUser(db, "userB");
      const c = await seedUser(db, "userC");

      const x = "broken-readiness-probe";
      const y = "port-routing-bug";
      // A solves (60s), B solves (120s), C only fails → 2/3 solved.
      await applyIntents(db, a, [sub(x, false), sub(x, true, 60_000)]);
      await applyIntents(db, b, [sub(x, true, 120_000)]);
      await applyIntents(db, c, [sub(x, false)]);
      // Only A attempts y and fails → 0/1.
      await applyIntents(db, a, [sub(y, false)]);

      expect(await readLevelStats(db)).toEqual({}); // Client telemetry is never authoritative.
      // Seed server-verified rows to exercise the aggregate independently of the judge.
      await db.update(submissions).set({ verified: true, contentVersion: 2 });

      const stats = await readLevelStats(db);

      expect(stats[x]!.sampleSize).toBe(3); // A, B, C attempted
      expect(stats[x]!.solvers).toBe(2); // A, B solved
      expect(stats[x]!.successRate).toBeCloseTo(2 / 3, 5);
      expect(stats[x]!.avgSolveMs).toBe(90_000); // (60s + 120s) / 2

      expect(stats[y]!.sampleSize).toBe(1);
      expect(stats[y]!.solvers).toBe(0);
      expect(stats[y]!.successRate).toBe(0);
      expect(stats[y]!.avgSolveMs).toBeNull();
    } finally {
      await client.close();
    }
  });
});
