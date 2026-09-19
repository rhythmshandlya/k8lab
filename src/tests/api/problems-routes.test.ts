import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { TestDb } from "./pglite";
const state = vi.hoisted(() => ({
  userId: "owner" as string | null,
  allowed: true,
  db: null as TestDb | null,
  judge: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  getAuth: () => ({
    api: { getSession: async () => (state.userId ? { user: { id: state.userId } } : null) },
  }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db!, hasDb: () => true }));
vi.mock("@/lib/env", () => ({ isAuthConfigured: () => true }));
vi.mock("@/lib/rate-limit", () => ({ allowRequest: async () => state.allowed }));
vi.mock("@/lib/problems/judge", () => ({ judgeSubmission: state.judge }));
import { GET, POST } from "@/app/api/problems/submissions/route";
import { GET as getDraft, PUT } from "@/app/api/problems/draft/route";
import { createTestDb, seedUser } from "./pglite";
import { PROGRESS_OWNER_HEADER } from "@/lib/storage/progress-intent";
let close: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDb();
  state.db = test.db;
  close = () => test.client.close();
  await seedUser(test.db, "owner");
  await seedUser(test.db, "other");
});
afterAll(async () => close());
beforeEach(() => {
  state.userId = "owner";
  state.allowed = true;
  state.judge.mockReset();
  state.judge.mockImplementation(async (input) => ({
    id: input.clientMutationId,
    slug: input.slug,
    contentVersion: input.contentVersion,
    judgeVersion: "test",
    files: input.files,
    report: { passed: false, results: [] },
    createdAt: new Date().toISOString(),
    verified: true,
  }));
});
const input = () => ({
  slug: "broken-readiness-probe",
  contentVersion: 2,
  files: { "pod.yaml": "broken" },
  clientMutationId: crypto.randomUUID(),
});
const request = (path: string, method: string, body?: unknown, owner = "owner") =>
  new Request(`http://test/api/problems/${path}`, {
    method,
    headers: { [PROGRESS_OWNER_HEADER]: owner, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it("requires authentication and rejects captured-owner mismatches on every route", async () => {
  state.userId = null;
  expect((await POST(request("submissions", "POST", input()))).status).toBe(401);
  state.userId = "other";
  expect((await POST(request("submissions", "POST", input()))).status).toBe(409);
  expect((await GET(request("submissions?slug=broken-readiness-probe", "GET"))).status).toBe(409);
  expect((await getDraft(request("draft?slug=broken-readiness-probe", "GET"))).status).toBe(409);
  expect((await PUT(request("draft", "PUT", {}))).status).toBe(409);
  expect(state.judge).not.toHaveBeenCalled();
});
it("ignores client verdicts, stores server history and deduplicates identical retries", async () => {
  const body = { ...input(), passed: true, xp: 999999 };
  const first = await POST(request("submissions", "POST", body));
  expect(first.status).toBe(200);
  expect((await first.json()).report.passed).toBe(false);
  expect((await POST(request("submissions", "POST", body))).status).toBe(200);
  expect(state.judge).toHaveBeenCalledTimes(1);
  expect((await POST(request("submissions", "POST", { ...body, files: {} }))).status).toBe(409);
  const history = await GET(request(`submissions?slug=${body.slug}`, "GET"));
  expect((await history.json()).submissions).toHaveLength(1);
  expect(
    (await POST(request("submissions", "POST", { ...body, files: { "pod.yaml": "different" } })))
      .status,
  ).toBe(409);
});
it("bounds payloads and rejects requests before invoking the judge", async () => {
  expect(
    (
      await POST(
        request("submissions", "POST", { ...input(), files: { "pod.yaml": "x".repeat(100001) } }),
      )
    ).status,
  ).toBe(400);
  expect((await POST(request("submissions", "POST", "x".repeat(300001)))).status).toBe(413);
  state.allowed = false;
  expect((await POST(request("submissions", "POST", input()))).status).toBe(429);
  expect(state.judge).not.toHaveBeenCalled();
});
it("returns conflict data instead of silently replacing another device's draft", async () => {
  const draft = {
    slug: "broken-readiness-probe",
    contentVersion: 2,
    files: { "pod.yaml": "mine" },
    activeFilePath: "pod.yaml",
    revealedHintIds: [],
    collectedEvidence: [],
    updatedAt: 1,
    serverRevision: 0,
  };
  expect((await PUT(request("draft", "PUT", draft))).status).toBe(200);
  const conflict = await PUT(request("draft", "PUT", { ...draft, files: { "pod.yaml": "stale" } }));
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).draft.files).toEqual(draft.files);
  state.userId = "other";
  const own = await getDraft(request(`draft?slug=${draft.slug}`, "GET", undefined, "other"));
  expect((await own.json()).draft).toBeNull();
});
