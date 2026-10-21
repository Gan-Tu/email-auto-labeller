import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountRef,
  db,
  ruleRef,
  rulesRef,
  ruleVersionRef,
  lockRef,
  listRules,
} from "./store.js";
import { Gmail } from "./gmail.js";
import { config } from "./config.js";
import {
  needsLegacyBehavior,
  normalizeRuleBehavior,
  RuleBehaviorError,
} from "./rule-behavior.js";
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
const actionLabelSchema = z
  .object({ labelId: text(200), labelName: text(200) })
  .strict();
export const choiceActionsSchema = z
  .object({
    labels: z
      .array(actionLabelSchema)
      .max(50)
      .refine(
        (labels) =>
          new Set(labels.map((label) => label.labelId)).size === labels.length,
        "Action labels must be unique",
      )
      .default([]),
    replyDraft: z
      .object({ body: text(6000) })
      .strict()
      .nullable()
      .default(null),
    markRead: z.boolean().default(false),
    forward: z
      .object({ to: z.email().max(254) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .refine(
    (actions) =>
      actions.labels.length > 0 ||
      !!actions.replyDraft ||
      actions.markRead ||
      !!actions.forward,
    "Choose at least one action for each choice",
  );
export const choiceSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .refine((id) => id !== "no_match", "No match is automatic"),
    name: text(100),
    description: text(1000),
    actions: choiceActionsSchema.optional(),
    labelId: text(200).optional(),
    labelName: text(200).optional(),
  })
  .strict()
  .refine(
    (choice) =>
      choice.actions !== undefined || (!!choice.labelId && !!choice.labelName),
    "Choose at least one action for each choice",
  );
export const choicesSchema = z
  .array(choiceSchema)
  .min(1)
  .max(12)
  .refine(
    (choices) =>
      new Set(choices.map((choice) => choice.id)).size === choices.length,
    "Choice IDs must be unique",
  );
export const protectedLabelsSchema = z
  .array(
    z
      .object({
        labelId: text(200),
        labelName: text(200),
        includeChildren: z.boolean().default(false),
      })
      .strict(),
  )
  .max(50)
  .refine(
    (labels) =>
      new Set(labels.map((label) => label.labelId)).size === labels.length,
    "Protected labels must be unique",
  );
export const replyDraftSchema = z
  .object({
    choiceIds: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine(
            (id) => id !== "no_match",
            "No match cannot create a reply draft",
          ),
      )
      .min(1)
      .max(12)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Draft choice IDs must be unique",
      ),
    body: text(6000),
  })
  .strict();
const ruleFieldsSchema = z
  .object({
    name: text(100),
    prompt: z.string().trim().min(20).max(6000),
    choices: choicesSchema,
    enabled: z.boolean(),
    threshold: z.number().min(0.5).max(0.999),
    scope: z.enum(["message", "thread"]),
    protectedLabels: protectedLabelsSchema.optional(),
    replyDraft: replyDraftSchema.nullable().optional(),
    draftReplies: z.boolean().optional(),
    preserveJobSearch: z.boolean().optional(),
  })
  .strict();
export const editableRuleSchema = ruleFieldsSchema.extend({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0.5).max(0.999).default(0.8),
  scope: z.enum(["message", "thread"]).default("message"),
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
            protectedLabels: protectedLabelsSchema.optional(),
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
    changes: ruleFieldsSchema
      .omit({ choices: true, protectedLabels: true })
      .partial()
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v.changes).length > 0 ||
      v.targets.some(
        (t) => t.choices !== undefined || t.protectedLabels !== undefined,
      ),
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
    protectedLabels: rule.protectedLabels,
    replyDraft: rule.replyDraft,
    draftReplies: rule.draftReplies,
    preserveJobSearch: rule.preserveJobSearch,
  });
  let canonical;
  try {
    canonical = normalizeRuleBehavior(
      { ...rule, ...parsed },
      labels,
      config.declineReplyText,
    );
  } catch (error) {
    if (error instanceof RuleBehaviorError) throw new RuleError(error.message);
    throw error;
  }
  if (
    canonical.replyDraft &&
    parsed.choices.some((choice) => choice.actions === undefined)
  ) {
    const allowed = new Set(parsed.choices.map((choice) => choice.id));
    if (canonical.replyDraft.choiceIds.some((id) => !allowed.has(id)))
      throw new RuleError("Reply draft choices must exist in this rule");
  }
  return {
    ...canonical,
    choices: canonical.choices.map((choice) => {
      const actions = choice.actions!;
      const mappedLabels = actions.labels.map((mapping) => {
        const label = labels.find(
          (label) => label.id === mapping.labelId && label.type !== "system",
        );
        if (!label)
          throw new RuleError(
            `The label for ${choice.name} is unavailable in this mailbox`,
          );
        return { labelId: label.id, labelName: label.name };
      });
      return {
        ...choice,
        ...(choice.labelId &&
        mappedLabels.some((label) => label.labelId === choice.labelId)
          ? {
              labelName: mappedLabels.find(
                (label) => label.labelId === choice.labelId,
              )!.labelName,
            }
          : {}),
        actions: { ...actions, labels: mappedLabels },
      };
    }),
    protectedLabels: canonical.protectedLabels.map((protection) => {
      const label = labels.find(
        (label) => label.id === protection.labelId && label.type !== "system",
      );
      if (!label)
        throw new RuleError(
          `The protected label ${protection.labelName} is unavailable in this mailbox`,
        );
      return { ...protection, labelName: label.name };
    }),
  };
}
export async function listRulesForAccount(account: Account): Promise<Rule[]> {
  const rules = await listRules(account.email);
  let labels: Label[] = [];
  if (rules.some(needsLegacyBehavior)) {
    try {
      labels = await new Gmail(account).labels();
    } catch {
      throw new RuleError(
        "Mailbox labels are temporarily unavailable. Existing rule protections have not been changed; reconnect Gmail or retry.",
        503,
      );
    }
  }
  return rules.map((rule) =>
    normalizeRuleBehavior(rule, labels, config.declineReplyText),
  );
}
export function buildRecruitingRule(
  account: Account,
  label: Label,
  legacyBody = config.declineReplyText,
  labels: Label[] = [label],
): Rule {
  const now = Date.now();
  return normalizeRuleBehavior(
    {
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
    },
    labels,
    legacyBody,
  );
}
/** Translate explicit legacy UI toggles once, without allowing stale flags to revive generic disables. */
function overlayRuleChanges(
  before: Rule,
  changes: z.infer<typeof batchRuleSchema>["changes"],
  target: z.infer<typeof batchRuleSchema>["targets"][number],
  labels: Label[],
): Rule {
  const normalized = normalizeRuleBehavior(
    before,
    labels,
    config.declineReplyText,
  );
  const next: Rule = {
    ...normalized,
    ...changes,
    ...(target.choices !== undefined
      ? {
          choices: target.choices.map((choice) => {
            if (choice.actions !== undefined) return choice;
            const previous = normalized.choices.find(
              (old) => old.id === choice.id,
            );
            if (!previous?.actions) return choice;
            const labels =
              choice.labelId && choice.labelName
                ? [
                    { labelId: choice.labelId, labelName: choice.labelName },
                    ...previous.actions.labels
                      .slice(1)
                      .filter((label) => label.labelId !== choice.labelId),
                  ]
                : previous.actions.labels;
            return { ...choice, actions: { ...previous.actions, labels } };
          }),
        }
      : {}),
    ...(target.protectedLabels !== undefined
      ? { protectedLabels: target.protectedLabels }
      : {}),
  };
  if (
    changes.replyDraft === undefined &&
    changes.draftReplies !== undefined &&
    !target.choices?.every((choice) => choice.actions !== undefined)
  ) {
    next.replyDraft = changes.draftReplies
      ? normalizeRuleBehavior(
          {
            ...next,
            replyDraft: undefined,
            draftReplies: true,
            choices: next.choices.map(
              ({ actions: _actions, ...choice }) => choice,
            ),
          },
          labels,
          config.declineReplyText,
        ).replyDraft
      : null;
  }
  if (
    target.protectedLabels === undefined &&
    changes.preserveJobSearch !== undefined
  ) {
    next.protectedLabels = changes.preserveJobSearch
      ? normalizeRuleBehavior(
          { ...next, protectedLabels: undefined, preserveJobSearch: true },
          labels,
          config.declineReplyText,
        ).protectedLabels
      : [];
  }
  if (
    changes.replyDraft &&
    changes.replyDraft.choiceIds.some(
      (id) => !next.choices.some((choice) => choice.id === id),
    )
  )
    throw new RuleError("Reply draft choices must exist in this rule");
  if (changes.replyDraft !== undefined || changes.draftReplies !== undefined) {
    next.choices = next.choices.map((choice) => {
      if (
        target.choices?.find((supplied) => supplied.id === choice.id)
          ?.actions !== undefined
      )
        return choice;
      if (!choice.actions) return choice;
      return {
        ...choice,
        actions: {
          ...choice.actions,
          replyDraft: next.replyDraft?.choiceIds.includes(choice.id)
            ? { body: next.replyDraft.body }
            : null,
        },
      };
    });
  }
  return next;
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
          ...overlayRuleChanges(
            before,
            batch.changes,
            target,
            labelMap.get(target.email)!,
          ),
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
