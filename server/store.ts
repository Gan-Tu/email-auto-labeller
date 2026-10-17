import { Firestore, Timestamp } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { hash } from "./crypto.js";
import type {
  Account,
  Decision,
  Rule,
  MessageJob,
  RuleExecution,
} from "./types.js";
import { ACTIVITY_LIMIT, HISTORY_RETENTION_DAYS } from "./activity.js";
export const db = new Firestore({
  projectId: config.project,
  databaseId: config.database,
  ignoreUndefinedProperties: true,
});
export const accounts = db.collection("accounts");
export const accountRef = (email: string) =>
  accounts.doc(hash(email.toLowerCase()));
export const lockRef = (email: string) =>
  db.collection("locks").doc(hash(email));
export async function getAccount(email: string) {
  return (await accountRef(email).get()).data() as Account | undefined;
}
export async function listAccounts() {
  return (await accounts.get()).docs.map((d) => d.data() as Account);
}
export const decisionRef = (email: string, messageId: string) =>
  accountRef(email).collection("decisions").doc(messageId);
const retentionMillis = HISTORY_RETENTION_DAYS * 86400000;
const completedMetadata = (completedAt: number) => ({
  completedAt,
  expiresAt: Timestamp.fromMillis(completedAt + retentionMillis),
});
export async function saveDecision(decision: Decision) {
  const completedAt = decision.completedAt ?? Date.now();
  // Replaying a completed action's activity must not extend retention or recreate expired history.
  if (completedAt + retentionMillis <= Date.now()) return;
  await decisionRef(
    decision.email,
    decision.executionId ?? decision.messageId,
  ).set({
    ...decision,
    ...completedMetadata(completedAt),
  });
}
export async function recentDecisions(
  email: string,
  options: { limit?: number; completedAfter?: number } = {},
) {
  const collection = accountRef(email).collection("decisions");
  const query =
    options.completedAfter === undefined
      ? collection.orderBy("createdAt", "desc")
      : collection
          .where("completedAt", ">", options.completedAfter)
          .orderBy("completedAt", "desc");
  return (
    await query
      .limit(Math.min(options.limit ?? ACTIVITY_LIMIT, ACTIVITY_LIMIT))
      .get()
  ).docs.map((d) => d.data() as Decision);
}
export class BusyError extends Error {}
export async function withAccountLock<T>(
  email: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ref = lockRef(email);
  const token = randomUUID();
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    if (data && data.until > Date.now()) throw new BusyError("Mailbox is busy");
    tx.set(ref, { token, until: Date.now() + 600000 });
  });
  try {
    return await fn();
  } finally {
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.token === token) tx.delete(ref);
    });
  }
}

export const rulesRef = (email: string) =>
  accountRef(email).collection("rules");
export const ruleRef = (email: string, id: string) => rulesRef(email).doc(id);
export const ruleVersionRef = (email: string, id: string, version: number) =>
  accountRef(email).collection("ruleVersions").doc(`${id}_v${version}`);
export async function listRules(email: string): Promise<Rule[]> {
  return (await rulesRef(email).get()).docs
    .map((d) => d.data() as Rule)
    .filter((r) => !r.deletedAt);
}
export const jobRef = (email: string, messageId: string) =>
  accountRef(email).collection("jobs").doc(messageId);
export const executionId = (
  messageId: string,
  rule: Pick<Rule, "id" | "version">,
) => hash(`${messageId}:${rule.id}:${rule.version}`);
export const executionRef = (email: string, id: string) =>
  accountRef(email).collection("executions").doc(id);
export async function getExecution(email: string, id: string) {
  return (await executionRef(email, id).get()).data() as
    RuleExecution | undefined;
}
export async function saveExecution(execution: RuleExecution) {
  // Full replacements omit any stale TTL when work is pending or decided.
  const {
    expiresAt: _expiresAt,
    completedAt,
    ...state
  } = execution as RuleExecution & { expiresAt?: unknown };
  await executionRef(execution.email, execution.id).set({
    ...state,
    updatedAt: Date.now(),
    ...(execution.status === "complete"
      ? completedMetadata(
          completedAt ?? execution.decision?.completedAt ?? Date.now(),
        )
      : {}),
  });
}
export async function loadJobRules(job: MessageJob): Promise<Rule[]> {
  if (!job.rules.length) return [];
  const versions = await db.getAll(
    ...job.rules.map((r) => ruleVersionRef(job.email, r.id, r.version)),
  );
  return versions.map((v) => {
    if (!v.exists) throw new Error("Rule version snapshot missing");
    return v.data() as Rule;
  });
}
/** Persist every discovered message before the caller advances Gmail's cursor. Re-delivery never replaces its rule versions. */
export async function enqueueMessages(
  email: string,
  ids: string[],
  rules: Rule[],
) {
  for (let i = 0; i < ids.length; i += 100) {
    const refs = ids.slice(i, i + 100).map((id) => jobRef(email, id));
    if (!refs.length) continue;
    await db.runTransaction(async (tx) => {
      const legacyRefs = ids
        .slice(i, i + 100)
        .map((id) => decisionRef(email, id));
      const snapshots = await tx.getAll(
        ...refs,
        ...legacyRefs,
        accountRef(email),
      );
      const byPath = new Map(snapshots.map((doc) => [doc.ref.path, doc]));
      for (let j = 0; j < refs.length; j++) {
        const doc = byPath.get(refs[j].path)!;
        const legacy = byPath.get(legacyRefs[j].path)?.data() as
          Decision | undefined;
        const migratedLegacy =
          byPath.get(accountRef(email).path)?.data()?.rulesMigratedAt &&
          legacy &&
          !legacy.ruleId &&
          !legacy.executionId;
        if (!doc.exists)
          tx.create(doc.ref, {
            messageId: doc.id,
            email,
            rules: rules
              .filter(
                (r) => r.enabled && !(r.id === "recruiting" && migratedLegacy),
              )
              .map((r) => ({ id: r.id, version: r.version })),
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 0,
            nextAttemptAt: 0,
          } satisfies MessageJob);
      }
    });
  }
}
export async function pendingJobs(
  email: string,
  limit = 30,
): Promise<MessageJob[]> {
  return (
    await accountRef(email)
      .collection("jobs")
      .where("status", "==", "pending")
      .where("nextAttemptAt", "<=", Date.now())
      .orderBy("nextAttemptAt")
      .limit(limit)
      .get()
  ).docs.map((d) => d.data() as MessageJob);
}
export async function finishJob(job: MessageJob) {
  const ref = jobRef(job.email, job.messageId);
  const existing = (await ref.get()).data() as MessageJob | undefined;
  const completedAt =
    existing?.completedAt ??
    (existing?.status === "complete" ? existing.updatedAt : Date.now());
  await ref.update({
    status: "complete",
    updatedAt: Date.now(),
    lastError: null,
    ...completedMetadata(completedAt),
  });
}
export async function retryJob(job: MessageJob, error: string) {
  const attempts = job.attempts + 1;
  await jobRef(job.email, job.messageId).update({
    attempts,
    updatedAt: Date.now(),
    nextAttemptAt:
      Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)),
    lastError: error.slice(0, 180),
  });
}

export async function ruleIsActive(
  email: string,
  id: string,
): Promise<boolean> {
  const [account, rule] = await db.getAll(
    accountRef(email),
    ruleRef(email, id),
  );
  return (
    !!account.data()?.enabled &&
    !!rule.data()?.enabled &&
    !rule.data()?.deletedAt
  );
}
export async function recordRuleError(rule: Rule, message: string) {
  await db.runTransaction(async (tx) => {
    const ref = ruleRef(rule.email, rule.id),
      current = await tx.get(ref);
    if (current.data()?.version === rule.version)
      tx.update(ref, { lastError: message });
  });
}
