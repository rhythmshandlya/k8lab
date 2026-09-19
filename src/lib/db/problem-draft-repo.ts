import { and, desc, eq, lt } from "drizzle-orm";
import type { ProblemDraft } from "@/lib/problems/draft";
import { problemDrafts } from "./schema";
import type { ProgressDb } from "./progress-repo";

export async function readProblemDraft(
  db: ProgressDb,
  userId: string,
  slug: string,
  beforeVersion?: number,
): Promise<ProblemDraft | null> {
  const [row] = await db
    .select()
    .from(problemDrafts)
    .where(
      and(
        eq(problemDrafts.userId, userId),
        eq(problemDrafts.levelSlug, slug),
        beforeVersion === undefined ? undefined : lt(problemDrafts.contentVersion, beforeVersion),
      ),
    )
    .orderBy(desc(problemDrafts.contentVersion))
    .limit(1);
  return row
    ? {
        ...(row.snapshot as ProblemDraft),
        updatedAt: row.updatedAt.getTime(),
        serverRevision: row.revision,
      }
    : null;
}

export async function writeProblemDraft(
  db: ProgressDb,
  userId: string,
  draft: ProblemDraft,
): Promise<ProblemDraft | null> {
  const now = new Date();
  const snapshot = { ...draft, updatedAt: now.getTime(), serverRevision: draft.serverRevision + 1 };
  const rows =
    draft.serverRevision === 0
      ? await db
          .insert(problemDrafts)
          .values({
            userId,
            levelSlug: draft.slug,
            contentVersion: draft.contentVersion,
            snapshot,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning()
      : await db
          .update(problemDrafts)
          .set({ snapshot, updatedAt: now, revision: draft.serverRevision + 1 })
          .where(
            and(
              eq(problemDrafts.userId, userId),
              eq(problemDrafts.levelSlug, draft.slug),
              eq(problemDrafts.contentVersion, draft.contentVersion),
              eq(problemDrafts.revision, draft.serverRevision),
            ),
          )
          .returning();
  return rows.length ? snapshot : null;
}
