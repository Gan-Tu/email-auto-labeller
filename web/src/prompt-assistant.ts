import type { RuleChoice } from "./api";

export interface PromptModel {
  id: string;
  name: string;
  efforts: string[];
}
export interface PromptOptions {
  models: PromptModel[];
  defaults: { model: string; effort: string; speed: "normal" | "fast" };
}
export interface PromptContext {
  currentPrompt: string;
  name: string;
  scope: "message" | "thread";
  choices: Pick<RuleChoice, "id" | "name" | "description">[];
}
export function promptContext(context: PromptContext): PromptContext {
  return {
    currentPrompt: context.currentPrompt,
    name: context.name,
    scope: context.scope,
    choices: context.choices.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  };
}
export function supportedEffort(model: PromptModel, preferred: string) {
  return model.efforts.includes(preferred)
    ? preferred
    : model.efforts.includes("medium")
      ? "medium"
      : (model.efforts[0] ?? "");
}
export function promptOptionsDefaults(options: PromptOptions) {
  const model =
    options.models.find((model) => model.id === options.defaults.model) ??
    options.models[0];
  if (!model || !model.efforts.length)
    throw new Error("No supported models are available. Please try again.");
  return {
    model: model.id,
    effort: supportedEffort(model, options.defaults.effort),
    speed: options.defaults.speed,
  };
}
