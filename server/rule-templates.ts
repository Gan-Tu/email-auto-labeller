import { z } from "zod";
import { hash } from "./crypto.js";
import { db } from "./store.js";
import {
  choiceActionsSchema,
  choiceSchema,
  editableRuleSchema,
} from "./rules.js";

// Templates may leave actions off until a rule is created in a mailbox.
const templateChoiceSchema = z
  .object({
    id: choiceSchema.shape.id,
    name: choiceSchema.shape.name,
    description: choiceSchema.shape.description,
    actions: z.object(choiceActionsSchema.shape).strict(),
  })
  .strict();
export const ruleTemplateSchema = editableRuleSchema
  .omit({ draftReplies: true, preserveJobSearch: true, replyDraft: true })
  .extend({
    replyDraft: z.null().default(null),
    choices: z
      .array(templateChoiceSchema)
      .min(1)
      .max(12)
      .refine(
        (choices) => new Set(choices.map((c) => c.id)).size === choices.length,
        "Choice IDs must be unique",
      )
      .refine((choices) => {
        const names = choices.map((c) => c.name.toLowerCase());
        return (
          new Set(names).size === names.length && !names.includes("no match")
        );
      }, "Give each choice a different name. No match is already included."),
  });
type RuleTemplateInput = z.infer<typeof ruleTemplateSchema>;
export type RuleTemplate = RuleTemplateInput & {
  id: string;
  createdAt: number;
};

const templatesRef = (owner: string) =>
  db
    .collection("users")
    .doc(hash(owner.toLowerCase()))
    .collection("ruleTemplates");

export async function listRuleTemplates(
  owner: string,
): Promise<RuleTemplate[]> {
  return (
    await templatesRef(owner).orderBy("createdAt", "desc").get()
  ).docs.map((doc) => doc.data() as RuleTemplate);
}

export async function saveRuleTemplate(
  owner: string,
  input: RuleTemplateInput,
) {
  // Retrying an unchanged save reuses the template instead of adding duplicates.
  const id = hash(JSON.stringify(input));
  const ref = templatesRef(owner).doc(id);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return existing.data() as RuleTemplate;
    const template: RuleTemplate = { ...input, id, createdAt: Date.now() };
    tx.create(ref, template);
    return template;
  });
}
