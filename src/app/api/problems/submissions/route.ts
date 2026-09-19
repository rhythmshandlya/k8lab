import { getAuth } from "@/lib/auth/server";
import { getLevelBySlug } from "@/content/levels";
import { applyIntents } from "@/lib/db/progress-repo";
import { getDb, hasDb } from "@/lib/db";
import {
  findSubmission,
  listSubmissions,
  recordVerifiedSubmission,
} from "@/lib/db/submission-repo";
import { isAuthConfigured } from "@/lib/env";
import { judgeSubmission } from "@/lib/problems/judge";
import { submissionInputSchema } from "@/lib/problems/submission";
import { allowRequest } from "@/lib/rate-limit";
import { PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";

export const runtime = "nodejs";
export const maxDuration = 90;
// Webernetes uses a process-local log sink. Admit one isolated judge at a time per
// process; additional requests retry rather than sharing runtime state or queuing forever.
let judging = false;

async function owner(request: Request): Promise<string | Response> {
  if (!isAuthConfigured() || !hasDb())
    return Response.json({ error: "Account storage is not configured" }, { status: 501 });
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: "Sign in to save a verified submission" }, { status: 401 });
  if (request.headers.get(PROGRESS_OWNER_HEADER) !== session.user.id)
    return Response.json(
      { error: "Account changed; submit again from the current account" },
      { status: 409 },
    );
  return session.user.id;
}

export async function GET(request: Request) {
  const userId = await owner(request);
  if (userId instanceof Response) return userId;
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug || slug.length > 120)
    return Response.json({ error: "Missing problem" }, { status: 400 });
  return Response.json({ submissions: await listSubmissions(getDb(), userId, slug) });
}

export async function POST(request: Request) {
  const userId = await owner(request);
  if (userId instanceof Response) return userId;
  if (!(await allowRequest(`judge:${userId}`, { limit: 10, windowSec: 60 })))
    return Response.json({ error: "Too many submissions; try again in a minute" }, { status: 429 });
  const source = await request.text();
  if (source.length > 300_000)
    return Response.json({ error: "Submission exceeds 300 KB" }, { status: 413 });
  const parsed = submissionInputSchema.safeParse(
    await Promise.resolve()
      .then(() => JSON.parse(source))
      .catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: "Invalid submission", details: parsed.error.flatten() },
      { status: 400 },
    );
  const db = getDb();
  const level = getLevelBySlug(parsed.data.slug);
  if (!level || level.contentVersion !== parsed.data.contentVersion)
    return Response.json(
      { error: "This problem version is no longer available. Reload before submitting." },
      { status: 409 },
    );
  const revealed = parsed.data.revealedHintIds ?? [];
  if (revealed.some((id) => !level.hints.some((hint) => hint.id === id)))
    return Response.json({ error: "Unknown hint" }, { status: 400 });
  await applyIntents(
    db,
    userId,
    revealed.map((hintId) => ({ kind: "revealHint", slug: level.slug, hintId, penalty: 0 })),
  );
  const existing = await findSubmission(db, userId, parsed.data.clientMutationId);
  if (existing) {
    if (
      existing.slug !== parsed.data.slug ||
      existing.contentVersion !== parsed.data.contentVersion ||
      Object.entries(parsed.data.files).some(([path, value]) => existing.files[path] !== value)
    )
      return Response.json(
        { error: "Submission ID was already used for different files" },
        { status: 409 },
      );
    return Response.json(await recordVerifiedSubmission(db, userId, parsed.data, existing));
  }
  if (judging)
    return Response.json(
      { error: "The judge is busy. Your draft is saved; retry shortly." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  judging = true;
  try {
    const record = await judgeSubmission(parsed.data);
    return Response.json(await recordVerifiedSubmission(db, userId, parsed.data, record));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Submission failed; retry without changing your files",
      },
      { status: 422 },
    );
  } finally {
    judging = false;
  }
}
