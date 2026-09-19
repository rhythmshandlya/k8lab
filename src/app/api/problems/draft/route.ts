import { getLevelBySlug } from "@/content/levels";
import { getAuth } from "@/lib/auth/server";
import { getDb, hasDb } from "@/lib/db";
import { readProblemDraft, writeProblemDraft } from "@/lib/db/problem-draft-repo";
import { isAuthConfigured } from "@/lib/env";
import { problemDraftSchema } from "@/lib/problems/draft";
import { allowRequest } from "@/lib/rate-limit";
import { PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";

async function owner(request: Request): Promise<string | Response> {
  if (!isAuthConfigured() || !hasDb())
    return Response.json({ error: "Account storage unavailable" }, { status: 501 });
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "Sign in required" }, { status: 401 });
  if (request.headers.get(PROGRESS_OWNER_HEADER) !== session.user.id)
    return Response.json({ error: "Account changed" }, { status: 409 });
  return session.user.id;
}

export async function GET(request: Request) {
  const userId = await owner(request);
  if (userId instanceof Response) return userId;
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug || !getLevelBySlug(slug))
    return Response.json({ error: "Unknown problem" }, { status: 404 });
  const [draft, previousDraft] = await Promise.all([
    readProblemDraft(getDb(), userId, slug),
    readProblemDraft(getDb(), userId, slug, getLevelBySlug(slug)!.contentVersion),
  ]);
  return Response.json({ draft, previousDraft });
}

export async function PUT(request: Request) {
  const userId = await owner(request);
  if (userId instanceof Response) return userId;
  if (!(await allowRequest(`draft:${userId}`, { limit: 120, windowSec: 60 })))
    return Response.json({ error: "Rate limited" }, { status: 429 });
  const source = await request.text();
  if (source.length > 300_000) return Response.json({ error: "Draft too large" }, { status: 413 });
  const parsed = problemDraftSchema.safeParse(
    await Promise.resolve()
      .then(() => JSON.parse(source))
      .catch(() => null),
  );
  if (!parsed.success) return Response.json({ error: "Invalid draft" }, { status: 400 });
  const level = getLevelBySlug(parsed.data.slug);
  if (!level || level.contentVersion !== parsed.data.contentVersion)
    return Response.json({ error: "Reload this problem version before saving" }, { status: 409 });
  const draft = await writeProblemDraft(getDb(), userId, parsed.data);
  if (!draft)
    return Response.json(
      {
        error: "A newer draft was saved on another device",
        draft: await readProblemDraft(getDb(), userId, level.slug),
      },
      { status: 409 },
    );
  const validPaths = new Map(
    level.files.filter((file) => file.access !== "hidden").map((file) => [file.path, file]),
  );
  if (
    !validPaths.has(parsed.data.activeFilePath) ||
    Object.entries(parsed.data.files).some(([path, value]) => {
      const file = validPaths.get(path);
      return !file || (file.access !== "editable" && value !== file.initialValue);
    }) ||
    parsed.data.revealedHintIds.some((id) => !level.hints.some((hint) => hint.id === id)) ||
    parsed.data.collectedEvidence.some(
      (id) => !level.evidenceRules.some((rule) => rule.evidenceId === id),
    )
  )
    return Response.json(
      { error: "Draft contains fields outside this problem's workspace" },
      { status: 400 },
    );
  return Response.json({ draft });
}
