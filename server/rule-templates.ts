import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hash } from "./crypto.js";
import { db } from "./store.js";
import {
  choiceActionsSchema,
  choiceSchema,
  editableRuleSchema,
  RuleError,
} from "./rules.js";

const templateLabelSchema = z
  .object({
    labelId: z.string().max(200).default(""),
    labelName: choiceSchema.shape.labelName.unwrap(),
  })
  .strict();
const templateLabelsSchema = z
  .array(templateLabelSchema)
  .max(50)
  .refine(
    (labels) =>
      new Set(labels.map((label) => label.labelName)).size === labels.length,
    "Label names must be unique",
  );
// Templates may leave actions off until a rule is created in a mailbox.
const templateChoiceSchema = z
  .object({
    id: choiceSchema.shape.id,
    name: choiceSchema.shape.name,
    description: choiceSchema.shape.description,
    actions: z
      .object({
        ...choiceActionsSchema.shape,
        labels: templateLabelsSchema.default([]),
      })
      .strict(),
  })
  .strict();
export const ruleTemplateSchema = editableRuleSchema
  .omit({ draftReplies: true, preserveJobSearch: true, replyDraft: true })
  .extend({
    replyDraft: z.null().default(null),
    protectedLabels: z
      .array(
        templateLabelSchema.extend({
          includeChildren: z.boolean().default(false),
        }),
      )
      .max(50)
      .refine(
        (labels) =>
          new Set(labels.map((label) => label.labelName)).size ===
          labels.length,
        "Protected label names must be unique",
      )
      .default([]),
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
  updatedAt: number;
  version: number;
};
export const templateVersionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const updateRuleTemplateSchema = ruleTemplateSchema.extend(
  templateVersionSchema.shape,
);
export const templateIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

const userRef = (owner: string) =>
  db.collection("users").doc(hash(owner.toLowerCase()));
const templatesRef = (owner: string) =>
  userRef(owner).collection("ruleTemplates");
const keyRef = (owner: string, input: RuleTemplateInput) =>
  userRef(owner)
    .collection("ruleTemplateKeys")
    .doc(hash(JSON.stringify(input)));
const withVersion = (template: RuleTemplate): RuleTemplate => ({
  ...template,
  version: template.version ?? 1,
  updatedAt: template.updatedAt ?? template.createdAt,
});
function templateInput(template: RuleTemplate): RuleTemplateInput {
  const { id, createdAt, updatedAt, version, ...input } = template;
  return ruleTemplateSchema.parse(input);
}

export async function listRuleTemplates(
  owner: string,
): Promise<RuleTemplate[]> {
  return (
    await templatesRef(owner).orderBy("createdAt", "desc").get()
  ).docs.map((doc) => withVersion(doc.data() as RuleTemplate));
}

export async function saveRuleTemplate(
  owner: string,
  input: RuleTemplateInput,
) {
  // Keep IDs stable when editing, with a separate key for retried creates.
  const id = randomUUID();
  const ref = templatesRef(owner).doc(id);
  const key = keyRef(owner, input);
  return db.runTransaction(async (tx) => {
    const savedId = (await tx.get(key)).data()?.templateId;
    if (savedId) {
      const existing = await tx.get(templatesRef(owner).doc(savedId));
      if (existing.exists) return withVersion(existing.data() as RuleTemplate);
    }
    // Earlier templates used the content hash as their ID. Reuse one only
    // while its current contents still match; editing keeps its original ID.
    const legacy = await tx.get(templatesRef(owner).doc(key.id));
    if (legacy.exists) {
      const template = withVersion(legacy.data() as RuleTemplate);
      if (JSON.stringify(templateInput(template)) === JSON.stringify(input)) {
        tx.set(key, { templateId: template.id });
        return template;
      }
    }
    const now = Date.now();
    const template: RuleTemplate = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    tx.create(ref, template);
    tx.set(key, { templateId: id });
    return template;
  });
}

export async function updateRuleTemplate(
  owner: string,
  id: string,
  input: RuleTemplateInput,
  expectedVersion: number,
) {
  const ref = templatesRef(owner).doc(id);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new RuleError("Template not found", 404);
    const before = withVersion(snapshot.data() as RuleTemplate);
    if (before.version !== expectedVersion)
      throw new RuleError(
        "This template changed. Reopen it to load the latest version before saving.",
        409,
      );
    const previousKey = keyRef(owner, templateInput(before));
    const nextKey = keyRef(owner, input);
    const previousKeyData = (await tx.get(previousKey)).data();
    const template: RuleTemplate = {
      ...input,
      id,
      createdAt: before.createdAt,
      updatedAt: Date.now(),
      version: before.version + 1,
    };
    if (previousKey.path !== nextKey.path && previousKeyData?.templateId === id)
      tx.delete(previousKey);
    tx.set(ref, template);
    tx.set(nextKey, { templateId: id });
    return template;
  });
}

export async function deleteRuleTemplate(
  owner: string,
  id: string,
  expectedVersion: number,
) {
  const ref = templatesRef(owner).doc(id);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new RuleError("Template not found", 404);
    const template = withVersion(snapshot.data() as RuleTemplate);
    if (template.version !== expectedVersion)
      throw new RuleError(
        "This template changed. Refresh the list before deleting it.",
        409,
      );
    const key = keyRef(owner, templateInput(template));
    const savedId = (await tx.get(key)).data()?.templateId;
    if (savedId === id) tx.delete(key);
    tx.delete(ref);
  });
}
