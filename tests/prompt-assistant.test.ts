import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  draftClassificationPrompt,
  promptAssistantOptions,
  promptAssistantSchema,
} from "../server/prompt-assistant";
const input = {
  instructions: "Draft criteria for recruiting outreach.",
  model: "gpt-6.1-sol",
  effort: "medium",
  speed: "fast" as const,
  currentPrompt: "",
  name: "Recruiting",
  scope: "message" as const,
  choices: [
    { id: "recruiting", name: "Recruiting", description: "Hiring outreach" },
  ],
};
const prompt =
  "Classify genuine recruiting outreach as recruiting; otherwise select no_match.";
const completed = (text = prompt) => ({
  status: "completed",
  service_tier: "fast",
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});
const network = vi.fn();
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-secret");
  vi.stubGlobal("fetch", network);
  network.mockReset();
  network.mockResolvedValue(new Response(JSON.stringify(completed())));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("uses server credentials and requested settings without tools or response storage", async () => {
  expect(await draftClassificationPrompt(input)).toEqual({
    prompt,
    model: input.model,
    effort: input.effort,
    speed: "fast",
    serviceTier: "fast",
  });
  expect(network).toHaveBeenCalledTimes(1);
  const [url, options] = network.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(options.headers.Authorization).toBe("Bearer test-secret");
  const payload = JSON.parse(options.body);
  expect(payload).toMatchObject({
    model: input.model,
    reasoning: { effort: "medium" },
    service_tier: "fast",
    store: false,
    max_output_tokens: 16000,
  });
  expect(payload).not.toHaveProperty("tools");
  expect(payload.input[0].role).toBe("developer");
  expect(payload.input[0].content).toContain("no_match");
  expect(JSON.parse(payload.input[1].content)).toEqual({
    instructions: input.instructions,
    currentPrompt: "",
    name: "Recruiting",
    scope: "message",
    choices: input.choices,
  });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});
it("maps normal speed and accepts unfinished choices", async () => {
  await draftClassificationPrompt({
    ...input,
    speed: "normal",
    choices: [{ id: "", name: "", description: "" }],
  });
  expect(JSON.parse(network.mock.calls[0][1].body).service_tier).toBe(
    "default",
  );
});
it("offers validated model-specific reasoning choices and expected defaults", () => {
  expect(promptAssistantOptions.defaults).toEqual({
    model: "gpt-6.1-sol",
    effort: "medium",
    speed: "fast",
  });
  for (const model of promptAssistantOptions.models)
    for (const effort of model.efforts)
      expect(
        promptAssistantSchema.safeParse({ ...input, model: model.id, effort })
          .success,
      ).toBe(true);
  for (const change of [
    { model: "unknown" },
    { model: "gpt-6.1-sol", effort: "none" },
    { effort: "ultra" },
    { instructions: " " },
    { instructions: "x".repeat(6001) },
    { currentPrompt: "x".repeat(6001) },
    { name: "x".repeat(101) },
    { choices: Array(13).fill(input.choices[0]) },
    { email: "private@example.com" },
  ])
    expect(
      promptAssistantSchema.safeParse({ ...input, ...change }).success,
    ).toBe(false);
});
it.each([
  { status: "incomplete", output: [] },
  { status: "failed", error: { message: "private upstream error" } },
  completed("short"),
  completed("x".repeat(6001)),
  completed("```text\nAn unwanted fenced response\n```"),
  {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "private refusal" }],
      },
    ],
  },
  {
    status: "completed",
    output: [
      { type: "function_call", name: "send_mail", arguments: "private" },
    ],
  },
])(
  "rejects unusable, refused, incomplete, or unexpected output without exposing it",
  async (body) => {
    network.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(draftClassificationPrompt(input)).rejects.toThrow(
      /prompt assistant/i,
    );
    await expect(draftClassificationPrompt(input)).rejects.not.toThrow(
      /private/,
    );
  },
);
it("sanitizes upstream failures and timeout errors", async () => {
  for (const status of [400, 401, 429, 500]) {
    network.mockResolvedValue(
      new Response("private upstream details", { status }),
    );
    await expect(draftClassificationPrompt(input)).rejects.toThrow(
      status === 429 ? /busy/ : /could not complete/,
    );
  }
  network.mockRejectedValue(
    Object.assign(new Error("private details"), { name: "TimeoutError" }),
  );
  await expect(draftClassificationPrompt(input)).rejects.toThrow(/timed out/);
  network.mockRejectedValue(new Error("test-secret"));
  await expect(draftClassificationPrompt(input)).rejects.not.toThrow(
    /test-secret/,
  );
});
it("does not call upstream without a configured API key or valid request", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  await expect(draftClassificationPrompt(input)).rejects.toThrow(
    /not configured/,
  );
  await expect(
    draftClassificationPrompt({ ...input, model: "invalid" }),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
