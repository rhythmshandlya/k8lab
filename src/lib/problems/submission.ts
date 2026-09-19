import { z } from "zod";
import type { ValidationReport } from "@/lib/kube/validators";

export const JUDGE_VERSION = "2026-09-19.1";
export const submissionInputSchema = z
  .object({
    slug: z.string().min(1).max(120),
    contentVersion: z.number().int().positive(),
    files: z.record(z.string().max(240), z.string().max(100_000)),
    clientMutationId: z.string().uuid(),
    revealedHintIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .refine(
    (input) =>
      Object.keys(input.files).length <= 64 &&
      Object.values(input.files).reduce((size, file) => size + file.length, 0) <= 250_000,
    "A submission must contain at most 64 files and 250 KB of YAML",
  );

export type SubmissionInput = z.infer<typeof submissionInputSchema>;
export interface SubmissionRecord {
  id: string;
  slug: string;
  contentVersion: number;
  judgeVersion: string;
  files: Record<string, string>;
  report: ValidationReport;
  createdAt: string;
  verified: boolean;
}
