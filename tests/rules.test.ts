import { beforeEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  failCommit: false,
  labels: new Map<string, any[]>(),
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
    labels = async () => state.labels.get(this.account.email) ?? [];
  },
}));
import {
  updateRules,
  batchRuleSchema,
  patchRuleSchema,
  editableRuleSchema,
  validateRule,
  buildRecruitingRule,
} from "../server/rules";
const emails = ["a@example.com", "b@example.com", "c@example.com"];
const prompt = "Classify only personally directed employment opportunities.";
const path = (e: string) => `accounts/${e}/rules/recruiting`;
beforeEach(() => {
  state.docs.clear();
  state.labels.clear();
  state.failCommit = false;
  for (const email of emails) {
    state.docs.set(`accounts/${email}`, {
      email,
      owner: "owner@example.com",
      rulesRevision: 1,
    });
    state.labels.set(email, [
      { id: `${email}-label`, name: `${email} Recruiting`, type: "user" },
      { id: `${email}-new`, name: "New label", type: "user" },
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
  expect(updated[0]).toMatchObject({
    ...before,
    prompt,
    choices: [{ ...before.choices[0], labelName: `${emails[0]} Recruiting` }],
    version: 2,
    updatedAt: expect.any(Number),
    lastError: null,
  });
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
  for (const choices of [
    [{ ...choice, id: "no_match" }],
    [choice, choice],
    [choice, { ...choice, id: "another" }],
  ])
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
    draftReplies: true,
    preserveJobSearch: true,
  });
  expect(rule.choices).toHaveLength(1);
});

it("rejects edits while any selected mailbox is processing, with no partial writes", async () => {
  state.docs.set(`locks/${emails[1]}`, { until: Date.now() + 60000 });
  await expect(updateRules("owner@example.com", batch())).rejects.toThrow(
    "No rules were changed",
  );
  expect(state.docs.get(path(emails[0])).version).toBe(1);
});
