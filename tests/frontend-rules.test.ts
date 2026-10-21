import { describe, expect, it } from "vitest";
import {
  cleanRule,
  batchChoiceActions,
  newChoice,
  emptyActions,
  choiceActions,
  matchingLabel,
  missingDraftChoiceIds,
  validateRule,
} from "../web/src/rules";
import { filteredHistory, mergeHistory } from "../web/src/history";
import type { Decision, Rule } from "../web/src/api";
const rule = (email = "first@example.com"): Rule => ({
  id: "work",
  email,
  name: "Work opportunities",
  prompt: "Classify personally directed employment outreach.",
  enabled: true,
  threshold: 0.8,
  scope: "message",
  version: 3,
  createdAt: 1,
  updatedAt: 1,
  choices: [
    {
      id: "recruiting",
      name: "Recruiting",
      description: "A specific offer to discuss employment.",
      labelId: "Label_1",
      labelName: "Recruiting",
    },
  ],
});
const decision = (
  ruleId: string,
  ruleVersion = 1,
  outcome = "labeled",
): Decision => ({
  email: "first@example.com",
  messageId: "message1",
  threadId: "thread1",
  subject: "An opportunity",
  outcome,
  ruleId,
  ruleVersion,
  createdAt: 1,
});
describe("per-rule activity", () => {
  it("keeps separate rules and versions on the same email and replaces only the matching execution", () => {
    const rows = mergeHistory(
      [
        decision("recruiting"),
        decision("consulting"),
        decision("recruiting", 2),
      ],
      [
        {
          ...decision("recruiting"),
          outcome: "failed",
          reason: "Label deleted",
        },
      ],
      500,
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.ruleId === "recruiting" && row.ruleVersion === 1)
        ?.outcome,
    ).toBe("failed");
    expect(rows.find((row) => row.ruleId === "consulting")?.outcome).toBe(
      "labeled",
    );
    expect(rows.find((row) => row.ruleVersion === 2)?.outcome).toBe("labeled");
  });
  it("keeps failure, uncertainty, no match, and legacy no match separately inspectable", () => {
    const rows = [
      "failed",
      "uncertain",
      "no_match",
      "not_recruiting",
      "labeled",
    ].map((outcome, index) => decision(String(index), 1, outcome));
    expect(filteredHistory(rows, "no_match").map((row) => row.outcome)).toEqual(
      ["no_match", "not_recruiting"],
    );
    expect(filteredHistory(rows, "failed").map((row) => row.outcome)).toEqual([
      "failed",
    ]);
    expect(filteredHistory(rows, "not_applied")).toHaveLength(4);
  });
});
describe("rule editor safeguards", () => {
  it("allows shared labels across choices and reserves No match", () => {
    const current = rule();
    current.choices.push({
      ...current.choices[0],
      id: "consulting",
      name: "Consulting",
    });
    expect(validateRule(current)).toBe("");
    current.choices[1].labelId = "Label_2";
    current.choices[1].name = "No match";
    expect(validateRule(current)).toContain("No match is already included");
  });
  it("allows reply drafts for any chosen subset of multiple non-recruiting choices", () => {
    const current = rule();
    current.choices = [
      { ...current.choices[0], id: "consulting", name: "Consulting" },
      {
        ...current.choices[0],
        id: "speaking",
        name: "Speaking",
        labelId: "Label_2",
        labelName: "Speaking",
      },
    ];
    current.replyDraft = {
      choiceIds: ["consulting", "speaking"],
      body: "Thanks for the invitation. Could you share the details?",
    };
    expect(validateRule(current)).toBe("");
    current.replyDraft.choiceIds = ["speaking"];
    expect(validateRule(current)).toBe("");
  });
  it("blocks removed draft choices without silently selecting their replacements", () => {
    const current = rule();
    current.replyDraft = {
      choiceIds: ["recruiting"],
      body: "Thanks for reaching out.",
    };
    const replacement = [
      { ...current.choices[0], id: "consulting", name: "Consulting" },
    ];
    expect(missingDraftChoiceIds(current, replacement)).toEqual(["recruiting"]);
    expect(current.replyDraft.choiceIds).toEqual(["recruiting"]);
    expect(validateRule({ ...current, choices: replacement })).toContain(
      "removed choice",
    );
    expect(
      validateRule({ ...current, choices: replacement, replyDraft: null }),
    ).toBe("");
    expect(
      validateRule({
        ...current,
        replyDraft: { ...current.replyDraft, choiceIds: ["no_match"] },
      }),
    ).toContain("removed choice");
  });
  it("requires explicit draft choices and a nonblank body within the limit", () => {
    const current = rule();
    current.replyDraft = { choiceIds: [], body: "Thanks for reaching out." };
    expect(validateRule(current)).toContain("Select at least one choice");
    current.replyDraft = { choiceIds: ["recruiting"], body: "   " };
    expect(validateRule(current)).toContain("1 and 6,000");
    current.replyDraft.body = "x".repeat(6001);
    expect(validateRule(current)).toContain("1 and 6,000");
    current.replyDraft.body = "x".repeat(6000);
    expect(validateRule(current)).toBe("");
  });
  it("preserves independent protection and draft settings in normalized payloads", () => {
    const current = {
      ...rule(),
      protectedLabels: [
        {
          labelId: "protected-archive",
          labelName: "Archive",
          includeChildren: true,
        },
      ],
      replyDraft: {
        choiceIds: ["recruiting"],
        body: "  Thanks for reaching out.  ",
      },
      draftReplies: true,
      preserveJobSearch: true,
    };
    const cleaned = cleanRule(current);
    expect(cleaned.protectedLabels).toEqual(current.protectedLabels);
    expect(cleaned.choices[0].actions?.replyDraft).toEqual({
      body: "Thanks for reaching out.",
    });
    expect(cleaned.protectedLabels).not.toBe(current.protectedLabels);
    expect(cleaned.replyDraft).toBeNull();
    expect(cleaned).not.toHaveProperty("draftReplies");
    expect(cleaned).not.toHaveProperty("preserveJobSearch");
    expect(cleanRule(rule())).toMatchObject({
      protectedLabels: [],
      replyDraft: null,
    });
    expect(
      cleanRule({ ...current, protectedLabels: [], replyDraft: null }),
    ).toMatchObject({ protectedLabels: [], replyDraft: null });
  });
  it("rejects incomplete or repeated protected labels", () => {
    const current = rule();
    current.protectedLabels = [
      { labelId: "", labelName: "", includeChildren: false },
    ];
    expect(validateRule(current)).toContain("every protected label row");
    current.protectedLabels = [
      { labelId: "archive", labelName: "Archive", includeChildren: false },
      { labelId: "archive", labelName: "Archive", includeChildren: true },
    ];
    expect(validateRule(current)).toContain("only once");
  });
  it("preserves each mailbox mapping when batch wording uses a common source", () => {
    const source = rule();
    const target = rule("second@example.com");
    target.choices[0].labelId = "Label_9382";
    target.choices[0].labelName = "Job Request";
    expect(matchingLabel(target, source.choices[0])).toBe("Label_9382");
    expect(
      matchingLabel(target, {
        ...source.choices[0],
        id: "speaking",
        name: "Speaking",
      }),
    ).toBe("");
  });
  it("submits editable configuration without overriding mailbox identity or version metadata", () => {
    const current = {
      ...rule(),
      name: " Work opportunities ",
      prompt: "  Classify personally directed employment outreach.  ",
    };
    expect(cleanRule(current)).toMatchObject({
      name: "Work opportunities",
      prompt: "Classify personally directed employment outreach.",
    });
    expect(cleanRule(current)).not.toHaveProperty("email");
    expect(cleanRule(current)).not.toHaveProperty("version");
    expect(cleanRule(current)).not.toHaveProperty("id");
  });
});

describe("choice action configuration", () => {
  it("starts with every action off and requires an action", () => {
    const current = rule();
    current.choices[0].actions = newChoice().actions;
    expect(current.choices[0].actions).toEqual(emptyActions());
    expect(validateRule(current)).toContain("at least one action");
    current.choices[0].actions!.markRead = true;
    expect(validateRule(current)).toBe("");
  });
  it("supports draft-only and forwarding-only choices without resurrecting legacy labels", () => {
    const current = rule();
    current.choices[0].actions = {
      ...emptyActions(),
      replyDraft: { body: "Thank you." },
    };
    expect(validateRule(current)).toBe("");
    expect(cleanRule(current).choices[0].actions?.labels).toEqual([]);
    current.choices[0].actions = {
      ...emptyActions(),
      forward: { to: "person@example.com" },
    };
    expect(validateRule(current)).toBe("");
    current.choices[0].actions.forward!.to = "bad address";
    expect(validateRule(current)).toContain("valid forwarding");
  });
  it("normalizes legacy labels and selected drafts and preserves explicit actions", () => {
    const current = rule();
    current.replyDraft = { choiceIds: ["recruiting"], body: "Thank you." };
    expect(cleanRule(current).choices[0].actions).toEqual({
      labels: [{ labelId: "Label_1", labelName: "Recruiting" }],
      replyDraft: { body: "Thank you." },
      markRead: false,
      forward: null,
    });
    current.choices[0].actions = emptyActions();
    expect(choiceActions(current.choices[0], current.replyDraft)).toEqual(
      emptyActions(),
    );
  });
  it("reports completed non-label actions and partial successes in activity", () => {
    const rows = [
      decision("read", 1, "matched"),
      {
        ...decision("partial", 1, "failed"),
        actions: [{ type: "markRead" as const, status: "completed" as const }],
      },
    ];
    expect(filteredHistory(rows, "applied")).toHaveLength(2);
    expect(filteredHistory(rows, "not_applied")).toHaveLength(0);
  });
});

it("keeps batch actions by choice identity and remaps every replacement label per mailbox", () => {
  const target = rule();
  target.choices[0].actions = { ...emptyActions(), markRead: true };
  const source = {
    ...target.choices[0],
    actions: {
      ...emptyActions(),
      labels: [
        { labelId: "source1", labelName: "Work" },
        { labelId: "source2", labelName: "Follow up" },
      ],
      forward: { to: "person@example.com" },
    },
  };
  const labels = [
    { id: "target1", name: "Work" },
    { id: "target2", name: "Follow up" },
  ];
  expect(batchChoiceActions(target, source, labels, false)).toEqual(
    target.choices[0].actions,
  );
  expect(batchChoiceActions(target, source, labels, true)).toMatchObject({
    labels: [
      { labelId: "target1", labelName: "Work" },
      { labelId: "target2", labelName: "Follow up" },
    ],
    forward: { to: "person@example.com" },
  });
  expect(
    batchChoiceActions(target, source, [], true).labels.every(
      (l) => l.labelId === "",
    ),
  ).toBe(true);
});
