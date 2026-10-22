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
      id,
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
          set: (ref: any, value: any) =>
            state.docs.set(ref.path, structuredClone(value)),
          delete: (ref: any) => state.docs.delete(ref.path),
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
import { hash } from "../server/crypto";
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
    { ...input, protectedLabels: [{ labelId: "", labelName: "" }] },
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

const modify = (
  id: string,
  method: "patch" | "delete",
  body: unknown,
  token = "test-csrf",
) =>
  request(app)
    [method](`/api/rule-templates/${id}`)
    .set("Host", new URL(config.baseUrl).host)
    .set("Origin", config.baseUrl)
    .set("X-CSRF-Token", token)
    .send(body);

it("creates portable templates using only label names, while rules still require mailbox IDs", async () => {
  const portable = {
    ...input,
    choices: [
      {
        ...input.choices[0],
        actions: { labels: [{ labelName: "Recruiting" }] },
      },
    ],
    protectedLabels: [{ labelName: "Protected", includeChildren: true }],
  };
  const response = await save(portable);
  expect(response.status).toBe(201);
  expect(response.body.template.choices[0].actions.labels).toEqual([
    { labelId: "", labelName: "Recruiting" },
  ]);
  expect(editableRuleSchema.safeParse(portable).success).toBe(false);
  expect(state.gmail).not.toHaveBeenCalled();
  const duplicateLabels = {
    ...portable,
    protectedLabels: [{ labelName: "Protected" }, { labelName: " Protected " }],
  };
  expect((await save(duplicateLabels)).status).toBe(400);
});
it("edits a template in place and preserves existing rules", async () => {
  const { template } = (await save()).body;
  const rulePath = "accounts/mailbox/rules/existing";
  state.docs.set(rulePath, structuredClone(input));
  const response = await modify(template.id, "patch", {
    ...input,
    name: "Updated template",
    threshold: 0.7,
    expectedVersion: 1,
  });
  expect(response.status).toBe(200);
  expect(response.body.template).toMatchObject({
    id: template.id,
    name: "Updated template",
    threshold: 0.7,
    createdAt: template.createdAt,
    version: 2,
  });
  expect((await list()).body.templates).toEqual([response.body.template]);
  expect(state.docs.get(rulePath)).toEqual(input);
  expect(state.createRule).not.toHaveBeenCalled();
  expect(state.gmail).not.toHaveBeenCalled();
});
it("prevents stale edits and deletes from overwriting newer changes", async () => {
  const { template } = (await save()).body;
  await modify(template.id, "patch", {
    ...input,
    name: "Latest",
    expectedVersion: 1,
  });
  expect(
    (await modify(template.id, "patch", { ...input, expectedVersion: 1 }))
      .status,
  ).toBe(409);
  expect(
    (await modify(template.id, "delete", { expectedVersion: 1 })).status,
  ).toBe(409);
  expect((await list()).body.templates[0].name).toBe("Latest");
});
it("requires ownership, sign-in, CSRF, and a valid version for edits and deletes", async () => {
  const { template } = (await save()).body;
  for (const method of ["patch", "delete"] as const) {
    const body = { ...(method === "patch" ? input : {}), expectedVersion: 1 };
    expect((await modify(template.id, method, body, "wrong")).status).toBe(403);
    expect(
      (
        await modify(template.id, method, {
          ...body,
          expectedVersion: undefined,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await modify(template.id, method, {
          ...body,
          owner: "owner@example.com",
        })
      ).status,
    ).toBe(400);
    state.email = "other@example.com";
    expect((await modify(template.id, method, body)).status).toBe(404);
    state.email = null;
    expect((await modify(template.id, method, body)).status).toBe(401);
    state.email = "owner@example.com";
  }
  expect((await list()).body.templates).toHaveLength(1);
});
it("deletes only the selected template and allows it to be recreated", async () => {
  const { template } = (await save()).body;
  const other = (await save({ ...input, name: "Keep this" })).body.template;
  const rulePath = "accounts/mailbox/rules/existing";
  state.docs.set(rulePath, structuredClone(input));
  expect(
    (await modify(template.id, "delete", { expectedVersion: 1 })).status,
  ).toBe(200);
  expect((await list()).body.templates).toEqual([other]);
  expect(state.docs.get(rulePath)).toEqual(input);
  const recreated = (await save()).body.template;
  expect(recreated.id).not.toBe(template.id);
  expect((await list()).body.templates).toHaveLength(2);
});
it("keeps create retries correct after a template's content is edited", async () => {
  const original = (await save()).body.template;
  const changed = { ...input, name: "Edited" };
  await modify(original.id, "patch", { ...changed, expectedVersion: 1 });
  expect((await save(changed)).body.template.id).toBe(original.id);
  const copy = (await save()).body.template;
  expect(copy.id).not.toBe(original.id);
  expect(copy.name).toBe(input.name);
  expect((await save()).body.template.id).toBe(copy.id);
});
it("supports templates saved before versions were introduced", async () => {
  const fields = ruleTemplateSchema.parse(input);
  const template = {
    ...fields,
    id: hash(JSON.stringify(fields)),
    createdAt: 100,
  };
  state.docs.set(
    `users/${hash("owner@example.com")}/ruleTemplates/${template.id}`,
    template,
  );
  expect((await list()).body.templates[0]).toMatchObject({
    version: 1,
    updatedAt: template.createdAt,
  });
  expect((await save()).body.template.id).toBe(template.id);
  expect((await list()).body.templates).toHaveLength(1);
  expect(
    (
      await modify(template.id, "patch", {
        ...input,
        name: "Legacy edited",
        expectedVersion: 1,
      })
    ).status,
  ).toBe(200);
  expect((await save()).body.template.id).not.toBe(template.id);
});
it("leaves saved templates intact when edits fail validation or storage", async () => {
  const { template } = (await save()).body;
  expect(
    (
      await modify(template.id, "patch", {
        ...input,
        name: "",
        expectedVersion: 1,
      })
    ).status,
  ).toBe(400);
  state.fail = true;
  expect(
    (
      await modify(template.id, "patch", {
        ...input,
        name: "Changed",
        expectedVersion: 1,
      })
    ).status,
  ).toBe(503);
  expect(
    (await modify(template.id, "delete", { expectedVersion: 1 })).status,
  ).toBe(503);
  expect((await list()).body.templates).toEqual([template]);
});
