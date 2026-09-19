import { and, desc, eq, ne, or } from "drizzle-orm";
import { getLevelBySlug } from "@/content/levels";
import type { SubmissionInput, SubmissionRecord } from "@/lib/problems/submission";
import type { ProgressDb } from "./progress-repo";
import { hintReveals, progressSolved, submissions } from "./schema";

export async function findSubmission(
  db: ProgressDb,
  userId: string,
  id: string,
): Promise<SubmissionRecord | null> {
  const [row] = await db
    .select({ results: submissions.results })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.clientMutationId, id),
        eq(submissions.verified, true),
      ),
    )
    .limit(1);
  return row ? (row.results as SubmissionRecord) : null;
}

/** Only called with a verdict produced by the server judge. Idempotent across retries. */
export async function recordVerifiedSubmission(
  db: ProgressDb,
  userId: string,
  input: SubmissionInput,
  record: SubmissionRecord,
): Promise<SubmissionRecord> {
  const currentLevel = getLevelBySlug(input.slug);
  if (
    !currentLevel ||
    currentLevel.contentVersion !== input.contentVersion ||
    record.contentVersion !== input.contentVersion
  )
    throw new Error("This problem version is no longer available");
  const hints = await db
    .select({ penalty: hintReveals.penalty })
    .from(hintReveals)
    .where(and(eq(hintReveals.userId, userId), eq(hintReveals.levelSlug, input.slug)));
  await db
    .insert(submissions)
    .values({
      userId,
      levelSlug: input.slug,
      contentVersion: input.contentVersion,
      verified: true,
      passed: record.report.passed,
      checksTotal: record.report.results.length,
      checksPassed: record.report.results.filter((result) => result.passed).length,
      durationMs: input.durationMs ?? null,
      hintsRevealed: hints.length,
      results: record,
      clientMutationId: input.clientMutationId,
    })
    .onConflictDoNothing({ target: [submissions.userId, submissions.clientMutationId] });
  const stored = await findSubmission(db, userId, input.clientMutationId);
  if (!stored) throw new Error("Submission could not be saved");
  if (
    stored.slug !== input.slug ||
    stored.contentVersion !== input.contentVersion ||
    Object.entries(input.files).some(([path, value]) => stored.files[path] !== value)
  )
    throw new Error("Submission identifier belongs to another revision");
  if (stored.report.passed) {
    const level = getLevelBySlug(stored.slug)!;
    await db
      .insert(progressSolved)
      .values({
        userId,
        levelSlug: level.slug,
        contentVersion: level.contentVersion,
        verified: true,
        awardedXp: Math.max(0, level.xp - hints.reduce((total, hint) => total + hint.penalty, 0)),
        solvedDay: stored.createdAt.slice(0, 10),
      })
      .onConflictDoUpdate({
        target: [progressSolved.userId, progressSolved.levelSlug],
        set: {
          verified: true,
          contentVersion: level.contentVersion,
          awardedXp: Math.max(0, level.xp - hints.reduce((total, hint) => total + hint.penalty, 0)),
          solvedDay: stored.createdAt.slice(0, 10),
        },
        setWhere: or(
          eq(progressSolved.verified, false),
          ne(progressSolved.contentVersion, level.contentVersion),
        ),
      });
  }
  return stored;
}

export async function listSubmissions(
  db: ProgressDb,
  userId: string,
  slug: string,
): Promise<SubmissionRecord[]> {
  const rows = await db
    .select({ results: submissions.results })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.levelSlug, slug),
        eq(submissions.verified, true),
      ),
    )
    .orderBy(desc(submissions.createdAt))
    .limit(20);
  return rows.map((row) => row.results as SubmissionRecord);
}
