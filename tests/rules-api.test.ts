import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  accounts: vi.fn(),
  signedIn: true,
}));
vi.mock("../server/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/rules")>()),
  updateRules: state.update,
  listRulesForAccount: state.list,
}));
vi.mock("../server/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/store")>()),
  listAccounts: state.accounts,
}));
vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    if (state.signedIn)
      req.session = { email: "owner@example.com", csrf: "test-csrf" };
    next();
  },
}));
import { createApp } from "../server/app";
import { config } from "../server/config";
import { RuleError } from "../server/rules";
const app = createApp();
const payload = {
  targets: [
    { email: "a@example.com", ruleId: "recruiting", expectedVersion: 1 },
  ],
  changes: { prompt: "Only direct recruiting invitations to join a team." },
};
const send = (body: unknown, token = "test-csrf") =>
  request(app)
    .post("/api/rules/batch")
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", token)
    .send(body);
beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = true;
  state.update.mockResolvedValue([]);
  state.accounts.mockResolvedValue([]);
  state.list.mockReset();
});
it("uses the authenticated actor and preserves omitted changes", async () => {
  expect((await send(payload)).status).toBe(200);
  expect(state.update).toHaveBeenCalledWith("owner@example.com", payload);
});
it("rejects duplicate, missing, malformed and empty updates", async () => {
  for (const input of [
    { ...payload, targets: [] },
    { ...payload, targets: [...payload.targets, ...payload.targets] },
    { ...payload, changes: {} },
    { ...payload, actor: "attacker@example.com" },
    { ...payload, changes: { prompt: "short" } },
  ])
    expect((await send(input)).status).toBe(400);
  expect(state.update).not.toHaveBeenCalled();
});
it("requires session and same-origin CSRF token for batch changes", async () => {
  expect((await send(payload, "bad")).status).toBe(403);
  state.signedIn = false;
  expect((await send(payload)).status).toBe(401);
  expect(state.update).not.toHaveBeenCalled();
});
it("exposes version conflicts and ownership failure without partial success", async () => {
  state.update.mockRejectedValueOnce(
    new RuleError("A selected rule changed. No rules were changed.", 409),
  );
  const r = await send(payload);
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("No rules were changed");
  state.update.mockRejectedValueOnce(new RuleError("Mailbox unavailable", 404));
  expect((await send(payload)).status).toBe(404);
});

const loadRules = () =>
  request(app).get("/api/rules").set("Host", new URL(config.baseUrl).host);
it("loads healthy and paused mailboxes while reporting a disconnected mailbox separately", async () => {
  const accounts = [
    { email: "disconnected@example.com", enabled: false },
    { email: "healthy@example.com", enabled: true },
    { email: "paused@example.com", enabled: false },
  ].map((a) => ({ ...a, owner: "owner@example.com" }));
  state.accounts.mockResolvedValue([
    ...accounts,
    { email: "private@example.com", owner: "someone-else@example.com" },
  ]);
  state.list.mockImplementation(async (account) => {
    if (account.email === accounts[0].email)
      throw new RuleError(
        "Mailbox labels unavailable; reconnect Gmail or retry.",
        503,
      );
    return [{ id: "recruiting", email: account.email }];
  });
  const response = await loadRules();
  expect(response.status).toBe(200);
  expect(response.body.rules).toEqual(
    accounts.slice(1).map((a) => ({ id: "recruiting", email: a.email })),
  );
  expect(response.body.errors).toEqual([
    {
      email: accounts[0].email,
      message: "Mailbox labels unavailable; reconnect Gmail or retry.",
    },
  ]);
  expect(state.list).toHaveBeenCalledTimes(3);
});
it("reports all unavailable mailboxes and clears warnings on recovery", async () => {
  state.accounts.mockResolvedValue([{ email: "owner@example.com" }]);
  state.list.mockRejectedValueOnce(new RuleError("Reconnect Gmail", 503));
  const failed = await loadRules();
  expect(failed.status).toBe(200);
  expect(failed.body.rules).toEqual([]);
  expect(failed.body.errors).toHaveLength(1);
  state.list.mockResolvedValueOnce([{ id: "recruiting" }]);
  const recovered = await loadRules();
  expect(recovered.body.rules).toEqual([{ id: "recruiting" }]);
  expect(recovered.body.errors).toEqual([]);
});
it("does not disguise unexpected failures as partial success", async () => {
  state.accounts.mockResolvedValue([{ email: "owner@example.com" }]);
  state.list.mockRejectedValueOnce(new Error("Database unavailable"));
  expect((await loadRules()).status).toBe(503);
});
