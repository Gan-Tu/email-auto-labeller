import { describe, expect, it } from "vitest";
import {
  promptContext,
  promptOptionsDefaults,
  supportedEffort,
} from "../web/src/prompt-assistant";

describe("prompt assistant payload and model selection", () => {
  it("only shares classification context, excluding mailbox identity and action text", () => {
    const input = {
      currentPrompt: "Classify work",
      name: "Work",
      scope: "message" as const,
      email: "private@example.com",
      choices: [
        {
          id: "work",
          name: "Work",
          description: "Employment outreach",
          labelId: "private-label",
          actions: {
            replyDraft: { body: "private reply" },
            forward: { to: "private@example.com" },
          },
        },
      ],
    };
    expect(promptContext(input)).toEqual({
      currentPrompt: "Classify work",
      name: "Work",
      scope: "message",
      choices: [
        { id: "work", name: "Work", description: "Employment outreach" },
      ],
    });
  });
  it("takes defaults and supported efforts from server options", () => {
    expect(
      promptOptionsDefaults({
        models: [
          {
            id: "server-model",
            name: "Current model",
            efforts: ["low", "high"],
          },
        ],
        defaults: { model: "server-model", effort: "high", speed: "normal" },
      }),
    ).toEqual({ model: "server-model", effort: "high", speed: "normal" });
    expect(
      supportedEffort(
        { id: "m", name: "Model", efforts: ["low", "medium"] },
        "ultra",
      ),
    ).toBe("medium");
    expect(
      supportedEffort({ id: "m", name: "Model", efforts: ["high"] }, "medium"),
    ).toBe("high");
  });
  it("handles unavailable default models and empty catalogs", () => {
    expect(
      promptOptionsDefaults({
        models: [{ id: "fallback", name: "Fallback", efforts: ["medium"] }],
        defaults: { model: "removed", effort: "low", speed: "fast" },
      }),
    ).toEqual({ model: "fallback", effort: "medium", speed: "fast" });
    expect(() =>
      promptOptionsDefaults({
        models: [],
        defaults: { model: "none", effort: "medium", speed: "fast" },
      }),
    ).toThrow("No supported models");
  });
});
