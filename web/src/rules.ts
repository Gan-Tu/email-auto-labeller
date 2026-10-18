import type { Rule, RuleChoice, RuleInput } from "./api";
export function newChoice(): RuleChoice {
  return {
    id: `choice_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: "",
    description: "",
    labelId: "",
    labelName: "",
  };
}
export function validateRule(rule: RuleInput) {
  if (!rule.name.trim()) return "Give this rule a name.";
  if (rule.prompt.trim().length < 20 || rule.prompt.length > 6000)
    return "Use between 20 and 6,000 characters for the classification prompt.";
  if (!rule.choices.length)
    return "Add at least one choice with a Gmail label.";
  if (rule.choices.length > 12) return "Use at most 12 labeled choices.";
  if (
    rule.choices.some(
      (c) => !c.name.trim() || !c.description.trim() || !c.labelId,
    )
  )
    return "Each choice needs a name, description, and Gmail label.";
  if (new Set(rule.choices.map((c) => c.labelId)).size !== rule.choices.length)
    return "Choose a different Gmail label for each choice.";
  const protectedLabels = rule.protectedLabels ?? [];
  if (protectedLabels.length > 50) return "Use at most 50 protected labels.";
  if (protectedLabels.some((label) => !label.labelId))
    return "Choose a Gmail label for every protected label row.";
  if (
    new Set(protectedLabels.map((label) => label.labelId)).size !==
    protectedLabels.length
  )
    return "Select each protected label only once.";
  if (rule.replyDraft) {
    if (!rule.replyDraft.choiceIds.length)
      return "Select at least one choice for reply drafts.";
    if (missingDraftChoiceIds(rule).length)
      return "A reply draft refers to a removed choice. Update its selected choices or turn off reply drafts.";
    if (
      new Set(rule.replyDraft.choiceIds).size !==
      rule.replyDraft.choiceIds.length
    )
      return "Select each reply draft choice only once.";
    if (
      !rule.replyDraft.body.trim() ||
      rule.replyDraft.body.trim().length > 6000
    )
      return "Write a reply draft between 1 and 6,000 characters.";
  }
  const names = rule.choices.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length || names.includes("no match"))
    return "Give each choice a different name. No match is already included.";
  if (rule.threshold < 0.5 || rule.threshold > 0.999)
    return "The match threshold must be between 50 and 99.9%.";
  return "";
}
export function cleanRule(rule: RuleInput): RuleInput {
  return {
    name: rule.name.trim(),
    prompt: rule.prompt.trim(),
    enabled: rule.enabled,
    threshold: rule.threshold,
    scope: rule.scope,
    choices: rule.choices.map((c) => ({
      ...c,
      name: c.name.trim(),
      description: c.description.trim(),
    })),
    protectedLabels: (rule.protectedLabels ?? []).map((label) => ({
      labelId: label.labelId,
      labelName: label.labelName,
      includeChildren: label.includeChildren,
    })),
    replyDraft: rule.replyDraft
      ? {
          choiceIds: [...rule.replyDraft.choiceIds],
          body: rule.replyDraft.body.trim(),
        }
      : null,
  };
}
export function missingDraftChoiceIds(
  rule: Pick<RuleInput, "replyDraft" | "choices">,
  choices = rule.choices,
) {
  const available = new Set(choices.map((choice) => choice.id));
  return (
    rule.replyDraft?.choiceIds.filter(
      (id) => id === "no_match" || !available.has(id),
    ) ?? []
  );
}
export function ruleKey(rule: Pick<Rule, "email" | "id">) {
  return `${rule.email}:${rule.id}`;
}
export function matchingLabel(rule: Rule, choice: RuleChoice) {
  const existing =
    rule.choices.find((c) => c.id === choice.id) ??
    rule.choices.find(
      (c) => c.name.trim().toLowerCase() === choice.name.trim().toLowerCase(),
    );
  return existing?.labelId ?? "";
}
export function decisionKey(decision: {
  email: string;
  messageId: string;
  ruleId?: string;
  ruleVersion?: number;
}) {
  return `${decision.email}:${decision.messageId}:${decision.ruleId ?? "legacy"}:${decision.ruleVersion ?? 0}`;
}
