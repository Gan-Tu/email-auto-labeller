import { beforeEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  failCommit: false,
  labels: new Map<string, any[]>(),
  labelCalls: [] as string[],
  failLabels: false,
}));
const ref = (path: string) => ({ path });
vi.mock("../server/store", () => {
  const ref = (path: string) => ({ path });
  const snapshots = (...refs: any[]) =>
    refs.map((ref) => ({
      ref,
      exists: state.docs.has(ref.path),
      data: () => structuredClone(state.docs.get(ref.path)),
    }));
  return {
    listRules: async (email: string) =>
      [...state.docs]
        .filter(
          ([key, value]) =>
            key.startsWith(`accounts/${email}/rules/`) && !value.deletedAt,
        )
        .map(([, value]) => structuredClone(value)),
    lockRef: (e: string) => ref(`locks/${e}`),
    accountRef: (e: string) => ref(`accounts/${e}`),
    ruleRef: (e: string, id: string) => ref(`accounts/${e}/rules/${id}`),
    ruleVersionRef: (e: string, id: string, v: number) =>
      ref(`accounts/${e}/ruleVersions/${id}_v${v}`),
    rulesRef: (e: string) => ref(`accounts/${e}/rules`),
    db: {
      getAll: async (...refs: any[]) => snapshots(...refs),
      runTransaction: async (fn: any) => {
        const writes: { path: string; data: any; merge: boolean }[] = [];
        const result = await fn({
          getAll: async (...refs: any[]) => snapshots(...refs),
          update: (ref: any, data: any) =>
            writes.push({ path: ref.path, data, merge: true }),
          set: (ref: any, data: any) =>
            writes.push({ path: ref.path, data, merge: false }),
          create: (ref: any, data: any) => {
            if (state.docs.has(ref.path)) throw new Error("Already exists");
            writes.push({ path: ref.path, data, merge: false });
          },
        });
        if (state.failCommit) throw new Error("Commit failed");
        for (const w of writes)
          state.docs.set(
            w.path,
            w.merge
              ? { ...state.docs.get(w.path), ...structuredClone(w.data) }
              : structuredClone(w.data),
          );
        return result;
      },
    },
  };
});
vi.mock("../server/gmail", () => ({
  Gmail: class {
    constructor(public account: any) {}
    labels = async () => {
      state.labelCalls.push(this.account.email);
      if (state.failLabels) throw new Error("Gmail unavailable");
      return state.labels.get(this.account.email) ?? [];
    };
  },
}));
import {
  updateRules,
  batchRuleSchema,
  patchRuleSchema,
  editableRuleSchema,
  validateRule,
  buildRecruitingRule,
  listRulesForAccount,
  choiceActionsSchema,
} from "../server/rules";
const emails = ["a@example.com", "b@example.com", "c@example.com"];
const prompt = "Classify only personally directed employment opportunities.";
const path = (e: string) => `accounts/${e}/rules/recruiting`;
beforeEach(() => {
  state.docs.clear();
  state.labels.clear();
  state.failCommit = false;
  state.failLabels = false;
  state.labelCalls.length = 0;
  for (const email of emails) {
    state.docs.set(`accounts/${email}`, {
      email,
      owner: "owner@example.com",
      rulesRevision: 1,
    });
    state.labels.set(email, [
      { id: `${email}-label`, name: `${email} Recruiting`, type: "user" },
      { id: `${email}-new`, name: "New label", type: "user" },
      { id: `${email}-protected`, name: "Job Search", type: "user" },
      { id: `${email}-nested`, name: "Job Search/Active", type: "user" },
    ]);
    state.docs.set(path(email), {
      id: "recruiting",
      email,
      name: "Recruiting",
      prompt: "Only direct engineering role invitations.",
      enabled: false,
      threshold: 0.95,
      scope: "thread",
      draftReplies: true,
      preserveJobSearch: true,
      choices: [
        {
          id: "recruiting",
          name: "Recruiting",
          description: "Hiring intent",
          labelId: `${email}-label`,
          labelName: "Old name",
        },
      ],
      version: 1,
      createdAt: 100,
      updatedAt: 100,
    });
  }
});
const batch = () =>
  batchRuleSchema.parse({
    targets: emails
      .slice(0, 2)
      .map((email) => ({ email, ruleId: "recruiting", expectedVersion: 1 })),
    changes: { prompt },
  });
it("applies prompt edits atomically, increments versions and preserves all unselected fields", async () => {
  const before = structuredClone(state.docs.get(path(emails[0]))),
    unselected = structuredClone(state.docs.get(path(emails[2])));
  expect(batch().changes).toEqual({ prompt });
  expect(patchRuleSchema.parse({ expectedVersion: 1, prompt })).toEqual({
    expectedVersion: 1,
    prompt,
  });
  const updated = await updateRules("owner@example.com", batch());
  expect(updated).toHaveLength(2);
  const { draftReplies, preserveJobSearch, ...canonicalBefore } = before;
  expect(updated[0]).toMatchObject({
    ...canonicalBefore,
    protectedLabels: [
      {
        labelId: `${emails[0]}-protected`,
        labelName: "Job Search",
        includeChildren: true,
      },
      {
        labelId: `${emails[0]}-nested`,
        labelName: "Job Search/Active",
        includeChildren: true,
      },
    ],
    replyDraft: { choiceIds: ["recruiting"], body: expect.any(String) },
    prompt,
    choices: [{ ...before.choices[0], labelName: `${emails[0]} Recruiting` }],
    version: 2,
    updatedAt: expect.any(Number),
    lastError: null,
  });
  expect(updated[0]).not.toHaveProperty("draftReplies");
  expect(updated[0]).not.toHaveProperty("preserveJobSearch");
  expect(state.docs.get(path(emails[2]))).toEqual(unselected);
  expect(
    state.docs.get(`accounts/${emails[0]}/ruleVersions/recruiting_v2`),
  ).toEqual(updated[0]);
});
it("replaces multiple-choice mappings independently for each selected mailbox", async () => {
  const input = batch();
  input.changes = { draftReplies: false };
  for (const t of input.targets)
    t.choices = [
      {
        id: "recruiting",
        name: "Recruiting",
        description: "Hiring outreach",
        labelId: `${t.email}-label`,
        labelName: "stale",
      },
      {
        id: "consulting",
        name: "Consulting",
        description: "Paid contracts",
        labelId: `${t.email}-new`,
        labelName: "stale",
      },
    ];
  const result = await updateRules("owner@example.com", input);
  expect(result.map((r) => r.choices[1].labelId)).toEqual(
    emails.slice(0, 2).map((e) => `${e}-new`),
  );
  expect(result.every((r) => r.choices[1].labelName === "New label")).toBe(
    true,
  );
});
it.each([
  "ownership",
  "missing rule",
  "version",
  "deleted label",
  "wrong mailbox label",
  "commit",
])("writes nothing if any target fails: %s", async (condition) => {
  const input = batch();
  if (condition === "ownership")
    state.docs.get(`accounts/${emails[1]}`).owner = "other@example.com";
  if (condition === "missing rule") state.docs.delete(path(emails[1]));
  if (condition === "version") input.targets[1].expectedVersion = 99;
  if (condition === "deleted label") state.labels.set(emails[1], []);
  if (condition === "wrong mailbox label")
    input.targets[1].choices = [
      {
        ...state.docs.get(path(emails[1])).choices[0],
        labelId: `${emails[0]}-label`,
      },
    ];
  if (condition === "commit") state.failCommit = true;
  const before = structuredClone(state.docs.get(path(emails[0])));
  await expect(updateRules("owner@example.com", input)).rejects.toThrow();
  expect(state.docs.get(path(emails[0]))).toEqual(before);
  expect(
    state.docs.has(`accounts/${emails[0]}/ruleVersions/recruiting_v2`),
  ).toBe(false);
});
it("prevents accidental reserved outputs and duplicate mappings", () => {
  const choice = state.docs.get(path(emails[0])).choices[0];
  for (const choices of [[{ ...choice, id: "no_match" }], [choice, choice]])
    expect(() =>
      editableRuleSchema.parse({ name: "Rule", prompt, choices }),
    ).toThrow();
});
it("keeps migration prompt and recruiting-specific settings exact", () => {
  const account = {
    email: emails[0],
    classificationPrompt: prompt,
    enabled: true,
    threshold: 0.8,
    draftReplies: true,
    label: "Job Search",
  } as any;
  const rule = buildRecruitingRule(account, {
    id: "L",
    name: "Job Search",
    type: "user",
  });
  expect(rule).toMatchObject({
    id: "recruiting",
    prompt,
    scope: "thread",
    threshold: 0.8,
    protectedLabels: [
      { labelId: "L", labelName: "Job Search", includeChildren: true },
    ],
    replyDraft: { choiceIds: ["recruiting"], body: expect.any(String) },
  });
  expect(rule).not.toHaveProperty("draftReplies");
  expect(rule).not.toHaveProperty("preserveJobSearch");
  expect(rule.choices).toHaveLength(1);
});

it("rejects edits while any selected mailbox is processing, with no partial writes", async () => {
  state.docs.set(`locks/${emails[1]}`, { until: Date.now() + 60000 });
  await expect(updateRules("owner@example.com", batch())).rejects.toThrow(
    "No rules were changed",
  );
  expect(state.docs.get(path(emails[0])).version).toBe(1);
});

it("validates arbitrary draft choices and refreshes exact/nested protected label mappings", () => {
  const before = state.docs.get(path(emails[0]));
  const rule = validateRule(
    {
      ...before,
      choices: [
        ...before.choices,
        {
          id: "invoice",
          name: "Invoice",
          description: "A bill",
          labelId: `${emails[0]}-new`,
          labelName: "Old",
        },
      ],
      replyDraft: {
        choiceIds: ["invoice"],
        body: "  Thanks for the invoice.\nWe will review it.  ",
      },
      protectedLabels: [
        {
          labelId: `${emails[0]}-protected`,
          labelName: "Old",
          includeChildren: false,
        },
        {
          labelId: `${emails[0]}-nested`,
          labelName: "Old child",
          includeChildren: true,
        },
      ],
    },
    state.labels.get(emails[0])!,
  );
  expect(rule.replyDraft).toEqual({
    choiceIds: ["invoice"],
    body: "Thanks for the invoice.\nWe will review it.",
  });
  expect(rule.protectedLabels).toEqual([
    {
      labelId: `${emails[0]}-protected`,
      labelName: "Job Search",
      includeChildren: false,
    },
    {
      labelId: `${emails[0]}-nested`,
      labelName: "Job Search/Active",
      includeChildren: true,
    },
  ]);
  expect(rule).not.toHaveProperty("draftReplies");
});
it.each([
  { choiceIds: ["missing"], body: "A draft" },
  { choiceIds: ["no_match"], body: "A draft" },
  { choiceIds: [], body: "A draft" },
  { choiceIds: ["recruiting", "recruiting"], body: "A draft" },
  { choiceIds: ["recruiting"], body: "   " },
  { choiceIds: ["recruiting"], body: "x".repeat(6001) },
])("rejects invalid reply draft configuration", (replyDraft) => {
  expect(() =>
    validateRule(
      { ...state.docs.get(path(emails[0])), replyDraft },
      state.labels.get(emails[0])!,
    ),
  ).toThrow();
});
it("requires existing user labels for protection and rejects duplicate protected IDs", () => {
  const before = state.docs.get(path(emails[0]));
  for (const protectedLabels of [
    [{ labelId: "missing", labelName: "Missing", includeChildren: false }],
    [{ labelId: "SENT", labelName: "Sent", includeChildren: false }],
    [
      {
        labelId: `${emails[0]}-protected`,
        labelName: "Job Search",
        includeChildren: false,
      },
      {
        labelId: `${emails[0]}-protected`,
        labelName: "Job Search",
        includeChildren: true,
      },
    ],
  ])
    expect(() =>
      validateRule({ ...before, protectedLabels }, [
        ...state.labels.get(emails[0])!,
        { id: "SENT", name: "Sent", type: "system" },
      ]),
    ).toThrow();
});
it("explicit generic disables cannot be revived by legacy true flags during update", async () => {
  const input = batch();
  input.changes = {
    replyDraft: null,
    draftReplies: true,
    preserveJobSearch: true,
  };
  for (const target of input.targets) target.protectedLabels = [];
  const updated = await updateRules("owner@example.com", input);
  for (const rule of updated) {
    expect(rule.replyDraft).toBeNull();
    expect(rule.protectedLabels).toEqual([]);
    expect(rule).not.toHaveProperty("draftReplies");
    expect(rule).not.toHaveProperty("preserveJobSearch");
  }
  const again = batchRuleSchema.parse({
    targets: updated.map((rule) => ({
      email: rule.email,
      ruleId: rule.id,
      expectedVersion: rule.version,
    })),
    changes: {
      prompt: "Updated prompt without behavior fields in this request.",
    },
  });
  for (const rule of await updateRules("owner@example.com", again))
    expect(rule).toMatchObject({ protectedLabels: [], replyDraft: null });
});
it("validates mailbox-specific protected labels atomically across a batch", async () => {
  const input = batch();
  input.changes = { replyDraft: null };
  input.targets[0].protectedLabels = [
    {
      labelId: `${emails[0]}-protected`,
      labelName: "Old",
      includeChildren: true,
    },
  ];
  input.targets[1].protectedLabels = [
    {
      labelId: `${emails[0]}-protected`,
      labelName: "Wrong mailbox",
      includeChildren: true,
    },
  ];
  await expect(updateRules("owner@example.com", input)).rejects.toThrow(
    "unavailable",
  );
  expect(state.docs.get(path(emails[0])).version).toBe(1);
  expect(state.docs.get(path(emails[1])).version).toBe(1);
});
it("rejects a shared draft referring to a choice absent in any selected rule with no partial write", async () => {
  const input = batch();
  input.changes = {
    replyDraft: { choiceIds: ["invoice"], body: "Thanks for your invoice." },
  };
  input.targets[0].choices = [
    {
      id: "invoice",
      name: "Invoice",
      description: "A bill",
      labelId: `${emails[0]}-new`,
      labelName: "New label",
    },
  ];
  await expect(updateRules("owner@example.com", input)).rejects.toThrow(
    "choices must exist",
  );
  expect(state.docs.get(path(emails[0])).version).toBe(1);
  expect(state.docs.get(path(emails[1])).version).toBe(1);
});
it("does not fetch Gmail when generic behaviors exist or both old flags are false", async () => {
  const before = state.docs.get(path(emails[0]));
  Object.assign(before, { protectedLabels: [], replyDraft: null });
  state.failLabels = true;
  const loaded = await listRulesForAccount(
    state.docs.get(`accounts/${emails[0]}`),
  );
  expect(loaded[0]).toMatchObject({ protectedLabels: [], replyDraft: null });
  delete before.protectedLabels;
  delete before.replyDraft;
  before.draftReplies = false;
  before.preserveJobSearch = false;
  await listRulesForAccount(state.docs.get(`accounts/${emails[0]}`));
  expect(state.labelCalls).toHaveLength(0);
});
it("returns a clear failure rather than silently dropping legacy protections when Gmail is unavailable", async () => {
  const before = structuredClone(state.docs.get(path(emails[0])));
  state.failLabels = true;
  await expect(
    listRulesForAccount(state.docs.get(`accounts/${emails[0]}`)),
  ).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining("protections have not been changed"),
  });
  expect(state.docs.get(path(emails[0]))).toEqual(before);
});

it("defaults new generic rules to no protections and no draft", () => {
  const { draftReplies, preserveJobSearch, ...plain } = state.docs.get(
    path(emails[0]),
  );
  expect(validateRule(plain, state.labels.get(emails[0])!)).toMatchObject({
    protectedLabels: [],
    replyDraft: null,
  });
});
it("leaves the original immutable legacy snapshot untouched when saving canonical behavior", async () => {
  const before = structuredClone(state.docs.get(path(emails[0])));
  const versionPath = `accounts/${emails[0]}/ruleVersions/recruiting_v1`;
  state.docs.set(versionPath, before);
  await updateRules("owner@example.com", batch());
  expect(state.docs.get(versionPath)).toEqual(before);
  expect(state.docs.get(path(emails[0])).version).toBe(2);
  expect(state.docs.get(path(emails[0]))).not.toHaveProperty("draftReplies");
});

const actionChoice = (actions: unknown) => ({
  id: "match",
  name: "Match",
  description: "Selected messages",
  actions,
});
it("accepts all action combinations including label-free actions and shared labels", () => {
  for (const actions of [
    { markRead: true },
    { replyDraft: { body: "Reply text" } },
    { forward: { to: "destination@example.com" } },
    { labels: [{ labelId: "L", labelName: "Label" }] },
    {
      markRead: true,
      replyDraft: { body: "Reply" },
      forward: { to: "other@example.com" },
      labels: [
        { labelId: "L", labelName: "Label" },
        { labelId: "M", labelName: "More" },
      ],
    },
  ]) {
    const choice = actionChoice(actions);
    expect(
      editableRuleSchema.parse({
        name: "Rule",
        prompt,
        choices: [choice, { ...choice, id: "other" }],
      }).choices,
    ).toHaveLength(2);
  }
});
it("rejects empty actions, invalid recipients, duplicate labels and empty draft text", () => {
  for (const actions of [
    {},
    { markRead: false, labels: [], replyDraft: null, forward: null },
    { forward: { to: "a@example.com\r\nBcc: bad@example.com" } },
    { forward: { to: "invalid" } },
    { replyDraft: { body: " " } },
    {
      labels: [
        { labelId: "L", labelName: "Label" },
        { labelId: "L", labelName: "Label" },
      ],
    },
  ])
    expect(() => choiceActionsSchema.parse(actions)).toThrow();
});
it("explicit actions override stale legacy labels and drafts", () => {
  const before = state.docs.get(path(emails[0]));
  const result = validateRule(
    {
      ...before,
      choices: [
        {
          ...before.choices[0],
          labelId: "missing",
          actions: {
            labels: [],
            replyDraft: null,
            markRead: true,
            forward: null,
          },
        },
      ],
    },
    state.labels.get(emails[0])!,
  );
  expect(result.choices[0].actions).toEqual({
    labels: [],
    replyDraft: null,
    markRead: true,
    forward: null,
  });
});
it("batch prompt edits preserve per-choice actions and immutable earlier versions", async () => {
  const before = state.docs.get(path(emails[0]));
  before.choices[0].actions = {
    labels: [],
    replyDraft: { body: "Custom reply" },
    markRead: true,
    forward: { to: "forward@example.com" },
  };
  const previous = structuredClone(before);
  const versionPath = `accounts/${emails[0]}/ruleVersions/recruiting_v1`;
  state.docs.set(versionPath, previous);
  const updated = await updateRules("owner@example.com", batch());
  expect(updated[0].choices[0].actions).toEqual(previous.choices[0].actions);
  expect(state.docs.get(versionPath)).toEqual(previous);
});
it("legacy draft toggles update migrated choice actions without overriding explicit action replacements", async () => {
  const input = batch();
  input.changes = { replyDraft: null };
  input.targets[0].choices = [
    {
      id: "recruiting",
      name: "Recruiting",
      description: "Hiring",
      actions: {
        labels: [],
        replyDraft: { body: "Explicit reply" },
        markRead: false,
        forward: null,
      },
    },
  ];
  const updated = await updateRules("owner@example.com", input);
  expect(updated[0].choices[0].actions?.replyDraft).toEqual({
    body: "Explicit reply",
  });
  expect(updated[1].choices[0].actions?.replyDraft).toBeNull();
});

it("legacy draft enable still works after actions normalization", async () => {
  const input = batch();
  input.changes = { draftReplies: true };
  for (const email of emails) state.docs.get(path(email)).draftReplies = false;
  const updated = await updateRules("owner@example.com", input);
  expect(updated[0].choices[0].actions?.replyDraft?.body).toBeTruthy();
});
it("legacy choice edits preserve unrepresented actions and additional labels", async () => {
  const input = batch();
  const before = state.docs.get(path(emails[0]));
  before.choices[0].actions = {
    labels: [
      { labelId: `${emails[0]}-label`, labelName: "Old" },
      { labelId: `${emails[0]}-protected`, labelName: "Second" },
    ],
    replyDraft: { body: "Custom" },
    markRead: true,
    forward: { to: "forward@example.com" },
  };
  input.targets[0].choices = [
    {
      ...before.choices[0],
      actions: undefined,
      labelId: `${emails[0]}-new`,
      labelName: "New label",
      name: "Renamed",
    },
  ];
  const updated = await updateRules("owner@example.com", input);
  expect(updated[0].choices[0].actions).toEqual({
    labels: [
      { labelId: `${emails[0]}-new`, labelName: "New label" },
      { labelId: `${emails[0]}-protected`, labelName: "Job Search" },
    ],
    replyDraft: { body: "Custom" },
    markRead: true,
    forward: { to: "forward@example.com" },
  });
});
it("explicit modern replacement actions ignore obsolete recruiting enable flags", async () => {
  const input = batch();
  input.changes = { draftReplies: true };
  input.targets[0].choices = [
    {
      id: "different",
      name: "Different",
      description: "Another choice",
      actions: { labels: [], replyDraft: null, markRead: true, forward: null },
    },
  ];
  const updated = await updateRules("owner@example.com", input);
  expect(updated[0].choices[0].actions?.replyDraft).toBeNull();
  expect(updated[1].choices[0].actions?.replyDraft?.body).toBeTruthy();
});
