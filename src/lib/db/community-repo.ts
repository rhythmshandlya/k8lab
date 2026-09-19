import { and, count, desc, eq, gte, lt, max, sql, sum } from "drizzle-orm";

import type { ProgressDb } from "./progress-repo";
import { progressSolved, user } from "./schema";
import { currentProblemFilter } from "./verified-problem-filter";

/**
 * Read-only community aggregates over existing tables (no schema changes):
 * leaderboard + activity feed from `progress_solved`, plus the session user's rank.
 * All queries are public-aggregate shaped;
 * the /community page caches them with ISR, and only the rank endpoint is per-user.
 *
 * Solve durations are browser-measured telemetry, not server-verified truth: the UI
 * labels records accordingly (same stance as stats-repo).
 */

export interface LeaderboardEntry {
  userId: string;
  name: string;
  image: string | null;
  isAnonymous: boolean;
  xp: number;
  solves: number;
  lastSolvedAt: string;
}

export interface RecentSolve {
  name: string;
  image: string | null;
  isAnonymous: boolean;
  levelSlug: string;
  solvedAt: string;
}

export interface UserRank {
  rank: number;
  totalRanked: number;
  xp: number;
}

export interface CommunityPulse {
  players: number;
  solvesThisWeek: number;
}

export interface UserCommunityStatus {
  publicProfile: boolean;
  solveCount: number;
  rank: UserRank | null;
}

/** Headline liveness numbers: everyone who ever solved, and solves in the last 7 days. */
export async function readCommunityPulse(db: ProgressDb): Promise<CommunityPulse> {
  const rows = await db
    .select({
      players: sql<number>`count(distinct ${progressSolved.userId})`.mapWith(Number),
      solvesThisWeek:
        sql<number>`count(*) filter (where ${progressSolved.solvedAt} > now() - interval '7 days')`.mapWith(
          Number,
        ),
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(and(eq(user.publicProfile, true), currentProblemFilter(progressSolved)));
  const row = rows[0];
  return { players: row?.players ?? 0, solvesThisWeek: row?.solvesThisWeek ?? 0 };
}

/** Top users by total XP (ties broken by solve count, then recency). */
export async function readLeaderboard(db: ProgressDb, limit: number): Promise<LeaderboardEntry[]> {
  const xp = sum(progressSolved.awardedXp).mapWith(Number);
  const solves = count(progressSolved.levelSlug);
  const lastSolvedAt = max(progressSolved.solvedAt);
  const rows = await db
    .select({
      userId: progressSolved.userId,
      name: user.name,
      image: user.image,
      isAnonymous: user.isAnonymous,
      xp,
      solves,
      lastSolvedAt,
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(and(eq(user.publicProfile, true), currentProblemFilter(progressSolved)))
    .groupBy(progressSolved.userId, user.name, user.image, user.isAnonymous)
    .orderBy(desc(xp), desc(solves), desc(lastSolvedAt))
    .limit(limit);

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    image: row.image,
    isAnonymous: row.isAnonymous ?? false,
    xp: row.xp || 0,
    solves: Number(row.solves) || 0,
    lastSolvedAt: (row.lastSolvedAt ?? new Date(0)).toISOString(),
  }));
}

/** A newcomer-friendly board that resets with the UTC weekly challenge window. */
export async function readWeeklyLeaderboard(
  db: ProgressDb,
  startsAt: Date,
  endsAt: Date,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const xp = sum(progressSolved.awardedXp).mapWith(Number);
  const solves = count(progressSolved.levelSlug);
  const lastSolvedAt = max(progressSolved.solvedAt);
  const rows = await db
    .select({
      userId: progressSolved.userId,
      name: user.name,
      image: user.image,
      isAnonymous: user.isAnonymous,
      xp,
      solves,
      lastSolvedAt,
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(
      and(
        eq(user.publicProfile, true),
        currentProblemFilter(progressSolved),
        gte(progressSolved.solvedAt, startsAt),
        lt(progressSolved.solvedAt, endsAt),
      ),
    )
    .groupBy(progressSolved.userId, user.name, user.image, user.isAnonymous)
    .orderBy(desc(xp), desc(solves), desc(lastSolvedAt))
    .limit(limit);

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    image: row.image,
    isAnonymous: row.isAnonymous ?? false,
    xp: row.xp || 0,
    solves: Number(row.solves) || 0,
    lastSolvedAt: (row.lastSolvedAt ?? new Date(0)).toISOString(),
  }));
}

export async function readWeeklyChallengeCompletions(
  db: ProgressDb,
  levelSlug: string,
  startsAt: Date,
  endsAt: Date,
): Promise<number> {
  const rows = await db
    .select({
      completions: sql<number>`count(distinct ${progressSolved.userId})`.mapWith(Number),
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(
      and(
        eq(user.publicProfile, true),
        currentProblemFilter(progressSolved),
        eq(progressSolved.levelSlug, levelSlug),
        gte(progressSolved.solvedAt, startsAt),
        lt(progressSolved.solvedAt, endsAt),
      ),
    );
  return rows[0]?.completions ?? 0;
}

/** Latest solves across the community, newest first. */
export async function readRecentSolves(db: ProgressDb, limit: number): Promise<RecentSolve[]> {
  const rows = await db
    .select({
      name: user.name,
      image: user.image,
      isAnonymous: user.isAnonymous,
      levelSlug: progressSolved.levelSlug,
      solvedAt: progressSolved.solvedAt,
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(and(eq(user.publicProfile, true), currentProblemFilter(progressSolved)))
    .orderBy(desc(progressSolved.solvedAt))
    .limit(limit);

  return rows.map((row) => ({
    name: row.name,
    image: row.image,
    isAnonymous: row.isAnonymous ?? false,
    levelSlug: row.levelSlug,
    solvedAt: row.solvedAt.toISOString(),
  }));
}

/**
 * The user's leaderboard position: rank by total XP among all users with at least one
 * solve (standard competition ranking: tied XP shares the higher rank). Null when the
 * user has no solves yet.
 */
export async function readUserRank(db: ProgressDb, userId: string): Promise<UserRank | null> {
  const totals = db
    .select({
      userId: progressSolved.userId,
      xp: sum(progressSolved.awardedXp).mapWith(Number).as("xp"),
    })
    .from(progressSolved)
    .innerJoin(user, eq(user.id, progressSolved.userId))
    .where(and(eq(user.publicProfile, true), currentProblemFilter(progressSolved)))
    .groupBy(progressSolved.userId)
    .as("totals");

  const ranked = db
    .select({
      userId: totals.userId,
      xp: totals.xp,
      rank: sql<number>`rank() over (order by ${totals.xp} desc)`.as("rank"),
      totalRanked: sql<number>`count(*) over ()`.as("total_ranked"),
    })
    .from(totals)
    .as("ranked");

  const rows = await db
    .select({ rank: ranked.rank, totalRanked: ranked.totalRanked, xp: ranked.xp })
    .from(ranked)
    .where(eq(ranked.userId, userId));

  const mine = rows[0];
  if (!mine) return null;
  return {
    rank: Number(mine.rank),
    totalRanked: Number(mine.totalRanked),
    xp: mine.xp || 0,
  };
}

export async function readUserCommunityStatus(
  db: ProgressDb,
  userId: string,
): Promise<UserCommunityStatus> {
  const [profiles, solveRows] = await Promise.all([
    db.select({ publicProfile: user.publicProfile }).from(user).where(eq(user.id, userId)).limit(1),
    db
      .select({ solveCount: count(progressSolved.levelSlug) })
      .from(progressSolved)
      .where(and(eq(progressSolved.userId, userId), currentProblemFilter(progressSolved))),
  ]);
  const publicProfile = profiles[0]?.publicProfile ?? false;
  return {
    publicProfile,
    solveCount: Number(solveRows[0]?.solveCount ?? 0),
    rank: publicProfile ? await readUserRank(db, userId) : null,
  };
}
