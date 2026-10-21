import { beforeEach, it, expect, vi } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  accounts: vi.fn(),
  signedIn: true,
  account: vi.fn(),
  classify: vi.fn(),
  labels: vi.fn(),
  gmailWrite: vi.fn(),
}));
vi.mock("../server/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/rules")>()),
  updateRules: state.update,
  listRulesForAccount: state.list,
}));
vi.mock("../server/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/store")>()),
  listAccounts: state.accounts,
  getAccount: state.account,
}));
vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    if (state.signedIn)
      req.session = { email: "owner@example.com", csrf: "test-csrf" };
    next();
  },
}));
vi.mock("../server/classifier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/classifier")>()),
  classifyRules: state.classify,
}));
vi.mock("../server/gmail", () => ({
  Gmail: class {
    labels = state.labels;
    request = state.gmailWrite;
    label = state.gmailWrite;
    markRead = state.gmailWrite;
    forward = state.gmailWrite;
    createDraft = state.gmailWrite;
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
  state.account.mockResolvedValue({
    email: "a@example.com",
    owner: "owner@example.com",
  });
  state.labels.mockResolvedValue([
    { id: "L", name: "Label", type: "user" },
    { id: "M", name: "More", type: "user" },
  ]);
  state.classify.mockResolvedValue(
    new Map([
      [
        "preview",
        {
          choiceId: "match",
          choiceName: "Match",
          probability: 0.99,
          confidence: 0.99,
          refused: false,
          probabilities: [],
        },
      ],
    ]),
  );
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

const preview = (rule: unknown) =>
  request(app)
    .post("/api/accounts/a@example.com/rules/test")
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", "test-csrf")
    .send({ rule, text: "Incoming message content" });
const previewRule = (choice: object) => ({
  name: "Rule",
  prompt: "Classify incoming relevant messages.",
  choices: [
    { id: "match", name: "Match", description: "Relevant messages", ...choice },
  ],
});
it.each([
  { labels: [], replyDraft: { body: "Reply" }, markRead: false, forward: null },
  { labels: [], replyDraft: null, markRead: true, forward: null },
  {
    labels: [],
    replyDraft: null,
    markRead: false,
    forward: { to: "destination@example.com" },
  },
  {
    labels: [
      { labelId: "L", labelName: "Label" },
      { labelId: "M", labelName: "More" },
    ],
    replyDraft: { body: "Reply" },
    markRead: true,
    forward: { to: "destination@example.com" },
  },
])(
  "previews configured actions without executing any Gmail mutations",
  async (actions) => {
    const response = await preview(previewRule({ actions }));
    expect(response.status).toBe(200);
    expect(response.body.actions).toEqual(actions);
    expect(response.body.applied).toBe(false);
    expect(state.gmailWrite).not.toHaveBeenCalled();
  },
);
it("preserves legacy single-label and shared draft previews", async () => {
  const response = await preview({
    ...previewRule({ labelId: "L", labelName: "Old" }),
    replyDraft: { choiceIds: ["match"], body: "Legacy reply" },
  });
  expect(response.status).toBe(200);
  expect(response.body.label).toEqual({ id: "L", name: "Label" });
  expect(response.body.actions).toEqual({
    labels: [{ labelId: "L", labelName: "Label" }],
    replyDraft: { body: "Legacy reply" },
    markRead: false,
    forward: null,
  });
});
it.each([
  { choiceId: null, probability: 0.99, refused: false },
  { choiceId: "match", probability: 0.6, refused: false },
  { choiceId: "match", probability: null, refused: false },
  { choiceId: "match", probability: 0.99, refused: true },
])(
  "does not preview executable actions for rejected predictions",
  async (prediction) => {
    state.classify.mockResolvedValue(new Map([["preview", prediction]]));
    const response = await preview(
      previewRule({ actions: { markRead: true } }),
    );
    expect(response.status).toBe(200);
    expect(response.body.actions).toBeNull();
    expect(response.body.label).toBeUndefined();
    expect(state.gmailWrite).not.toHaveBeenCalled();
  },
);
it("rejects empty actions and invalid forwarding recipients at the API boundary", async () => {
  for (const actions of [{}, { forward: { to: "not-an-address" } }]) {
    expect((await preview(previewRule({ actions }))).status).toBe(400);
    expect(
      (
        await send({
          ...payload,
          targets: [
            {
              ...payload.targets[0],
              choices: previewRule({ actions }).choices,
            },
          ],
        })
      ).status,
    ).toBe(400);
  }
  expect(state.classify).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
});
it("accepts action-only choices in a batch while preserving omitted fields", async () => {
  const body = {
    ...payload,
    targets: [
      {
        ...payload.targets[0],
        choices: previewRule({ actions: { markRead: true } }).choices,
      },
    ],
    changes: {},
  };
  expect((await send(body)).status).toBe(200);
  expect(state.update.mock.calls[0][1].targets[0].choices[0].actions).toEqual({
    labels: [],
    replyDraft: null,
    markRead: true,
    forward: null,
  });
  expect(state.update.mock.calls[0][1].changes).toEqual({});
});
