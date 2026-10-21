import { beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({ signedIn: true, draft: vi.fn() }));
vi.mock("../server/auth", async (original) => ({
  ...(await original<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    if (state.signedIn)
      req.session = { email: "owner@example.com", csrf: "test-csrf" };
    next();
  },
}));
vi.mock("../server/prompt-assistant", async (original) => ({
  ...(await original<typeof import("../server/prompt-assistant")>()),
  draftClassificationPrompt: state.draft,
}));
import { createApp } from "../server/app";
import { config } from "../server/config";
import { PromptAssistantError } from "../server/prompt-assistant";
const app = createApp();
const payload = {
  instructions: "Help classify messages",
  model: "gpt-6.1-sol",
  effort: "medium",
  speed: "fast",
  currentPrompt: "",
  name: "",
  scope: "message",
  choices: [],
};
const send = (body: unknown = payload, token = "test-csrf") =>
  request(app)
    .post("/api/prompt-assistant/draft")
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", token)
    .send(body);
beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = true;
  state.draft.mockResolvedValue({
    prompt: "Classify messages using the configured choices or no_match.",
    model: payload.model,
    effort: "medium",
    speed: "fast",
  });
});
it("serves model choices only to authenticated sessions", async () => {
  const result = await request(app).get("/api/prompt-assistant/options");
  expect(result.status).toBe(200);
  expect(result.body.defaults).toEqual({
    model: "gpt-6.1-sol",
    effort: "medium",
    speed: "fast",
  });
  state.signedIn = false;
  expect((await request(app).get("/api/prompt-assistant/options")).status).toBe(
    401,
  );
  expect((await send()).status).toBe(401);
  expect(state.draft).not.toHaveBeenCalled();
});
it("requires CSRF and validates settings before generation", async () => {
  expect((await send(payload, "bad")).status).toBe(403);
  expect((await send({ ...payload, model: "invalid" })).status).toBe(400);
  expect((await send({ ...payload, effort: "none" })).status).toBe(400);
  expect(
    (await send({ ...payload, email: "mailbox@example.com" })).status,
  ).toBe(400);
  expect(state.draft).not.toHaveBeenCalled();
});
it("returns a reviewable draft without requiring a mailbox or saved rule", async () => {
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.body.prompt).toContain("no_match");
  expect(state.draft).toHaveBeenCalledExactlyOnceWith(payload);
});
it("returns sanitized service errors", async () => {
  state.draft.mockRejectedValue(
    new PromptAssistantError(
      "The prompt assistant timed out. Please try again.",
    ),
  );
  const response = await send();
  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    error: "The prompt assistant timed out. Please try again.",
  });
});
