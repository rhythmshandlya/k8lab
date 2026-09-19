import { z } from "zod";
export const problemDraftSchema = z
  .object({
    slug: z.string().min(1).max(120),
    contentVersion: z.number().int().positive(),
    files: z.record(z.string().max(240), z.string().max(100_000)),
    activeFilePath: z.string().max(240),
    revealedHintIds: z.array(z.string().max(120)).max(100),
    collectedEvidence: z.array(z.string().max(120)).max(100),
    updatedAt: z.number().nonnegative(),
    serverRevision: z.number().int().nonnegative().default(0),
  })
  .refine(
    (draft) =>
      Object.keys(draft.files).length <= 64 &&
      Object.values(draft.files).reduce((total, file) => total + file.length, 0) <= 250_000,
  );
export type ProblemDraft = z.infer<typeof problemDraftSchema>;
