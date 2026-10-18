import type { Label, ProtectedLabel, ReplyDraft, Rule } from "./types.js";

export type NormalizedRule = Omit<
  Rule,
  "protectedLabels" | "replyDraft" | "draftReplies" | "preserveJobSearch"
> & {
  protectedLabels: ProtectedLabel[];
  replyDraft: ReplyDraft | null;
};
export class RuleBehaviorError extends Error {}
const legacyLabelName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Only old enabled behaviors need live migration input. Explicit []/null always wins. */
export const needsLegacyBehavior = (rule: Rule) =>
  (rule.protectedLabels === undefined && rule.preserveJobSearch === true) ||
  (rule.replyDraft === undefined && rule.draftReplies === true);

/** Pure conversion: never rewrites the supplied rule or any historical version. */
export function normalizeRuleBehavior(
  rule: Rule,
  labels: Label[],
  legacyBody: string,
): NormalizedRule {
  const { draftReplies, preserveJobSearch, ...canonical } = rule;
  const protectedLabels =
    rule.protectedLabels !== undefined
      ? rule.protectedLabels.map((protection) => ({
          ...protection,
          labelName:
            labels.find(
              (label) =>
                label.id === protection.labelId && label.type !== "system",
            )?.name ?? protection.labelName,
        }))
      : preserveJobSearch
        ? labels
            .filter(
              (label) =>
                label.type !== "system" &&
                legacyLabelName(label.name).startsWith("jobsearch"),
            )
            .map((label) => ({
              labelId: label.id,
              labelName: label.name,
              includeChildren: true,
            }))
        : [];
  let replyDraft: ReplyDraft | null;
  if (rule.replyDraft !== undefined)
    replyDraft = rule.replyDraft
      ? { ...rule.replyDraft, choiceIds: [...rule.replyDraft.choiceIds] }
      : null;
  else if (draftReplies) {
    if (rule.choices.length !== 1 || rule.choices[0].id !== "recruiting")
      throw new RuleBehaviorError(
        "Legacy recruiting drafts require exactly the Recruiting choice; configure an explicit reply draft to change this behavior",
      );
    const body = legacyBody.trim();
    if (!body || body.length > 6000)
      throw new RuleBehaviorError(
        "The legacy reply draft body must contain between 1 and 6,000 characters",
      );
    replyDraft = { choiceIds: ["recruiting"], body };
  } else replyDraft = null;
  return { ...canonical, protectedLabels, replyDraft };
}
