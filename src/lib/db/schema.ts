import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema (Drizzle). Two groups:
 *
 *  1. Better Auth core tables (`user`/`session`/`account`/`verification`): the
 *     property keys MUST match Better Auth's field names (camelCase) so its Drizzle
 *     adapter resolves them; SQL column names are snake_case. Shapes mirror
 *     @better-auth/core 1.6.x exactly (+ the anonymous plugin's `isAnonymous`).
 *     Reconcile with `pnpm dlx @better-auth/cli generate` if Better Auth is upgraded.
 *
 *  2. klab app tables: USER DATA ONLY. Problems live in code and are referenced by
 *     `level_slug` (text, no FK). XP / streak / per-slug hint penalty are NOT stored;
 *     they are derived from these grow-only rows so every write is an idempotent,
 *     commutative upsert (safe under concurrent devices and guest→account merge).
 */

// ---------------------------------------------------------------------------
// Better Auth core
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  isAnonymous: boolean("is_anonymous").default(false),
  /** Explicit opt-in for leaderboard, recent activity, and speed records. */
  publicProfile: boolean("public_profile").notNull().default(false),
  /** Operator-managed identity used for trusted official team communication. */
  isOfficial: boolean("is_official").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// klab app tables (user data only)
// ---------------------------------------------------------------------------

/** One row per (user, solved level). XP is snapshotted at solve time, never mutated. */
export const progressSolved = pgTable(
  "progress_solved",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    awardedXp: integer("awarded_xp").notNull(),
    /** Client-local calendar day (YYYY-MM-DD): streaks derive from the distinct set. */
    solvedDay: text("solved_day").notNull(),
    contentVersion: integer("content_version").notNull().default(1),
    verified: boolean("verified").notNull().default(false),
    solvedAt: timestamp("solved_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.levelSlug] })],
);

/** One row per (user, attempted level). Marks "in progress". */
export const progressAttempted = pgTable(
  "progress_attempted",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    firstAttemptAt: timestamp("first_attempt_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.levelSlug] })],
);

/** One row per (user, completed docs lesson). Grow-only; drives docs progress + checkmarks. */
export const progressCompletedLessons = pgTable(
  "progress_completed_lessons",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lessonSlug: text("lesson_slug").notNull(),
    completedAt: timestamp("completed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.lessonSlug] })],
);

/** Bookmarked problems (the catalog "Saved" tab). Absolute membership, not a toggle. */
export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.levelSlug] })],
);

/**
 * One row per revealed hint. Per-slug penalty = SUM(penalty). Imported guest penalties
 * (which lack hint ids) use the synthetic hintId "__imported__".
 */
export const hintReveals = pgTable(
  "hint_reveals",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    hintId: text("hint_id").notNull(),
    penalty: integer("penalty").notNull(),
    revealedAt: timestamp("revealed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.levelSlug, t.hintId] })],
);

/** Append-only versioned submission history and legacy telemetry for qualified success/time aggregates. */
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    contentVersion: integer("content_version").notNull().default(1),
    verified: boolean("verified").notNull().default(false),
    passed: boolean("passed").notNull(),
    checksTotal: integer("checks_total").notNull(),
    checksPassed: integer("checks_passed").notNull(),
    /** Time from level-open to this submit, ms (null if not measured). */
    durationMs: integer("duration_ms"),
    hintsRevealed: integer("hints_revealed"),
    /** Full validator results + submitted files snapshot for replay. */
    results: jsonb("results"),
    /** Dedupe key for at-least-once client retries. */
    clientMutationId: text("client_mutation_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("submissions_user_client_mutation_id_key").on(t.userId, t.clientMutationId),
    index("submissions_level_passed_idx").on(t.levelSlug, t.passed),
    index("submissions_level_created_idx").on(t.levelSlug, t.createdAt),
    index("submissions_user_level_idx").on(t.userId, t.levelSlug),
  ],
);

/** Versioned per-account drafts. Revision provides optimistic concurrency across devices. */
export const problemDrafts = pgTable(
  "problem_drafts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelSlug: text("level_slug").notNull(),
    contentVersion: integer("content_version").notNull(),
    revision: integer("revision").notNull().default(1),
    snapshot: jsonb("snapshot").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.levelSlug, table.contentVersion] })],
);

/** Named playground saves (arbitrary manifest sets), synced for signed-in users. */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Client-generated idempotency key used by create retries and guest imports. */
    clientId: text("client_id").notNull(),
    name: text("name").notNull(),
    templateId: text("template_id").notNull(),
    files: jsonb("files").notNull(),
    description: text("description").notNull().default(""),
    starred: boolean("starred").notNull().default(false),
    visibility: text("visibility").notNull().default("private"),
    activeFilePath: text("active_file_path").notNull().default(""),
    /** Public snapshots point at the private source they were explicitly published from. */
    publishedFromId: uuid("published_from_id"),
    /** Private forks retain attribution to the public snapshot they came from. */
    forkedFromId: uuid("forked_from_id"),
    publishedAt: timestamp("published_at"),
    forkCount: integer("fork_count").notNull().default(0),
    savedAt: timestamp("saved_at").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastOpenedAt: timestamp("last_opened_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sandboxes_user_client_id_key").on(t.userId, t.clientId),
    index("sandboxes_user_updated_idx").on(t.userId, t.updatedAt),
    index("sandboxes_user_last_opened_idx").on(t.userId, t.lastOpenedAt),
    index("sandboxes_user_starred_idx").on(t.userId, t.starred, t.updatedAt),
    uniqueIndex("sandboxes_user_published_from_key").on(t.userId, t.publishedFromId),
    index("sandboxes_public_published_idx").on(t.visibility, t.publishedAt),
    index("sandboxes_forked_from_idx").on(t.forkedFromId),
  ],
);

/** Public community threads for questions, product feedback, bugs, and problem ideas. */
export const communityDiscussions = pgTable(
  "community_discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** open | under-review | planned | resolved | closed */
    status: text("status").notNull().default("open"),
    pinned: boolean("pinned").notNull().default(false),
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("community_discussions_author_client_key").on(t.authorId, t.clientId),
    index("community_discussions_activity_idx").on(t.pinned, t.lastActivityAt),
    index("community_discussions_category_activity_idx").on(t.category, t.lastActivityAt),
    index("community_discussions_status_activity_idx").on(t.status, t.lastActivityAt),
    index("community_discussions_author_idx").on(t.authorId, t.createdAt),
  ],
);

/** Replies are limited to one nested level by the repository. */
export const communityDiscussionReplies = pgTable(
  "community_discussion_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => communityDiscussions.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** Null for a response; a root response id for a nested reply. */
    parentId: uuid("parent_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("community_replies_author_client_key").on(t.authorId, t.clientId),
    index("community_replies_discussion_created_idx").on(t.discussionId, t.createdAt),
    index("community_replies_parent_created_idx").on(t.parentId, t.createdAt),
    index("community_replies_author_idx").on(t.authorId, t.createdAt),
  ],
);

/** Guards guest→account imports from double-counting on repeat. */
export const mergeLog = pgTable(
  "merge_log",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fingerprint] })],
);

/** Full schema object for the Drizzle adapter + query builder. */
export const schema = {
  user,
  session,
  account,
  verification,
  progressSolved,
  progressAttempted,
  progressCompletedLessons,
  bookmarks,
  hintReveals,
  submissions,
  problemDrafts,
  sandboxes,
  communityDiscussions,
  communityDiscussionReplies,
  mergeLog,
};
