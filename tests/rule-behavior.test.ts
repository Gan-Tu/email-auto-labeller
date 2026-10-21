import { describe, it, expect } from "vitest";
import {
  needsLegacyBehavior,
  normalizeChoiceActions,
  normalizeRuleBehavior,
  RuleBehaviorError,
} from "../server/rule-behavior";
import type { Label, Rule } from "../server/types";
const labels: Label[] = [
  { id: "root", name: "Job Search", type: "user" },
  { id: "child", name: "Job Search/Active", type: "user" },
  { id: "odd", name: "Job-Search Notes", type: "user" },
  { id: "other", name: "Other Job Search", type: "user" },
  { id: "system", name: "Job Search System", type: "system" },
];
const legacy = (): Rule => ({
  id: "recruiting",
  email: "owner@example.com",
  name: "Recruiting",
  prompt: "Classify incoming employment opportunities.",
  choices: [
    {
      id: "recruiting",
      name: "Recruiting",
      description: "Employment outreach",
      labelId: "root",
      labelName: "Job Search",
    },
  ],
  enabled: true,
  threshold: 0.8,
  scope: "thread",
  draftReplies: true,
  preserveJobSearch: true,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});
describe("Legacy behavior conversion", () => {
  it("converts every old matching label and exact private reply body without mutating the snapshot", () => {
    const before = legacy(),
      frozen = structuredClone(before);
    const converted = normalizeRuleBehavior(
      before,
      labels,
      "  My configured private reply.\nRegards.  ",
    );
    expect(converted.protectedLabels).toEqual([
      { labelId: "root", labelName: "Job Search", includeChildren: true },
      {
        labelId: "child",
        labelName: "Job Search/Active",
        includeChildren: true,
      },
      { labelId: "odd", labelName: "Job-Search Notes", includeChildren: true },
    ]);
    expect(converted.replyDraft).toEqual({
      choiceIds: ["recruiting"],
      body: "My configured private reply.\nRegards.",
    });
    expect(converted).not.toHaveProperty("draftReplies");
    expect(converted).not.toHaveProperty("preserveJobSearch");
    expect(before).toEqual(frozen);
  });
  it("honors explicit generic disables over true legacy flags", () => {
    const before = { ...legacy(), protectedLabels: [], replyDraft: null };
    expect(needsLegacyBehavior(before)).toBe(false);
    expect(normalizeRuleBehavior(before, labels, "private body")).toMatchObject(
      { protectedLabels: [], replyDraft: null },
    );
  });
  it("does not require live Gmail for absent or disabled legacy behavior", () => {
    const before = {
      ...legacy(),
      draftReplies: false,
      preserveJobSearch: false,
    };
    expect(needsLegacyBehavior(before)).toBe(false);
    expect(normalizeRuleBehavior(before, [], "private body")).toMatchObject({
      protectedLabels: [],
      replyDraft: null,
    });
  });
  it("does not silently expand a legacy recruiting draft to other choices", () => {
    const before = legacy();
    before.choices.push({
      ...before.choices[0],
      id: "invoice",
      labelId: "other",
    });
    expect(() => normalizeRuleBehavior(before, labels, "private body")).toThrow(
      RuleBehaviorError,
    );
  });
  it("preserves arbitrary generic choice drafts and stable IDs through renamed labels", () => {
    const before = {
      ...legacy(),
      protectedLabels: [
        { labelId: "root", labelName: "Old name", includeChildren: true },
      ],
      replyDraft: { choiceIds: ["invoice"], body: "Thanks for your invoice." },
    };
    const converted = normalizeRuleBehavior(
      before,
      [{ id: "root", name: "Billing", type: "user" }],
      "must not replace generic body",
    );
    expect(converted.replyDraft).toEqual(before.replyDraft);
    expect(converted.protectedLabels).toEqual([
      { labelId: "root", labelName: "Billing", includeChildren: true },
    ]);
    expect(
      normalizeRuleBehavior(before, [], "private body").protectedLabels,
    ).toEqual(before.protectedLabels);
  });
});

it("migrates labels and choice-specific drafts without enabling new actions", () => {
  const old = legacy();
  const converted = normalizeRuleBehavior(old, labels, "Legacy reply");
  expect(converted.choices[0].actions).toEqual({
    labels: [{ labelId: "root", labelName: "Job Search" }],
    replyDraft: { body: "Legacy reply" },
    markRead: false,
    forward: null,
  });
  expect(old.choices[0]).not.toHaveProperty("actions");
});
it("explicit empty actions never resurrect old actions during normalization", () => {
  const old = legacy();
  const actions = {
    labels: [],
    replyDraft: null,
    markRead: false,
    forward: null,
  };
  old.choices[0].actions = actions;
  expect(
    normalizeRuleBehavior(old, labels, "Legacy reply").choices[0].actions,
  ).toEqual(actions);
  const result = normalizeChoiceActions(old, old.choices[0]);
  expect(result).toEqual(actions);
  expect(result).not.toBe(actions);
});

it("ignores obsolete recruiting draft flags once every choice has explicit actions", () => {
  const old = legacy();
  old.protectedLabels = [];
  old.choices = [
    {
      id: "new",
      name: "New",
      description: "New choice",
      actions: { labels: [], replyDraft: null, markRead: true, forward: null },
    },
  ];
  expect(needsLegacyBehavior(old)).toBe(false);
  expect(
    normalizeRuleBehavior(old, [], "").choices[0].actions?.replyDraft,
  ).toBeNull();
});
