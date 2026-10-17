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
  if (
    rule.draftReplies &&
    (rule.choices.length !== 1 || rule.choices[0].id !== "recruiting")
  )
    return "Decline drafts require the single Recruiting choice. Turn off drafts before changing choices.";
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
    ...(rule.draftReplies === undefined
      ? {}
      : { draftReplies: rule.draftReplies }),
    ...(rule.preserveJobSearch === undefined
      ? {}
      : { preserveJobSearch: rule.preserveJobSearch }),
  };
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
