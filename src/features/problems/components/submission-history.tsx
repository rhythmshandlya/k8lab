"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { ProblemLevel } from "@/lib/domain/types";
import type { SubmissionRecord } from "@/lib/problems/submission";
import { PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";
import { useLevelStore } from "../level-store";
import { exportDraft } from "./draft-status";

const historySchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    contentVersion: z.number(),
    judgeVersion: z.string(),
    createdAt: z.string(),
    verified: z.boolean(),
    files: z.record(z.string(), z.string()),
    report: z.object({
      passed: z.boolean(),
      results: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          passed: z.boolean(),
          detail: z.string(),
          diagnostic: z.string().optional(),
          label: z.string(),
        }),
      ),
    }),
  }),
);
const guestKey = (slug: string) => `klab:submission-history:guest:${slug}`;
export function saveGuestSubmission(record: SubmissionRecord): void {
  const previous = historySchema.safeParse(
    JSON.parse(localStorage.getItem(guestKey(record.slug)) ?? "[]"),
  );
  localStorage.setItem(
    guestKey(record.slug),
    JSON.stringify([record, ...(previous.success ? previous.data : [])].slice(0, 20)),
  );
}
export function SubmissionHistory({
  level,
  owner,
  latest,
  disabled,
}: {
  level: ProblemLevel;
  owner: string | null;
  latest: SubmissionRecord | null;
  disabled: boolean;
}) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = owner
          ? await fetch(`/api/problems/submissions?slug=${encodeURIComponent(level.slug)}`, {
              headers: { [PROGRESS_OWNER_HEADER]: owner },
            })
          : null;
        const body = response
          ? await response.json()
          : { submissions: JSON.parse(localStorage.getItem(guestKey(level.slug)) ?? "[]") };
        if (response && !response.ok) throw new Error(body.error ?? "History unavailable");
        const parsed = historySchema.parse(body.submissions);
        if (!cancelled) {
          setRecords(parsed);
          setError("");
        }
      } catch {
        if (!cancelled) setError("Submission history could not load. Your editor is unchanged.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [level.slug, owner, latest, refresh]);
  const visible =
    latest && !records.some((record) => record.id === latest.id)
      ? [latest, ...records].slice(0, 20)
      : records;
  return (
    <details className="border-border rounded border p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        Submission history ({visible.length})
      </summary>
      <p className="text-muted my-2">
        Latest 20 attempts.{" "}
        {owner
          ? "Only verified results for the current problem version count toward account XP. Submit older or imported guest solves again to verify them."
          : "Guest results are stored on this device and do not count toward account rankings."}{" "}
        Restoring files requires Apply before submitting.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="underline" onClick={() => setRefresh((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {visible.length === 0 && !error && <p>No submissions yet.</p>}
      <ol className="space-y-2">
        {visible.map((record) => (
          <li key={record.id} className="border-border rounded border p-2">
            <details>
              <summary className="cursor-pointer">
                {record.report.passed ? "Passed" : "Failed"} ·{" "}
                {new Date(record.createdAt).toLocaleString()} · v{record.contentVersion} ·{" "}
                {record.verified ? "Verified" : "Guest"}
              </summary>
              <p className="text-subtle mt-1">Judge {record.judgeVersion}</p>
              <ul className="my-2 space-y-1">
                {record.report.results.map((result) => (
                  <li key={result.id}>
                    {result.passed ? "✓" : "✗"} {result.title}: {result.diagnostic ?? result.detail}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button
                  className="underline"
                  disabled={disabled}
                  onClick={() => useLevelStore.getState().restoreDraft(record.files)}
                >
                  Restore compatible files
                </button>
                <button className="underline" onClick={() => exportDraft(level.slug, record.files)}>
                  Export files
                </button>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
