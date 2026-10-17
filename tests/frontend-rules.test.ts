import { describe, expect, it } from "vitest";
import { cleanRule, matchingLabel, validateRule } from "../web/src/rules";
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
  it("prevents two choices from mapping to the same label and reserves No match", () => {
    const current = rule();
    current.choices.push({
      ...current.choices[0],
      id: "consulting",
      name: "Consulting",
    });
    expect(validateRule(current)).toContain("different Gmail label");
    current.choices[1].labelId = "Label_2";
    current.choices[1].name = "No match";
    expect(validateRule(current)).toContain("No match is already included");
  });
  it("requires the specific legacy recruiting choice for decline drafts", () => {
    const current = { ...rule(), draftReplies: true };
    expect(validateRule(current)).toBe("");
    current.choices = [
      { ...current.choices[0], id: "consulting", name: "Consulting" },
    ];
    expect(validateRule(current)).toContain("Decline drafts require");
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
