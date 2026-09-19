import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { migrateProductionBuild } from "./production-migrations.mjs";

test("preview and local builds never connect to the deployment database", async () => {
  for (const environment of [undefined, "preview", "development", "staging"]) {
    assert.equal(
      await migrateProductionBuild({
        VERCEL_ENV: environment,
        NODE_ENV: "production",
        DATABASE_URL_UNPOOLED: "postgres://unused:unused@127.0.0.1:1/unused",
      }),
      false,
    );
  }
});

test("production does not fall back to a pooled or absent connection", async () => {
  await assert.rejects(
    migrateProductionBuild({ VERCEL_ENV: "production", DATABASE_URL: "postgres://unused" }),
    /requires DATABASE_URL_UNPOOLED/,
  );
});

test("a production build fails before Next.js when migration configuration is missing", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build.mjs", import.meta.url))],
    {
      env: { ...process.env, VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: "" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires DATABASE_URL_UNPOOLED/);
  assert.equal(result.stdout, "");
});

test("a failed connection stops the production build without leaking credentials", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        VERCEL_ENV: "production",
        DATABASE_URL_UNPOOLED: "postgres://review:do-not-log-this@127.0.0.1:1/unused",
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment stopped before build/);
  assert.doesNotMatch(result.stderr + result.stdout, /do-not-log-this|postgres:\/\//);
  assert.equal(result.stdout, "");
});
