import { defineConfig, devices } from "@playwright/test";

import { GUEST_ENTRY_COOKIE, GUEST_ENTRY_VALUE } from "./src/lib/auth/entry";

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? "http://localhost:3000";
const parsedBaseURL = new URL(baseURL);

/**
 * Playwright E2E config. Tests live in `src/tests/e2e`. Reuses a running dev server
 * if one is up, otherwise starts `pnpm dev`. Generous timeouts because tests boot a
 * full in-browser Kubernetes cluster and wait for reconciliation.
 */
export default defineConfig({
  testDir: "src/tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  maxFailures: process.env.CI ? 3 : undefined,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    storageState: {
      cookies: [
        {
          name: GUEST_ENTRY_COOKIE,
          value: GUEST_ENTRY_VALUE,
          domain: parsedBaseURL.hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: parsedBaseURL.protocol === "https:",
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The in-browser cluster drives reconciliation with timers. Headless Chromium
        // throttles timers on backgrounded pages, which starves webernetes's control
        // loops — disable that so the cluster reconciles at full speed.
        launchOptions: {
          args: [
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
          ],
        },
      },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        // Test the production build: dev-only React StrictMode double-mounts the editor.
        command: "pnpm build && pnpm start",
        url: "http://localhost:3000",
        reuseExistingServer: false,
        timeout: 240_000,
      },
});
