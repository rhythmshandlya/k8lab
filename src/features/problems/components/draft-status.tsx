"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProblemLevel } from "@/lib/domain/types";
import { problemDraftSchema, type ProblemDraft } from "@/lib/problems/draft";
import {
  DRAFT_EVENT,
  draftSaveStatus,
  flushLevelWorkspace,
  readLevelWorkspace,
  saveLevelWorkspace,
} from "@/lib/storage/level-workspace";
import { PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";
import { getIdentity } from "@/lib/storage/progress-store";
import { useLevelStore } from "../level-store";

export function exportDraft(slug: string, files: Record<string, string>) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ slug, files }, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}-draft.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const subscribe = (callback: () => void) => {
  window.addEventListener(DRAFT_EVENT, callback);
  return () => window.removeEventListener(DRAFT_EVENT, callback);
};
function draftFor(level: ProblemLevel, revision: number): ProblemDraft {
  const state = useLevelStore.getState();
  return {
    slug: level.slug,
    contentVersion: level.contentVersion,
    files: state.files,
    activeFilePath: state.activeFilePath,
    revealedHintIds: state.revealedHintIds,
    collectedEvidence: state.collectedEvidence,
    updatedAt: Date.now(),
    serverRevision: revision,
  };
}
function signature(
  draft: Pick<ProblemDraft, "files" | "activeFilePath" | "revealedHintIds" | "collectedEvidence">,
) {
  return JSON.stringify([
    draft.files,
    draft.activeFilePath,
    draft.revealedHintIds,
    draft.collectedEvidence,
  ]);
}

export function DraftStatus({ level, owner }: { level: ProblemLevel; owner: string | null }) {
  const localStatus = useSyncExternalStore(
    subscribe,
    () => draftSaveStatus(level.slug, owner),
    () => "saved",
  );
  const recovered = useLevelStore((state) => state.recoveredFiles);
  const [cloudStatus, setCloudStatus] = useState(
    owner ? "Loading account draft…" : "Guest draft stored on this device",
  );
  const [conflict, setConflict] = useState<ProblemDraft | null>(null);
  const action = useRef<(restore: boolean) => void>(() => {});
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    if (!owner) return;
    let stopped = false,
      ready = false,
      saving = false,
      blocked = false,
      revision = 0,
      savedSignature = "";
    let timer: ReturnType<typeof setTimeout>;
    const headers = { "Content-Type": "application/json", [PROGRESS_OWNER_HEADER]: owner };
    const current = () =>
      !stopped && getIdentity() === owner && useLevelStore.getState().level?.slug === level.slug;
    let conflictDraft: ProblemDraft | null = null;
    const conflictWith = (draft: ProblemDraft) => {
      blocked = true;
      conflictDraft = draft;
      revision = draft.serverRevision;
      setConflict(draft);
      setCloudStatus("Another draft needs your review");
    };
    const persistRevision = () => {
      saveLevelWorkspace(draftFor(level, revision), owner);
      flushLevelWorkspace(level.slug, owner);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), 800);
    };
    const sync = async () => {
      if (!current() || !ready || saving || blocked) return;
      const draft = draftFor(level, revision);
      const fingerprint = signature(draft);
      if (fingerprint === savedSignature) return;
      saving = true;
      setCloudStatus("Saving to account…");
      try {
        const response = await fetch("/api/problems/draft", {
          method: "PUT",
          headers,
          body: JSON.stringify(draft),
        });
        const body = await response.json();
        if (!current()) return;
        if (response.status === 409 && body.draft) {
          conflictWith(problemDraftSchema.parse(body.draft));
          return;
        }
        if (!response.ok) throw new Error(body.error ?? "Account save failed");
        const remote = problemDraftSchema.parse(body.draft);
        revision = remote.serverRevision;
        savedSignature = fingerprint;
        persistRevision();
        setCloudStatus("Saved to account");
      } catch (error) {
        if (current())
          setCloudStatus(
            `${error instanceof Error ? error.message : "Account save failed"}. Retry or export your draft.`,
          );
      } finally {
        saving = false;
      }
      if (
        current() &&
        savedSignature === fingerprint &&
        signature(draftFor(level, revision)) !== fingerprint
      )
        schedule();
    };
    const load = async () => {
      try {
        const response = await fetch(`/api/problems/draft?slug=${encodeURIComponent(level.slug)}`, {
          headers,
        });
        const body = await response.json();
        if (!current()) return;
        if (!response.ok) throw new Error(body.error ?? "Account draft unavailable");
        const remote = body.draft ? problemDraftSchema.parse(body.draft) : null;
        if (body.previousDraft)
          useLevelStore.setState({
            recoveredFiles: problemDraftSchema.parse(body.previousDraft).files,
          });
        const local = readLevelWorkspace(level.slug, level.contentVersion, owner);
        if (remote && remote.contentVersion === level.contentVersion) {
          revision = remote.serverRevision;
          const state = useLevelStore.getState();
          const unchanged = level.files
            .filter((file) => file.access !== "hidden")
            .every((file) => state.files[file.path] === file.initialValue);
          if (!local && unchanged) {
            state.restoreDraft(remote.files);
            useLevelStore.setState({
              activeFilePath: remote.activeFilePath,
              revealedHintIds: remote.revealedHintIds,
              collectedEvidence: remote.collectedEvidence,
            });
            savedSignature = signature(draftFor(level, revision));
            persistRevision();
          } else if (JSON.stringify(state.files) === JSON.stringify(remote.files)) {
            savedSignature = signature(draftFor(level, revision));
            persistRevision();
          } else if (local?.serverRevision !== remote.serverRevision) {
            conflictWith(remote);
          }
        } else if (remote) {
          useLevelStore.setState({ recoveredFiles: remote.files });
        }
        ready = true;
        if (!blocked) {
          setCloudStatus("Account draft ready");
          schedule();
        }
      } catch (error) {
        if (current())
          setCloudStatus(
            `${error instanceof Error ? error.message : "Account draft unavailable"}. Retry or export your draft.`,
          );
      }
    };
    action.current = (restore) => {
      if (!current()) return;
      if (restore) {
        // The conflict snapshot is captured below by the state setter, never merged silently.
        if (conflictDraft) useLevelStore.getState().restoreDraft(conflictDraft.files);
      }
      setConflict(null);
      blocked = false;
      persistRevision();
      schedule();
    };
    retry.current = () => {
      if (ready) void sync();
      else void load();
    };
    let observed = signature(draftFor(level, revision));
    const unsubscribe = useLevelStore.subscribe(() => {
      if (!current()) return;
      const next = signature(draftFor(level, revision));
      if (next !== observed) {
        observed = next;
        schedule();
      }
    });
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [level, owner]);

  return (
    <div
      className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs"
      aria-live="polite"
    >
      <span>
        {localStatus === "failed"
          ? "Device save failed — your edits are still in memory."
          : localStatus === "saving"
            ? "Saving on device…"
            : cloudStatus}
      </span>
      {(localStatus === "failed" || cloudStatus.includes("Retry")) && (
        <button
          className="underline"
          onClick={() => {
            flushLevelWorkspace(level.slug, owner);
            retry.current();
          }}
        >
          Retry save
        </button>
      )}
      <button
        className="underline"
        onClick={() => exportDraft(level.slug, useLevelStore.getState().files)}
      >
        Export draft
      </button>
      {conflict && (
        <>
          <button className="underline" onClick={() => exportDraft(level.slug, conflict.files)}>
            Export account copy
          </button>
          <button className="underline" onClick={() => action.current(true)}>
            Restore account copy
          </button>
          <button className="underline" onClick={() => action.current(false)}>
            Keep this draft
          </button>
        </>
      )}
      {recovered && (
        <>
          <span>A draft from an older problem version is available.</span>
          <button className="underline" onClick={() => exportDraft(level.slug, recovered)}>
            Export older draft
          </button>
          <button
            className="underline"
            onClick={() => {
              useLevelStore.getState().restoreDraft(recovered);
              useLevelStore.setState({ recoveredFiles: null });
            }}
          >
            Restore compatible files
          </button>
        </>
      )}
    </div>
  );
}
