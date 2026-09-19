import { and, eq, or, type AnyColumn } from "drizzle-orm";
import { LEVELS } from "@/content/levels";

/** Old or unverified attempts must not enter current scores or public aggregates. */
export function currentProblemFilter(columns: {
  verified: AnyColumn;
  levelSlug: AnyColumn;
  contentVersion: AnyColumn;
}) {
  return and(
    eq(columns.verified, true),
    or(
      ...LEVELS.map((level) =>
        and(eq(columns.levelSlug, level.slug), eq(columns.contentVersion, level.contentVersion)),
      ),
    ),
  );
}
