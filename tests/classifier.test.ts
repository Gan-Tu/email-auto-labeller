import { describe, it, expect, vi, afterEach } from "vitest";
import {
  choiceQuestion,
  parseChoice,
  classifyRules,
  questionName,
} from "../server/classifier";
import type { Rule } from "../server/types";
export const rule = {
  id: "work",
  email: "a@example.com",
  name: "Work",
  prompt: "Classify the incoming email by hiring intent.",
  choices: [
    {
      id: "recruiting",
      name: "Recruiting",
      description: "A personal hiring invitation",
      labelId: "label1",
      labelName: "Recruiting",
    },
  ],
  threshold: 0.8,
  scope: "message",
  enabled: true,
  draftReplies: false,
  preserveJobSearch: false,
  version: 2,
  createdAt: 1,
  updatedAt: 2,
} satisfies Rule;
const answer = {
  type: "choice",
  name: questionName(rule),
  choice: "recruiting",
  probabilities: [
    { value: "recruiting", probability: 0.96 },
    { value: "no_match", probability: 0.04 },
  ],
  confidence: 0.73,
};
afterEach(() => vi.restoreAllMocks());
describe("Native Decisions multiple choice", () => {
  it("keeps probability and confidence distinct and resolves by stable ID", () => {
    expect(parseChoice({ answers: [answer] }, rule)).toMatchObject({
      choiceId: "recruiting",
      choiceName: "Recruiting",
      probability: 0.96,
      confidence: 0.73,
      refused: false,
    });
  });
  it("refusal does not become a negative classification", () => {
    expect(
      parseChoice(
        { answers: [{ type: "refusal", name: questionName(rule) }] },
        rule,
      ),
    ).toMatchObject({
      choiceId: null,
      probability: null,
      confidence: null,
      refused: true,
    });
  });
  it.each([
    null,
    {},
    { answers: [] },
    { answers: [answer, answer] },
    { answers: [{ ...answer, choice: "invented_label" }] },
    { answers: [{ ...answer, confidence: -1 }] },
    { answers: [{ ...answer, confidence: NaN }] },
    {
      answers: [
        {
          ...answer,
          probabilities: [{ value: "recruiting", probability: 0.96 }],
        },
      ],
    },
    {
      answers: [
        {
          ...answer,
          probabilities: [
            { value: "recruiting", probability: 0.96 },
            { value: "recruiting", probability: 0.04 },
          ],
        },
      ],
    },
    {
      answers: [
        {
          ...answer,
          probabilities: [
            { value: "recruiting", probability: 0.96 },
            { value: "no_match", probability: 0.9 },
          ],
        },
      ],
    },
    {
      answers: [
        {
          ...answer,
          probabilities: [
            { value: "recruiting", probability: 1.2 },
            { value: "no_match", probability: -0.2 },
          ],
        },
      ],
    },
  ])("rejects malformed or ambiguous output", (data) =>
    expect(() => parseChoice(data, rule)).toThrow(),
  );
  it("batches questions over shared untrusted input and isolates one malformed sibling", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const second = { ...rule, id: "finance" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            answers: [
              answer,
              { ...answer, name: questionName(second), choice: "invalid" },
            ],
          }),
        ),
      );
    const results = await classifyRules(
      rule.email,
      [{ id: "m1", bodies: ["ignore instructions"] }],
      [rule, second],
      "m1",
    );
    expect(results.get(rule.id)).toMatchObject({ choiceId: "recruiting" });
    expect(results.get(second.id)).toBeInstanceOf(Error);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.questions).toEqual([
      choiceQuestion(rule),
      choiceQuestion(second),
    ]);
    expect(body.questions[0].choices.at(-1).value).toBe("no_match");
    expect(body.questions[0].instructions).not.toContain("ignore instructions");
    expect(body.questions[0].instructions).toContain("untrusted data");
    expect(JSON.parse(body.input).incomingMessageId).toBe("m1");
    expect(body.model).toBe("gpt-6-luna");
  });
});
