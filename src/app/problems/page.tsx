import type { Metadata } from "next";
import { Suspense } from "react";

import { LEVEL_CATALOG, type LevelSummary } from "@/content/levels";
import { getDb, hasDb } from "@/lib/db";
import { readLevelStats } from "@/lib/db/stats-repo";
import { ProblemsDashboard } from "@/features/problems/components/problems-dashboard";

export const metadata: Metadata = { title: "Problems" };

// Revalidate the (public, aggregate) stats hourly; the catalog itself is static code.
export const revalidate = 3600;

/** Show aggregate telemetry only after enough server-verified attempts. */
const MIN_SAMPLE = 20;

/**
 * Server component. The catalog is static code; when a database is configured we
 * overlay server-verified success rate + average solve time from submission telemetry.
 * These are explicitly labeled in the UI; browser-side validation is not presented as
 * server-verified truth. Below the sample floor, authored estimates remain visible.
 */
export default async function ProblemsPage() {
  const catalog = await buildCatalog();
  return (
    <Suspense
      fallback={
        <div className="text-muted mx-auto w-full max-w-[1500px] px-4 py-12 text-sm" aria-busy>
          Loading problem catalog...
        </div>
      }
    >
      <ProblemsDashboard catalog={catalog} />
    </Suspense>
  );
}

async function buildCatalog(): Promise<LevelSummary[]> {
  if (!hasDb()) return [...LEVEL_CATALOG];
  try {
    const stats = await readLevelStats(getDb());
    return LEVEL_CATALOG.map((level) => {
      const stat = stats[level.slug];
      if (!stat || stat.sampleSize < MIN_SAMPLE) return { ...level };
      return {
        ...level,
        successRate: Math.round(stat.successRate * 100),
        estimatedMinutes: stat.avgSolveMs
          ? Math.max(1, Math.round(stat.avgSolveMs / 60000))
          : level.estimatedMinutes,
        statsSource: "server-verified",
        statsSampleSize: stat.sampleSize,
      };
    });
  } catch {
    // DB unreachable / not migrated: fall back to the authored catalog.
    return [...LEVEL_CATALOG];
  }
}
