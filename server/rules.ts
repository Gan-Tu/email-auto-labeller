import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountRef,
  db,
  ruleRef,
  rulesRef,
  ruleVersionRef,
  lockRef,
} from "./store.js";
import { Gmail } from "./gmail.js";
import { RECRUITING_PROMPT } from "./classifier.js";
import type { Account, Label, Rule } from "./types.js";
export class RuleError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const mayAccess = (actor: string, account: Account) =>
  account.email === actor || account.owner === actor;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s),
      "Invalid control character",
    );
export const choiceSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .refine((id) => id !== "no_match", "No match is automatic"),
    name: text(100),
    description: text(1000),
    labelId: text(200),
    labelName: text(200),
  })
  .strict();
export const choicesSchema = z
  .array(choiceSchema)
  .min(1)
  .max(12)
  .refine(
    (c) => new Set(c.map((x) => x.id)).size === c.length,
    "Choice IDs must be unique",
  )
  .refine(
    (c) => new Set(c.map((x) => x.labelId)).size === c.length,
    "Each choice needs a different label",
  );
const ruleFieldsSchema = z
  .object({
    name: text(100),
    prompt: z.string().trim().min(20).max(6000),
    choices: choicesSchema,
    enabled: z.boolean(),
    threshold: z.number().min(0.5).max(0.999),
    scope: z.enum(["message", "thread"]),
    draftReplies: z.boolean(),
    preserveJobSearch: z.boolean(),
  })
  .strict();
export const editableRuleSchema = ruleFieldsSchema.extend({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0.5).max(0.999).default(0.8),
  scope: z.enum(["message", "thread"]).default("message"),
  draftReplies: z.boolean().default(false),
  preserveJobSearch: z.boolean().default(false),
});
export const patchRuleSchema = ruleFieldsSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
export const batchRuleSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            email: z.email(),
            ruleId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            expectedVersion: z.number().int().positive(),
            choices: choicesSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (targets) =>
          new Set(targets.map((t) => `${t.email}/${t.ruleId}`)).size ===
          targets.length,
        "Select each rule once",
      ),
    changes: ruleFieldsSchema.omit({ choices: true }).partial().strict(),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v.changes).length > 0 || v.targets.some((t) => t.choices),
    "Choose a change",
  );
export function validateRule(rule: Rule, labels: Label[]): Rule {
  const parsed = editableRuleSchema.parse({
    name: rule.name,
    prompt: rule.prompt,
    choices: rule.choices,
    enabled: rule.enabled,
    threshold: rule.threshold,
    scope: rule.scope,
    draftReplies: rule.draftReplies,
    preserveJobSearch: rule.preserveJobSearch,
  });
  if (
    parsed.draftReplies &&
    (parsed.choices.length !== 1 || parsed.choices[0].id !== "recruiting")
  )
    throw new RuleError("Decline drafts require the single Recruiting choice");
  return {
    ...rule,
    ...parsed,
    choices: parsed.choices.map((choice) => {
      const label = labels.find(
        (l) => l.id === choice.labelId && l.type !== "system",
      );
      if (!label)
        throw new RuleError(
          `The label for ${choice.name} is unavailable in this mailbox`,
        );
      return { ...choice, labelName: label.name };
    }),
  };
}
export function buildRecruitingRule(account: Account, label: Label): Rule {
  const now = Date.now();
  return {
    id: "recruiting",
    email: account.email,
    name: "Recruiting",
    prompt: account.classificationPrompt?.trim() || RECRUITING_PROMPT,
    enabled: account.enabled,
    threshold: account.threshold,
    scope: "thread",
    draftReplies: account.draftReplies,
    preserveJobSearch:
      account.label.toLowerCase().replace(/[^a-z0-9]/g, "") === "jobsearch",
    choices: [
      {
        id: "recruiting",
        name: "Recruiting",
        description:
          "Genuine, personally directed outreach or follow-up about recruiting the mailbox owner for an employment opportunity.",
        labelId: label.id,
        labelName: label.name,
      },
    ],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
export async function createRule(
  actor: string,
  email: string,
  input: z.infer<typeof editableRuleSchema>,
) {
  const account = (await accountRef(email).get()).data() as Account | undefined;
  if (!account || !mayAccess(actor, account))
    throw new RuleError("Mailbox not found", 404);
  const id = randomUUID(),
    now = Date.now();
  const rule = validateRule(
    { ...input, id, email, version: 1, createdAt: now, updatedAt: now },
    await new Gmail(account).labels(),
  );
  await db.runTransaction(async (tx) => {
    const [a, existing, lease] = await Promise.all([
      tx.get(accountRef(email)),
      tx.get(rulesRef(email)),
      tx.get(lockRef(email)),
    ]);
    const fresh = a.data() as Account | undefined;
    if (!fresh || !mayAccess(actor, fresh))
      throw new RuleError("Mailbox not found", 404);
    if ((lease.data()?.until ?? 0) > Date.now())
      throw new RuleError(
        "Mailbox is processing a message. Try creating the rule again shortly.",
        409,
      );
    if (existing.docs.filter((d) => !d.data().deletedAt).length >= 20)
      throw new RuleError("A mailbox supports up to 20 rules");
    tx.create(ruleRef(email, id), rule);
    tx.create(ruleVersionRef(email, id, 1), rule);
    tx.update(accountRef(email), {
      rulesRevision: (fresh.rulesRevision ?? 0) + 1,
    });
  });
  return rule;
}
export async function updateRules(
  actor: string,
  batch: z.infer<typeof batchRuleSchema>,
): Promise<Rule[]> {
  const emails = [...new Set(batch.targets.map((t) => t.email))];
  const accounts = await db.getAll(...emails.map(accountRef));
  const accountMap = new Map(
    accounts.map((a) => {
      const value = a.data() as Account | undefined;
      if (!value || !mayAccess(actor, value))
        throw new RuleError(
          "A selected mailbox is unavailable. No rules were changed.",
          404,
        );
      return [value.email, value];
    }),
  );
  const labelMap = new Map(
    await Promise.all(
      emails.map(
        async (email) =>
          [email, await new Gmail(accountMap.get(email)!).labels()] as const,
      ),
    ),
  );
  return db.runTransaction(async (tx) => {
    const refs = batch.targets.map((t) => ruleRef(t.email, t.ruleId));
    const docs = await tx.getAll(
      ...refs,
      ...emails.map(accountRef),
      ...emails.map(lockRef),
    );
    const byPath = new Map(docs.map((d) => [d.ref.path, d]));
    for (const email of emails) {
      const a = byPath.get(accountRef(email).path)?.data() as
        Account | undefined;
      if (!a || !mayAccess(actor, a))
        throw new RuleError(
          "A selected mailbox is unavailable. No rules were changed.",
          404,
        );
    }
    for (const email of emails)
      if ((byPath.get(lockRef(email).path)?.data()?.until ?? 0) > Date.now())
        throw new RuleError(
          "A selected mailbox is processing a message. No rules were changed; try again shortly.",
          409,
        );
    const updated = batch.targets.map((target) => {
      const before = byPath
        .get(ruleRef(target.email, target.ruleId).path)
        ?.data() as Rule | undefined;
      if (!before || before.deletedAt || before.email !== target.email)
        throw new RuleError(
          "A selected rule is unavailable. No rules were changed.",
          404,
        );
      if (before.version !== target.expectedVersion)
        throw new RuleError(
          "A selected rule changed. Refresh and try again; no rules were changed.",
          409,
        );
      return validateRule(
        {
          ...before,
          ...batch.changes,
          ...(target.choices ? { choices: target.choices } : {}),
          version: before.version + 1,
          updatedAt: Date.now(),
          lastError: null,
        },
        labelMap.get(target.email)!,
      );
    });
    for (const rule of updated) {
      tx.set(ruleRef(rule.email, rule.id), rule);
      tx.create(ruleVersionRef(rule.email, rule.id, rule.version), rule);
    }
    for (const email of emails) {
      const a = byPath.get(accountRef(email).path)!.data() as Account;
      tx.update(accountRef(email), {
        rulesRevision: (a.rulesRevision ?? 0) + 1,
      });
    }
    return updated;
  });
}
export async function deleteRule(
  actor: string,
  email: string,
  id: string,
  expectedVersion: number,
) {
  await db.runTransaction(async (tx) => {
    const [a, r, lock] = await tx.getAll(
      accountRef(email),
      ruleRef(email, id),
      lockRef(email),
    );
    const account = a.data() as Account | undefined,
      rule = r.data() as Rule | undefined;
    if (!account || !mayAccess(actor, account) || !rule || rule.deletedAt)
      throw new RuleError("Rule not found", 404);
    if ((lock.data()?.until ?? 0) > Date.now())
      throw new RuleError(
        "Mailbox is processing a message. Try deleting the rule again shortly.",
        409,
      );
    if (rule.version !== expectedVersion)
      throw new RuleError("Rule changed; refresh and try again", 409);
    tx.update(r.ref, {
      deletedAt: Date.now(),
      enabled: false,
      updatedAt: Date.now(),
    });
    tx.update(a.ref, { rulesRevision: (account.rulesRevision ?? 0) + 1 });
  });
}
