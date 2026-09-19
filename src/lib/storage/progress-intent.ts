import { z } from "zod";

import { assertNever } from "@/lib/utils/exhaustive";

import {
  progressSchema,
  recordAttempted,
  recordHintPenalty,
  recordLessonCompleted,
  recordSolved,
  type Progress,
} from "./local-progress";

/**
 * A progress mutation expressed as a named, idempotent INTENT rather than a whole-blob
 * write. This is the wire format between client and server: the client applies an
 * intent optimistically to its local cache (via `applyIntent`, which reuses the
 * existing pure reducers so guest behavior is unchanged) AND pushes it to the server,
 * where each intent lowers to an idempotent keyed upsert. XP/streak/penalty are never
 * transmitted as totals: they are derived on each side from grow-only facts.
 *
 * `solved` intents retain guest/offline compatibility only. Account awards now come
 * exclusively from verified submissions; this legacy intent cannot award server XP.
 */
export type ProgressIntent =
  | { kind: "solved"; slug: string; xp: number; day: string }
  | { kind: "attempted"; slug: string }
  | { kind: "completedLesson"; slug: string }
  | { kind: "setSaved"; slug: string; saved: boolean }
  | { kind: "revealHint"; slug: string; hintId: string; penalty: number }
  | {
      kind: "submission";
      slug: string;
      passed: boolean;
      checksTotal: number;
      checksPassed: number;
      durationMs?: number;
      hintsRevealed?: number;
      results?: unknown;
      clientMutationId: string;
    };

const slugSchema = z.string().trim().min(1).max(120);
const solvedDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month! - 1 &&
      date.getUTCDate() === day
    );
  }, "Invalid calendar date")
  .refine(
    (value) => value <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    "Solve date cannot be in the future",
  );

const submissionIntentSchema = z.object({
  kind: z.literal("submission"),
  slug: slugSchema,
  passed: z.boolean(),
  checksTotal: z.number().int().min(1).max(500),
  checksPassed: z.number().int().nonnegative().max(500),
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 60 * 60 * 1000)
    .optional(),
  hintsRevealed: z.number().int().nonnegative().max(100).optional(),
  results: z.unknown().optional(),
  clientMutationId: z.string().trim().min(16).max(128),
});

export const progressIntentSchema: z.ZodType<ProgressIntent> = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("solved"),
      slug: slugSchema,
      xp: z.number().int().nonnegative().max(10_000),
      day: solvedDaySchema,
    }),
    z.object({ kind: z.literal("attempted"), slug: slugSchema }),
    z.object({ kind: z.literal("completedLesson"), slug: slugSchema }),
    z.object({ kind: z.literal("setSaved"), slug: slugSchema, saved: z.boolean() }),
    z.object({
      kind: z.literal("revealHint"),
      slug: slugSchema,
      hintId: z.string().trim().min(1).max(120),
      penalty: z.number().int().nonnegative().max(10_000),
    }),
    submissionIntentSchema,
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "submission" &&
      value.passed !== (value.checksPassed === value.checksTotal)
    ) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "Verdict must agree with the check counts",
      });
    }
    if (value.kind === "submission" && value.checksPassed > value.checksTotal) {
      context.addIssue({
        code: "custom",
        path: ["checksPassed"],
        message: "checksPassed cannot exceed checksTotal",
      });
    }
  });

const ownerIdSchema = z.string().trim().min(1).max(512);
const deliveryIdSchema = z.string().trim().min(16).max(128);

export type ProgressDelivery = {
  id: string;
  ownerId: string;
  createdAt: number;
  intent: ProgressIntent;
};

export const progressDeliverySchema: z.ZodType<ProgressDelivery> = z.object({
  id: deliveryIdSchema,
  ownerId: ownerIdSchema,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  intent: progressIntentSchema,
});

const progressBatchSchema = z
  .object({
    ownerId: ownerIdSchema,
    deliveries: z.array(progressDeliverySchema).min(1).max(500),
  })
  .superRefine(({ ownerId, deliveries }, context) => {
    deliveries.forEach((delivery, index) => {
      if (delivery.ownerId !== ownerId) {
        context.addIssue({
          code: "custom",
          path: ["deliveries", index, "ownerId"],
          message: "delivery owner does not match batch owner",
        });
      }
    });
  });

export type ProgressBatch = z.infer<typeof progressBatchSchema>;

const progressSyncResponseSchema = z.object({
  ownerId: ownerIdSchema,
  acknowledgedIds: z.array(deliveryIdSchema).max(500),
  progress: progressSchema,
});

export type ProgressSyncResponse = z.infer<typeof progressSyncResponseSchema>;

const mergeRequestSchema = z.object({ ownerId: ownerIdSchema, progress: progressSchema });
const mergeResponseSchema = z.object({
  ownerId: ownerIdSchema,
  fingerprint: z.string().min(8).max(128),
  progress: progressSchema,
});

export type MergeRequest = z.infer<typeof mergeRequestSchema>;
export type MergeResponse = z.infer<typeof mergeResponseSchema>;

/** Intended-owner header required by progress reads. */
export const PROGRESS_OWNER_HEADER = "x-klab-progress-owner";

/** Validate a POST body `{ intents: [...] }` into a typed intent list. */
export function parseIntents(body: unknown): ProgressIntent[] {
  return z.object({ intents: z.array(progressIntentSchema).max(500) }).parse(body).intents;
}

export function parseProgressDelivery(value: unknown): ProgressDelivery {
  return progressDeliverySchema.parse(value);
}

export function parseProgressBatch(body: unknown): ProgressBatch {
  return progressBatchSchema.parse(body);
}

export function parseProgressSyncResponse(body: unknown): ProgressSyncResponse {
  return progressSyncResponseSchema.parse(body);
}

export function parseMergeRequest(body: unknown): MergeRequest {
  return mergeRequestSchema.parse(body);
}

export function parseMergeResponse(body: unknown): MergeResponse {
  return mergeResponseSchema.parse(body);
}

let fallbackMutationSequence = 0;

/** Create the ID once before queueing so retries reuse the same submission fact. */
export function createClientMutationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackMutationSequence += 1;
  return `${Date.now().toString(36)}-${fallbackMutationSequence.toString(36).padStart(8, "0")}`;
}

/**
 * Apply an intent to a local Progress snapshot, reusing the existing pure reducers so
 * the optimistic client path stays behaviorally identical to today. `submission` is
 * history-only and doesn't change the Progress blob.
 */
export function applyIntent(progress: Progress, intent: ProgressIntent): Progress {
  switch (intent.kind) {
    case "solved":
      return recordSolved(progress, intent.slug, intent.xp, intent.day);
    case "attempted":
      return recordAttempted(progress, intent.slug);
    case "completedLesson":
      return recordLessonCompleted(progress, intent.slug);
    case "setSaved": {
      const has = progress.savedProblemSlugs.includes(intent.slug);
      if (intent.saved === has) return progress;
      return {
        ...progress,
        savedProblemSlugs: intent.saved
          ? [...progress.savedProblemSlugs, intent.slug]
          : progress.savedProblemSlugs.filter((s) => s !== intent.slug),
      };
    }
    case "revealHint":
      return recordHintPenalty(progress, intent.slug, intent.hintId, intent.penalty);
    case "submission":
      return progress;
    default:
      return assertNever(intent);
  }
}

export function applyIntents(progress: Progress, intents: readonly ProgressIntent[]): Progress {
  return intents.reduce(applyIntent, progress);
}
