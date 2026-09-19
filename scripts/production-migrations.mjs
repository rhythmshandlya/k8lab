import { fileURLToPath } from "node:url";

/** Only production builds may use the deployment's migration credentials. */
export async function migrateProductionBuild(env) {
  if (env.VERCEL_ENV !== "production") return false;
  if (!env.DATABASE_URL_UNPOOLED?.trim()) {
    throw new Error("Production build requires DATABASE_URL_UNPOOLED before applying migrations.");
  }

  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  let client;
  try {
    client = new pg.Client({
      connectionString: env.DATABASE_URL_UNPOOLED,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 120_000,
      query_timeout: 130_000,
      application_name: "klab-production-migrations",
    });
    await client.connect();
    // A session lock serializes overlapping Vercel/GitHub production builds. Closing
    // this dedicated connection releases it even when the migration transaction fails.
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock(1802264930, 1)");
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    console.info("Production database migrations applied successfully.");
    return true;
  } catch {
    // Driver errors can contain connection details. Keep credentials out of build logs.
    throw new Error("Production database migration failed; deployment stopped before build.");
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
}
