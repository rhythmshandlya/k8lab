import { activeStreak, utcDay } from "@/lib/storage/streak";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { getLevelBySlug } from "@/content/levels";
import { getCurriculumCatalog } from "@/content/curriculum/server";
import type { ProblemLevel } from "@/lib/domain/types";
import { assertNever } from "@/lib/utils/exhaustive";
import { EMPTY_PROGRESS, type Progress } from "@/lib/storage/local-progress";
import type { ProgressIntent } from "@/lib/storage/progress-intent";

import {
  bookmarks,
  hintReveals,
  progressAttempted,
  progressCompletedLessons,
  progressSolved,
  submissions,
} from "./schema";
import type { schema } from "./schema";

/**
 * Server-side progress persistence. Every intent lowers to an idempotent, keyed
 * operation so applying a batch twice equals applying it once (safe under client
 * retries, concurrent devices, and guest→account merge). `readProgress` PROJECTS the
 * grow-only rows back into the exact `Progress` DTO the client already understands:
 * XP/streak/penalty are derived here, never stored as mutable totals.
 *
 * Typed against Drizzle's base `PgDatabase` so the same code runs on the Neon driver
 * (prod) and pglite (tests).
 */
export type ProgressDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class InvalidProgressIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProgressIntentError";
  }
}

export async function applyIntents(
  db: ProgressDb,
  userId: string,
  intents: readonly ProgressIntent[],
): Promise<void> {
  for (const intent of intents) validateCatalogIntent(intent);

  // Sequential (in client order) so a hint reveal is recorded before the solve that
  // nets it out, and so ordering-sensitive effects are deterministic.
  for (const intent of intents) {
    await applyOne(db, userId, intent);
  }
}

async function applyOne(db: ProgressDb, userId: string, intent: ProgressIntent): Promise<void> {
  switch (intent.kind) {
    case "solved":
      // Legacy client claims are acknowledged but cannot award verified progress.
      return;
    case "attempted":
      await db
        .insert(progressAttempted)
        .values({ userId, levelSlug: intent.slug })
        .onConflictDoNothing();
      return;
    case "completedLesson":
      await db
        .insert(progressCompletedLessons)
        .values({ userId, lessonSlug: intent.slug })
        .onConflictDoNothing();
      return;
    case "setSaved":
      if (intent.saved) {
        await db.insert(bookmarks).values({ userId, levelSlug: intent.slug }).onConflictDoNothing();
      } else {
        await db
          .delete(bookmarks)
          .where(and(eq(bookmarks.userId, userId), eq(bookmarks.levelSlug, intent.slug)));
      }
      return;
    case "revealHint": {
      const hint = requireLevel(intent.slug).hints.find(({ id }) => id === intent.hintId)!;
      await db
        .insert(hintReveals)
        .values({
          userId,
          levelSlug: intent.slug,
          hintId: intent.hintId,
          penalty: hint.xpPenalty,
        })
        .onConflictDoNothing();
      return;
    }
    case "submission":
      await db
        .insert(submissions)
        .values({
          userId,
          levelSlug: intent.slug,
          passed: intent.passed,
          checksTotal: intent.checksTotal,
          checksPassed: intent.checksPassed,
          durationMs: intent.durationMs ?? null,
          hintsRevealed: intent.hintsRevealed ?? null,
          results: intent.results ?? null,
          clientMutationId: intent.clientMutationId,
        })
        .onConflictDoNothing({ target: [submissions.userId, submissions.clientMutationId] });
      return;
    default:
      return assertNever(intent);
  }
}

function validateCatalogIntent(intent: ProgressIntent): void {
  if (intent.kind === "completedLesson") {
    if (!isKnownCompletionSlug(intent.slug)) {
      throw new InvalidProgressIntentError(
        `Unknown curriculum item ${JSON.stringify(intent.slug)}`,
      );
    }
    return;
  }
  const level = requireLevel(intent.slug);
  if (intent.kind === "revealHint" && !level.hints.some(({ id }) => id === intent.hintId)) {
    throw new InvalidProgressIntentError(
      `Unknown hint ${JSON.stringify(intent.hintId)} for level ${JSON.stringify(intent.slug)}`,
    );
  }
}

const COMPLETION_SLUGS = new Set([
  ...getCurriculumCatalog().sections.flatMap((section) =>
    section.lessons.map((lesson) => lesson.key),
  ),
  ...getCurriculumCatalog().missionSections.flatMap((section) =>
    section.missions.map((mission) => mission.key),
  ),
]);

export function isKnownCompletionSlug(slug: string): boolean {
  return COMPLETION_SLUGS.has(slug);
}

function requireLevel(slug: string): ProblemLevel {
  const level = getLevelBySlug(slug);
  if (!level) {
    throw new InvalidProgressIntentError(`Unknown problem level ${JSON.stringify(slug)}`);
  }
  return level;
}

export async function readProgress(db: ProgressDb, userId: string): Promise<Progress> {
  const [solved, attempted, completedLessons, saved, hints] = await Promise.all([
    db
      .select({
        slug: progressSolved.levelSlug,
        awardedXp: progressSolved.awardedXp,
        day: progressSolved.solvedDay,
        contentVersion: progressSolved.contentVersion,
      })
      .from(progressSolved)
      .where(and(eq(progressSolved.userId, userId), eq(progressSolved.verified, true))),
    db
      .select({ slug: progressAttempted.levelSlug })
      .from(progressAttempted)
      .where(eq(progressAttempted.userId, userId)),
    db
      .select({ slug: progressCompletedLessons.lessonSlug })
      .from(progressCompletedLessons)
      .where(eq(progressCompletedLessons.userId, userId)),
    db.select({ slug: bookmarks.levelSlug }).from(bookmarks).where(eq(bookmarks.userId, userId)),
    db
      .select({
        slug: hintReveals.levelSlug,
        hintId: hintReveals.hintId,
        penalty: hintReveals.penalty,
      })
      .from(hintReveals)
      .where(eq(hintReveals.userId, userId)),
  ]);

  const hintFacts: Record<string, Record<string, number>> = {};
  for (const row of hints) {
    hintFacts[row.slug] = { ...hintFacts[row.slug], [row.hintId]: row.penalty };
  }

  const currentSolves = solved.filter(
    (row) => getLevelBySlug(row.slug)?.contentVersion === row.contentVersion,
  );
  const { streakDays, lastSolvedDay } = deriveStreak(currentSolves.map((r) => r.day));

  return {
    ...EMPTY_PROGRESS,
    xp: currentSolves.reduce((sum, r) => sum + r.awardedXp, 0),
    streakDays,
    lastSolvedDay,
    solvedLevelSlugs: currentSolves.map((r) => r.slug),
    attemptedLevelSlugs: attempted.map((r) => r.slug),
    savedProblemSlugs: saved.map((r) => r.slug),
    completedLessonSlugs: completedLessons.map((r) => r.slug),
    hintReveals: hintFacts,
  };
}

/**
 * Current streak = length of the consecutive run of solved days ending on the most
 * recent one. Derived from the distinct set of client-local `solved_day` strings, so
 * it's timezone-correct and can't be corrupted by concurrent writes.
 */
export function deriveStreak(
  days: readonly string[],
  today = utcDay(),
): {
  streakDays: number;
  lastSolvedDay?: string;
} {
  const unique = [...new Set(days)].sort();
  const last = unique[unique.length - 1];
  if (!last) return { streakDays: 0 };
  let streak = 1;
  for (let i = unique.length - 1; i > 0; i--) {
    if (dayAfter(unique[i - 1]!) === unique[i]!) streak += 1;
    else break;
  }
  return { streakDays: activeStreak(streak, last, today), lastSolvedDay: last };
}

function dayAfter(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
