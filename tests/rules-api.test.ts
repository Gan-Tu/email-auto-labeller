import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({ update: vi.fn(), signedIn: true }));
vi.mock("../server/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/rules")>()),
  updateRules: state.update,
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
