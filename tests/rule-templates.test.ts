import { beforeEach, expect, it, vi } from "vitest";
import request from "supertest";

const state = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  email: "owner@example.com" as string | null,
  fail: false,
  gmail: vi.fn(),
  createRule: vi.fn(),
}));
vi.mock("../server/store", async (importOriginal) => {
  const collection = (path: string): any => ({
    doc: (id: string) => ({
      path: `${path}/${id}`,
      collection: (name: string) => collection(`${path}/${id}/${name}`),
    }),
    orderBy: () => ({
      get: async () => ({
        docs: [...state.docs]
          .filter(([key]) => key.startsWith(`${path}/`))
          .map(([, data]) => ({ data: () => structuredClone(data) })),
      }),
    }),
  });
  return {
    ...(await importOriginal<typeof import("../server/store")>()),
    db: {
      collection,
      runTransaction: async (fn: any) => {
        if (state.fail) throw new Error("Storage unavailable");
        return fn({
          get: async (ref: any) => ({
            exists: state.docs.has(ref.path),
            data: () => structuredClone(state.docs.get(ref.path)),
          }),
          create: (ref: any, value: any) =>
            state.docs.set(ref.path, structuredClone(value)),
        });
      },
    },
  };
});
vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    if (state.email) req.session = { email: state.email, csrf: "test-csrf" };
    next();
  },
}));
vi.mock("../server/gmail", () => ({ Gmail: state.gmail }));
vi.mock("../server/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/rules")>()),
  createRule: state.createRule,
}));
import { createApp } from "../server/app";
import { config } from "../server/config";
import { editableRuleSchema } from "../server/rules";
import { ruleTemplateSchema } from "../server/rule-templates";
const app = createApp();
const input = {
  name: "Work opportunities",
  prompt: "Classify personally directed employment opportunities.",
  enabled: false,
  threshold: 0.95,
  scope: "thread",
  choices: [
    {
      id: "recruiting",
      name: "Recruiting",
      description: "A specific offer to discuss employment.",
      actions: {
        labels: [{ labelId: "L", labelName: "Work/Recruiting" }],
        replyDraft: { body: "Thanks for reaching out." },
        markRead: true,
        forward: { to: "destination@example.com" },
      },
    },
  ],
  protectedLabels: [
    { labelId: "P", labelName: "Protected", includeChildren: true },
  ],
  replyDraft: null,
};
const save = (body: unknown = input, token = "test-csrf") =>
  request(app)
    .post("/api/rule-templates")
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", token)
    .send(body);
const list = () =>
  request(app)
    .get("/api/rule-templates")
    .set("Host", new URL(config.baseUrl).host);
beforeEach(() => {
  state.docs.clear();
  state.email = "owner@example.com";
  state.fail = false;
  vi.clearAllMocks();
});
it("saves all settings for reuse without creating a rule or accessing Gmail", async () => {
  const saved = await save();
  expect(saved.status).toBe(201);
  expect(saved.body.template).toMatchObject(input);
  expect((await list()).body.templates).toEqual([saved.body.template]);
  expect(state.createRule).not.toHaveBeenCalled();
  expect(state.gmail).not.toHaveBeenCalled();
});
it("keeps templates private to the authenticated user and rejects owner injection", async () => {
  await save();
  state.email = "other@example.com";
  expect((await list()).body.templates).toEqual([]);
  expect((await save({ ...input, owner: "owner@example.com" })).status).toBe(
    400,
  );
  const other = await save({ ...input, name: "Other user's template" });
  expect((await list()).body.templates).toEqual([other.body.template]);
  state.email = "owner@example.com";
  expect((await list()).body.templates.map((t: any) => t.name)).toEqual([
    input.name,
  ]);
});
it("requires sign-in and CSRF protection", async () => {
  expect((await save(input, "wrong")).status).toBe(403);
  state.email = null;
  expect((await save()).status).toBe(401);
  expect((await list()).status).toBe(401);
  expect(state.docs.size).toBe(0);
});
it("allows unconfigured template actions without relaxing rule validation", async () => {
  const draft = { ...input, choices: [{ ...input.choices[0], actions: {} }] };
  expect((await save(draft)).status).toBe(201);
  expect(editableRuleSchema.safeParse(draft).success).toBe(false);
});
it("validates templates before saving", async () => {
  for (const body of [
    { ...input, name: "" },
    { ...input, prompt: "short" },
    { ...input, choices: [] },
    { ...input, choices: [input.choices[0], input.choices[0]] },
    {
      ...input,
      choices: [input.choices[0], { ...input.choices[0], id: "second" }],
    },
    { ...input, choices: [{ ...input.choices[0], name: "No match" }] },
    {
      ...input,
      choices: [
        { ...input.choices[0], actions: { forward: { to: "invalid" } } },
      ],
    },
    { ...input, protectedLabels: [{ labelId: "", labelName: "Missing" }] },
  ])
    expect((await save(body)).status).toBe(400);
  expect(state.docs.size).toBe(0);
});
it("deduplicates retries while retaining independently changed templates", async () => {
  const first = await save();
  const retry = await save({ ...input, name: ` ${input.name} ` });
  expect(retry.body.template).toEqual(first.body.template);
  await save({ ...input, threshold: 0.8 });
  expect((await list()).body.templates).toHaveLength(2);
});
it("reports storage failure without claiming success", async () => {
  state.fail = true;
  expect((await save()).status).toBe(503);
  expect(state.docs.size).toBe(0);
  expect(state.createRule).not.toHaveBeenCalled();
});
it("trims saved fields and keeps action/protection limits", () => {
  expect(ruleTemplateSchema.parse({ ...input, name: " Name " }).name).toBe(
    "Name",
  );
  expect(ruleTemplateSchema.safeParse({ ...input, threshold: 1 }).success).toBe(
    false,
  );
});
