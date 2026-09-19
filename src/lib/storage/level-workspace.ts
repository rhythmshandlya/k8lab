import { problemDraftSchema, type ProblemDraft } from "@/lib/problems/draft";
import { getIdentity } from "./progress-store";

const PREFIX = "klab:level-workspace:v3:";
export const DRAFT_EVENT = "klab:draft";
export type LevelWorkspaceSnapshot = ProblemDraft;
export type DraftSaveStatus = "saved" | "saving" | "failed";
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const queued = new Map<string, ProblemDraft>();
const statuses = new Map<string, DraftSaveStatus>();
function keyFor(slug: string, owner: string | null) {
  return `${PREFIX}${owner === null ? "guest" : `user:${encodeURIComponent(owner)}`}:${slug}`;
}
function status(key: string, value: DraftSaveStatus) {
  statuses.set(key, value);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAFT_EVENT));
}
export function draftSaveStatus(
  slug: string,
  owner: string | null = getIdentity(),
): DraftSaveStatus {
  return statuses.get(keyFor(slug, owner)) ?? "saved";
}
export function readLevelWorkspace(
  slug: string,
  _contentVersion: number,
  owner: string | null = getIdentity(),
): ProblemDraft | null {
  const key = keyFor(slug, owner);
  if (queued.has(key)) return queued.get(key)!;
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.localStorage.getItem(key) ??
      (owner === null ? window.localStorage.getItem(`klab:level-workspace:v2:${slug}`) : null);
    const parsed = raw ? problemDraftSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success && parsed.data.slug === slug ? parsed.data : null;
  } catch {
    return null;
  }
}
export function saveLevelWorkspace(
  snapshot: Omit<ProblemDraft, "updatedAt" | "serverRevision"> &
    Partial<Pick<ProblemDraft, "updatedAt" | "serverRevision">>,
  owner: string | null = getIdentity(),
): void {
  if (typeof window === "undefined") return;
  const key = keyFor(snapshot.slug, owner);
  const previous = readLevelWorkspace(snapshot.slug, snapshot.contentVersion, owner);
  queued.set(key, {
    ...snapshot,
    updatedAt: snapshot.updatedAt ?? Date.now(),
    serverRevision: snapshot.serverRevision ?? previous?.serverRevision ?? 0,
  });
  clearTimeout(pending.get(key));
  status(key, "saving");
  pending.set(
    key,
    setTimeout(() => flushLevelWorkspace(snapshot.slug, owner), 400),
  );
}
export function flushLevelWorkspace(slug: string, owner: string | null = getIdentity()): boolean {
  const key = keyFor(slug, owner);
  clearTimeout(pending.get(key));
  pending.delete(key);
  const snapshot = queued.get(key);
  if (!snapshot || typeof window === "undefined") return true;
  try {
    const old =
      window.localStorage.getItem(key) ??
      (owner === null ? window.localStorage.getItem(`klab:level-workspace:v2:${slug}`) : null);
    if (old) {
      const parsed = problemDraftSchema.safeParse(JSON.parse(old));
      if (parsed.success && parsed.data.contentVersion !== snapshot.contentVersion)
        window.localStorage.setItem(
          `${key}:archive:${parsed.data.contentVersion}:${parsed.data.updatedAt}`,
          old,
        );
    }
    window.localStorage.setItem(key, JSON.stringify(snapshot));
    queued.delete(key);
    status(key, "saved");
    return true;
  } catch {
    // Keep the unsaved data in memory so retry and export can recover it.
    status(key, "failed");
    return false;
  }
}
export function clearLevelWorkspace(slug: string, owner: string | null = getIdentity()): void {
  const key = keyFor(slug, owner);
  clearTimeout(pending.get(key));
  pending.delete(key);
  queued.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
    if (owner === null) window.localStorage.removeItem(`klab:level-workspace:v2:${slug}`);
    status(key, "saved");
  } catch {
    status(key, "failed");
  }
}

export function readArchivedWorkspace(
  slug: string,
  owner: string | null = getIdentity(),
): ProblemDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const prefix = `${keyFor(slug, owner)}:archive:`;
    return (
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => problemDraftSchema.safeParse(JSON.parse(localStorage.getItem(key)!)))
        .filter((result) => result.success)
        .map((result) => result.data!)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  } catch {
    return null;
  }
}
