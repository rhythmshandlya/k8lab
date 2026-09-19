import { and, eq } from "drizzle-orm";

import { getLevelBySlug } from "@/content/levels";
import { progressFingerprint, type Progress } from "@/lib/storage/local-progress";

import { isKnownCompletionSlug, type ProgressDb } from "./progress-repo";
import {
  bookmarks,
  hintReveals,
  progressAttempted,
  progressCompletedLessons,
  progressSolved,
  mergeLog,
} from "./schema";

/**
 * Merge a guest's localStorage Progress into a signed-in account. Idempotent by
 * construction (keyed upserts with GREATEST / DO NOTHING), so a repeated merge can't
 * double-count: the client also guards with a per-user marker.
 *
 * The guest blob stores only a TOTAL xp, not per-solve awards, so we reconstruct each
 * solve's awarded xp from the code catalog (gross level xp − imported hint penalty).
 * Because problems live in code, that lookup is available here on the server.
 */
export async function mergeGuestProgress(
  db: ProgressDb,
  userId: string,
  guest: Progress,
): Promise<{ fingerprint: string; merged: boolean }> {
  const fingerprint = await progressFingerprint(guest);
  const existing = await db
    .select({ fingerprint: mergeLog.fingerprint })
    .from(mergeLog)
    .where(and(eq(mergeLog.userId, userId), eq(mergeLog.fingerprint, fingerprint)))
    .limit(1);
  if (existing.length > 0) return { fingerprint, merged: false };

  // Import grow-only hint facts first. The (user, level, hint) primary key makes a
  // repeated guest merge idempotent without collapsing distinct reveals.
  for (const [slug, reveals] of Object.entries(guest.hintReveals)) {
    const level = getLevelBySlug(slug);
    if (!level) continue;
    for (const hintId of Object.keys(reveals)) {
      const hint = level.hints.find(({ id }) => id === hintId);
      if (!hint) continue;
      await db
        .insert(hintReveals)
        .values({ userId, levelSlug: slug, hintId, penalty: hint.xpPenalty })
        .onConflictDoNothing();
    }
  }

  const day = validDay(guest.lastSolvedDay) ? guest.lastSolvedDay : utcDay();
  for (const slug of guest.solvedLevelSlugs) {
    const level = getLevelBySlug(slug);
    if (!level) continue;
    const penaltyRows = await db
      .select({ penalty: hintReveals.penalty })
      .from(hintReveals)
      .where(and(eq(hintReveals.userId, userId), eq(hintReveals.levelSlug, slug)));
    const penalty = penaltyRows.reduce((sum, row) => sum + row.penalty, 0);
    const awardedXp = Math.max(0, level.xp - penalty);
    await db
      .insert(progressSolved)
      .values({ userId, levelSlug: slug, awardedXp, solvedDay: day })
      .onConflictDoNothing();
  }

  for (const slug of guest.attemptedLevelSlugs) {
    if (!getLevelBySlug(slug)) continue;
    await db.insert(progressAttempted).values({ userId, levelSlug: slug }).onConflictDoNothing();
  }
  for (const slug of guest.savedProblemSlugs) {
    if (!getLevelBySlug(slug)) continue;
    await db.insert(bookmarks).values({ userId, levelSlug: slug }).onConflictDoNothing();
  }
  for (const slug of guest.completedLessonSlugs) {
    if (!isKnownCompletionSlug(slug)) continue;
    await db
      .insert(progressCompletedLessons)
      .values({ userId, lessonSlug: slug })
      .onConflictDoNothing();
  }

  // Neon HTTP has no interactive cross-statement transaction. Claim after all
  // idempotent writes: a crash can replay safe upserts, but can never suppress facts.
  await db.insert(mergeLog).values({ userId, fingerprint }).onConflictDoNothing();
  return { fingerprint, merged: true };
}

function validDay(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
