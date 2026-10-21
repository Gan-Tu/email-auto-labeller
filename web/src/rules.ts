import type {
  GmailLabel,
  ChoiceActions,
  Rule,
  RuleChoice,
  RuleInput,
} from "./api";
export function newChoice(): RuleChoice {
  return {
    id: `choice_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: "",
    description: "",
    actions: emptyActions(),
  };
}
export function validateRule(rule: RuleInput) {
  if (!rule.name.trim()) return "Give this rule a name.";
  if (rule.prompt.trim().length < 20 || rule.prompt.length > 6000)
    return "Use between 20 and 6,000 characters for the classification prompt.";
  if (!rule.choices.length || rule.choices.length > 12)
    return "Add between 1 and 12 choices.";
  for (const choice of rule.choices) {
    if (!choice.name.trim() || !choice.description.trim())
      return "Each choice needs a name and description.";
    const actions = choiceActions(choice, rule.replyDraft);
    if (
      !actions.labels.length &&
      !actions.replyDraft &&
      !actions.markRead &&
      !actions.forward
    )
      return `Choose at least one action for ${choice.name}.`;
    if (actions.labels.some((label) => !label.labelId))
      return "Select a Gmail label for every enabled label action.";
    if (
      new Set(actions.labels.map((label) => label.labelId)).size !==
      actions.labels.length
    )
      return "Select each label only once per choice.";
    if (
      actions.replyDraft &&
      (!actions.replyDraft.body.trim() ||
        actions.replyDraft.body.trim().length > 6000)
    )
      return "Write a reply draft between 1 and 6,000 characters.";
    if (
      actions.forward &&
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actions.forward.to.trim())
    )
      return "Enter a valid forwarding email address.";
  }
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
      id: c.id,
      actions: cleanActions(choiceActions(c, rule.replyDraft)),
      name: c.name.trim(),
      description: c.description.trim(),
    })),
    protectedLabels: (rule.protectedLabels ?? []).map((label) => ({
      labelId: label.labelId,
      labelName: label.labelName,
      includeChildren: label.includeChildren,
    })),
    replyDraft: null,
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

export function emptyActions(): ChoiceActions {
  return { labels: [], replyDraft: null, markRead: false, forward: null };
}
export function choiceActions(
  choice: RuleChoice,
  draft?: RuleInput["replyDraft"],
): ChoiceActions {
  if (choice.actions) return structuredClone(choice.actions);
  return {
    labels: choice.labelId
      ? [
          {
            labelId: choice.labelId,
            labelName: choice.labelName ?? choice.labelId,
          },
        ]
      : [],
    replyDraft: draft?.choiceIds.includes(choice.id)
      ? { body: draft.body }
      : null,
    markRead: false,
    forward: null,
  };
}
export function actionSummary(
  choice: RuleChoice,
  draft?: RuleInput["replyDraft"],
) {
  const actions = choiceActions(choice, draft);
  return (
    [
      ...actions.labels.map((label) => label.labelName || label.labelId),
      actions.replyDraft ? "Create reply draft" : "",
      actions.markRead ? "Mark as read" : "",
      actions.forward ? `Forward to ${actions.forward.to}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "No actions selected"
  );
}

function cleanActions(actions: ChoiceActions): ChoiceActions {
  return {
    ...actions,
    replyDraft: actions.replyDraft
      ? { body: actions.replyDraft.body.trim() }
      : null,
    forward: actions.forward ? { to: actions.forward.to.trim() } : null,
  };
}

export function batchChoiceActions(
  rule: Rule,
  choice: RuleChoice,
  labels: GmailLabel[],
  replaceActions: boolean,
): ChoiceActions {
  const existing =
    rule.choices.find((c) => c.id === choice.id) ??
    rule.choices.find(
      (c) => c.name.trim().toLowerCase() === choice.name.trim().toLowerCase(),
    );
  if (!replaceActions && existing)
    return choiceActions(existing, rule.replyDraft);
  const actions = choiceActions(choice);
  return {
    ...actions,
    labels: actions.labels.map((label) => {
      const match = labels.find((l) => l.name === label.labelName);
      return { labelId: match?.id ?? "", labelName: match?.name ?? "" };
    }),
  };
}
