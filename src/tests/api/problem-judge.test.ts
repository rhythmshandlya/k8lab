import { expect, it } from "vitest";
import { LEVEL_SOLUTIONS } from "@/content/levels/solutions";
import { LEVELS } from "@/content/levels";
import { judgeSubmission } from "@/lib/problems/judge";

it.each(LEVELS)(
  "server judge accepts the canonical solution for $slug",
  async (level) => {
    const record = await judgeSubmission({
      slug: level.slug,
      contentVersion: level.contentVersion,
      files: {
        ...Object.fromEntries(
          level.files
            .filter((file) => file.access === "editable")
            .map((file) => [file.path, file.initialValue]),
        ),
        ...LEVEL_SOLUTIONS[level.slug]!.files,
      },
      clientMutationId: crypto.randomUUID(),
    });
    expect(record.report.passed, JSON.stringify(record.report)).toBe(true);
    expect(record.verified).toBe(true);
  },
  90_000,
);
