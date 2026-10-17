import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({ accounts: new Map<string, any>() }));
vi.mock("../server/store", () => ({
  getAccount: async (email: string) => state.accounts.get(email),
  listAccounts: async () => [...state.accounts.values()],
  withAccountLock: async (_email: string, fn: any) => fn(),
  accountRef: (email: string) => ({
    update: async (data: any) => Object.assign(state.accounts.get(email), data),
  }),
  recentDecisions: async () => [],
  BusyError: class extends Error {},
  db: { collection: () => ({}) },
}));
vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    req.session = {
      email: "owner@example.com",
      csrf: "test-csrf",
      expiresAt: Date.now() + 10000,
    };
    next();
  },
}));
vi.mock("../server/gmail", () => ({
  Gmail: class {
    labels = async () => [
      { id: "target", name: "Job Recruiting", type: "user" },
    ];
    ensureLabel = async () => ({ id: "target", name: "Job Recruiting" });
  },
}));
import { createApp } from "../server/app";
import { config } from "../server/config";
const app = createApp();
const settings = {
  label: "Job Recruiting",
  enabled: true,
  draftReplies: false,
  threshold: 0.9,
};
const patch = (email: string, body: unknown) =>
  request(app)
    .patch(`/api/accounts/${email}`)
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", "test-csrf")
    .send(body);
beforeEach(() => {
  state.accounts.clear();
  state.accounts.set("mine@example.com", {
    email: "mine@example.com",
    owner: "owner@example.com",
    refreshToken: "private",
    ...settings,
  });
  state.accounts.set("other@example.com", {
    email: "other@example.com",
    owner: "someone@example.com",
    ...settings,
  });
});
it("pauses owned mailboxes without exposing credentials or changing another account", async () => {
  expect((await patch("mine@example.com", { enabled: false })).status).toBe(
    200,
  );
  expect(state.accounts.get("mine@example.com").enabled).toBe(false);
  expect(state.accounts.get("other@example.com").enabled).toBe(true);
  const r = await request(app).get("/api/accounts");
  expect(r.body.accounts).toHaveLength(1);
  expect(r.body.accounts[0]).not.toHaveProperty("refreshToken");
});
it("rejects obsolete classification account settings and inaccessible mailboxes", async () => {
  expect((await patch("mine@example.com", { ...settings })).status).toBe(400);
  expect((await patch("other@example.com", { enabled: false })).status).toBe(
    404,
  );
});
