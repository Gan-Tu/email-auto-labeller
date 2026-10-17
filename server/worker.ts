import { Gmail, GmailError, GmailContentError, header } from "./gmail.js";
import { classifyRules, NO_MATCH } from "./classifier.js";
import { config } from "./config.js";
import {
  accountRef,
  getAccount,
  saveDecision,
  withAccountLock,
  listRules,
  enqueueMessages,
  pendingJobs,
  finishJob,
  retryJob,
  loadJobRules,
  executionId,
  getExecution,
  saveExecution,
  ruleIsActive,
  recordRuleError,
} from "./store.js";
import type {
  Decision,
  Label,
  Message,
  Thread,
  Rule,
  MessageJob,
  RuleExecution,
} from "./types.js";
export const normalizeLabel = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");
const excludedMailLabels: Record<string, string> = {
  SENT: "Sent mail",
  DRAFT: "Draft",
  SPAM: "Spam",
  TRASH: "Trash",
};
export const excludedLabels = (m: Message) =>
  Object.keys(excludedMailLabels).filter((label) =>
    m.labelIds?.includes(label),
  );
export const isIncoming = (m: Message) => excludedLabels(m).length === 0;
export const latestMessage = (messages: Message[]) => {
  const sorted = [...messages].sort(
    (a, b) => Number(b.internalDate) - Number(a.internalDate),
  );
  if (
    !sorted.length ||
    !Number.isFinite(Number(sorted[0].internalDate)) ||
    (sorted[1] && sorted[0].internalDate === sorted[1].internalDate)
  )
    return undefined;
  return sorted[0];
};
const address = (s: string) =>
  (s.match(/<([^<>]+)>/)?.[1] ?? s).trim().toLowerCase();

async function createDecline(
  gmail: Gmail,
  thread: Thread,
  enabled: boolean,
  classifiedMessageIds: string[],
): Promise<Decision["draft"]> {
  if (!enabled) return "skipped";
  if (
    thread.messages.some(
      (m) =>
        m.labelIds?.some((id) => id === "SENT" || id === "DRAFT") ||
        address(header(m, "from")) === gmail.account.email ||
        /linkedin\.com/i.test(header(m, "from")) ||
        /linkedin (inmail|message)/i.test(header(m, "subject")),
    )
  )
    return "skipped";
  const latest = latestMessage(thread.messages);
  if (!latest || !classifiedMessageIds.includes(latest.id)) return "skipped";
  const messageId = header(latest, "message-id");
  const to = header(latest, "reply-to") || header(latest, "from");
  if (!messageId || /[\r\n]/.test(messageId + to) || !address(to).includes("@"))
    return "skipped";
  let pageToken: string | undefined;
  do {
    const page = await gmail.request<{
      drafts?: { message?: { threadId?: string } }[];
      nextPageToken?: string;
    }>(
      `drafts?maxResults=500${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`,
    );
    if (page.drafts?.some((d) => d.message?.threadId === thread.id))
      return "skipped";
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Reserve once before the external write. An ambiguous network response must never produce a duplicate draft.
  const intent = accountRef(gmail.account.email)
    .collection("draftIntents")
    .doc(thread.id);
  try {
    await intent.create({
      messageId: latest.id,
      status: "pending",
      createdAt: Date.now(),
    });
  } catch (error: any) {
    if (error.code === 6) return "skipped";
    throw error;
  }
  const subject = header(latest, "subject").replace(/[\r\n]/g, " ");
  const references = header(latest, "references").replace(/[\r\n]/g, " ");
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(/^re:/i.test(subject) ? subject : "Re: " + subject).toString("base64")}?=`,
    `In-Reply-To: ${messageId}`,
    `References: ${references} ${messageId}`.trim(),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(config.declineReplyText).toString("base64"),
  ].join("\r\n");
  try {
    const draft = await gmail.request<{ id: string }>("drafts", "POST", {
      message: {
        threadId: thread.id,
        raw: Buffer.from(raw).toString("base64url"),
      },
    });
    await intent.set({ status: "created", draftId: draft.id }, { merge: true });
    return "created";
  } catch {
    await intent.set({ status: "unknown" }, { merge: true });
    return "unknown";
  }
}

function decisionFor(execution: RuleExecution): Decision {
  return {
    executionId: execution.id,
    email: execution.email,
    messageId: execution.messageId,
    threadId: execution.threadId,
    subject: execution.subject,
    ruleId: execution.rule.id,
    ruleName: execution.rule.name,
    ruleVersion: execution.rule.version,
    createdAt: execution.createdAt,
    outcome: "skipped",
  };
}
const reasonFor = (error: unknown) =>
  error instanceof GmailError && error.status === 401
    ? "Reconnect Gmail to restore access"
    : error instanceof Error
      ? error.message.slice(0, 180)
      : "Processing failed";
async function completeExecution(execution: RuleExecution, decision: Decision) {
  // The execution is authoritative; activity may safely be retried after an interrupted save.
  const completedAt =
    execution.completedAt ?? decision.completedAt ?? Date.now();
  const completedDecision = { ...decision, completedAt };
  const completed = {
    ...execution,
    decision: completedDecision,
    completedAt,
    status: "complete" as const,
    lastError: null,
  };
  await saveExecution(completed);
  Object.assign(execution, completed);
  await saveDecision(completedDecision);
}
async function failExecution(execution: RuleExecution, error: unknown) {
  execution.lastError = reasonFor(error);
  execution.attempts++;
  await saveExecution(execution);
  await saveDecision({
    ...decisionFor(execution),
    outcome: "failed",
    reason: execution.lastError,
  });
}
export function ruleProtectsThread(
  rule: Rule,
  thread: Thread,
  labels: Label[],
) {
  if (!rule.preserveJobSearch) return false;
  const protectedIds = new Set(
    labels
      .filter((l) => normalizeLabel(l.name).startsWith("jobsearch"))
      .map((l) => l.id),
  );
  return thread.messages.some((m) =>
    m.labelIds?.some((id) => protectedIds.has(id)),
  );
}
async function applyPrediction(
  gmail: Gmail,
  execution: RuleExecution,
  labels: Label[],
  deadline: number,
) {
  if (Date.now() >= deadline - 1000)
    throw new Error("Processing deadline reached");
  const prediction = execution.prediction!;
  const decision = {
    ...decisionFor(execution),
    ...(prediction.probability === null
      ? {}
      : { probability: prediction.probability }),
    ...(prediction.confidence === null
      ? {}
      : { confidence: prediction.confidence }),
    ...(prediction.choiceId
      ? { choiceId: prediction.choiceId, choiceName: prediction.choiceName! }
      : {}),
  };
  if (!(await ruleIsActive(execution.email, execution.rule.id))) {
    decision.reason = "Rule paused or deleted";
    await completeExecution(execution, decision);
    return;
  }
  if (prediction.refused) {
    decision.reason = "Model declined classification";
    await completeExecution(execution, decision);
    return;
  }
  if (prediction.choiceId === NO_MATCH) {
    decision.outcome = "no_match";
    await completeExecution(execution, decision);
    return;
  }
  if (
    prediction.probability === null ||
    prediction.probability < execution.rule.threshold
  ) {
    decision.outcome = "uncertain";
    decision.reason = "Selected choice is below the rule threshold";
    await completeExecution(execution, decision);
    return;
  }
  const choice = execution.rule.choices.find(
    (c) => c.id === prediction.choiceId,
  );
  if (!choice)
    throw new Error("Selected choice is no longer in the rule snapshot");
  const target = labels.find(
    (l) => l.id === choice.labelId && l.type !== "system",
  );
  if (!target) {
    decision.outcome = "failed";
    decision.reason = `Label unavailable: ${choice.labelName}. Update the rule mapping for future messages.`;
    await recordRuleError(execution.rule, decision.reason);
    await completeExecution(execution, decision);
    return;
  }
  // Recheck current user labels and exclusions before each external action. Never remove labels.
  const current = await gmail.thread(execution.threadId);
  if (ruleProtectsThread(execution.rule, current, labels)) {
    decision.reason = "Protected Job Search label";
    await completeExecution(execution, decision);
    return;
  }
  const intendedIds = new Set(execution.targetMessageIds ?? []);
  const eligible = current.messages.filter(
    (m) => intendedIds.has(m.id) && isIncoming(m),
  );
  if (!eligible.length) {
    decision.reason = "No incoming messages remain";
    await completeExecution(execution, decision);
    return;
  }
  const missing = eligible
    .filter((m) => !m.labelIds?.includes(target.id))
    .map((m) => m.id);
  if (!missing.length && !execution.labelActionStarted) {
    decision.reason = "Already labeled";
    await completeExecution(execution, decision);
    return;
  }
  if (missing.length) {
    const reserved = { ...execution, labelActionStarted: true };
    await saveExecution(reserved);
    Object.assign(execution, reserved);
    await gmail.label(missing, target.id);
  }
  decision.outcome = "labeled";
  decision.label = target.name;
  decision.labelId = target.id;
  // Draft intent reservations make any retry after an ambiguous draft write safe.
  decision.draft = await createDecline(
    gmail,
    current,
    execution.rule.draftReplies,
    execution.targetMessageIds ?? [],
  );
  await completeExecution(execution, decision);
}
export async function processJob(
  gmail: Gmail,
  job: MessageJob,
  deadline = Date.now() + 180000,
): Promise<void> {
  gmail.deadline = deadline;
  if (Date.now() >= deadline - 1000)
    throw new Error("Processing deadline reached");
  const rules = await loadJobRules(job);
  if (!rules.length) {
    await finishJob(job);
    return;
  }
  let message: Message | undefined, thread: Thread | undefined;
  try {
    message = await gmail.request<Message>(
      `messages/${encodeURIComponent(job.messageId)}?format=metadata`,
    );
    thread = await gmail.thread(message.threadId);
  } catch (error) {
    if (!(error instanceof GmailError && error.status === 404)) throw error;
  }
  const executions = await Promise.all(
    rules.map(async (rule) => {
      const id = executionId(job.messageId, rule);
      return (
        (await getExecution(job.email, id)) ??
        ({
          id,
          email: job.email,
          messageId: job.messageId,
          threadId: thread?.id ?? "",
          subject: message
            ? header(message, "subject") ||
              (thread?.messages[0]
                ? header(thread.messages[0], "subject")
                : "Deleted message")
            : "Deleted message",
          rule,
          status: "pending",
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } satisfies RuleExecution)
      );
    }),
  );
  // Re-publish completed activity after interrupted activity writes, without redoing actions.
  for (const execution of executions.filter((e) => e.status === "complete"))
    if (execution.decision) await saveDecision(execution.decision);
  const pending = executions.filter((e) => e.status === "pending");
  const labels = await gmail.labels();
  const toClassify: RuleExecution[] = [];
  for (const execution of pending) {
    const decision = decisionFor(execution);
    if (!(await ruleIsActive(execution.email, execution.rule.id))) {
      decision.reason = "Rule paused or deleted";
      await completeExecution(execution, decision);
    } else if (!message || !thread) {
      decision.reason = "Message deleted";
      await completeExecution(execution, decision);
    } else if (!isIncoming(message)) {
      decision.excludedLabels = excludedLabels(message);
      decision.reason = decision.excludedLabels
        .map((label) => excludedMailLabels[label])
        .join(" · ");
      await completeExecution(execution, decision);
    } else if (ruleProtectsThread(execution.rule, thread, labels)) {
      decision.reason = "Protected Job Search label";
      await completeExecution(execution, decision);
    } else {
      execution.targetMessageIds = (
        execution.rule.scope === "thread" ? thread.messages : [message]
      )
        .filter(isIncoming)
        .map((m) => m.id);
      await saveExecution(execution);
      toClassify.push(execution);
    }
  }
  if (toClassify.length) {
    let context: unknown[] | undefined;
    try {
      context = await gmail.fullContext(thread!, job.messageId);
    } catch (error) {
      if (!(error instanceof GmailContentError)) throw error;
      for (const execution of toClassify)
        await completeExecution(execution, {
          ...decisionFor(execution),
          reason: "Complete body unavailable",
        });
    }
    if (context) {
      try {
        const results = await classifyRules(
          job.email,
          context,
          toClassify.map((e) => e.rule),
          job.messageId,
          deadline,
        );
        for (const execution of toClassify) {
          const prediction = results.get(execution.rule.id);
          if (!prediction || prediction instanceof Error) {
            await failExecution(
              execution,
              prediction ?? new Error("Missing classification"),
            );
            continue;
          }
          const decided = {
            ...execution,
            prediction,
            status: "decided" as const,
            lastError: null,
          };
          // Persist before changing in-memory state: a failed write must never permit an action.
          await saveExecution(decided);
          Object.assign(execution, decided);
        }
      } catch (error) {
        for (const execution of toClassify.filter(
          (e) => e.status === "pending",
        ))
          await failExecution(execution, error);
      }
    }
  }
  const freshLabels = executions.some((e) => e.status === "decided")
    ? await gmail.labels()
    : labels;
  const actionErrors: string[] = [];
  for (const execution of executions.filter((e) => e.status === "decided")) {
    try {
      await applyPrediction(gmail, execution, freshLabels, deadline);
    } catch (error) {
      actionErrors.push(reasonFor(error));
      // A completed action with an interrupted activity write must retry that activity, not invent a failed action.
      if (execution.status !== "complete")
        await failExecution(execution, error);
    }
  }
  const incomplete = executions.filter((e) => e.status !== "complete");
  if (actionErrors.length && !incomplete.length)
    throw new Error(actionErrors[0]);
  if (incomplete.length)
    throw new Error(
      incomplete
        .map((e) => `${e.rule.name}: ${e.lastError ?? "Pending"}`)
        .join("; ")
        .slice(0, 180),
    );
  await finishJob(job);
}
interface HistoryPage {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  nextPageToken?: string;
  historyId: string;
}
export async function syncAccount(
  email: string,
  source: "push" | "catchup" = "catchup",
) {
  if (!config.processingEnabled) return { processed: 0, staged: true };
  return withAccountLock(email, async () => {
    const account = await getAccount(email);
    if (!account?.enabled) return { processed: 0, disabled: true };
    const gmail = new Gmail(account),
      syncStarted = Date.now(),
      deadline = syncStarted + 180000;
    gmail.deadline = deadline;
    try {
      if (source === "push")
        await accountRef(email).update({ lastPush: Date.now() });
      const rules = await listRules(email);
      let pageToken: string | undefined,
        checkpoint = account.historyId;
      let ingested = 0;
      if (!checkpoint) throw new Error("Mailbox checkpoint missing");
      try {
        do {
          const page = await gmail.request<HistoryPage>(
            `history?startHistoryId=${encodeURIComponent(account.historyId)}&historyTypes=messageAdded&maxResults=500${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`,
          );
          const ids = [
            ...new Set(
              (page.history ?? []).flatMap((h) =>
                (h.messagesAdded ?? []).map((m) => m.message.id),
              ),
            ),
          ];
          await enqueueMessages(email, ids, rules);
          ingested += ids.length;
          checkpoint = page.historyId;
          pageToken = page.nextPageToken;
          if (Date.now() > deadline)
            throw new Error("History ingestion continues on next delivery");
        } while (pageToken);
      } catch (error) {
        if (!(error instanceof GmailError && error.status === 404)) throw error;
        // Capture the high-water mark before listing so arrivals during recovery are retained.
        checkpoint = (await gmail.profile()).historyId;
        const since =
          Math.floor((account.lastSync || account.connectedAt) / 1000) - 300;
        pageToken = undefined;
        do {
          const page: { messages?: { id: string }[]; nextPageToken?: string } =
            await gmail.request<{
              messages?: { id: string }[];
              nextPageToken?: string;
            }>(
              `messages?maxResults=500&q=${encodeURIComponent(`after:${since} -in:spam -in:trash -in:sent -in:drafts`)}${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`,
            );
          const ids = (page.messages ?? []).map((m) => m.id);
          await enqueueMessages(email, ids, rules);
          ingested += ids.length;
          pageToken = page.nextPageToken;
          if (Date.now() > deadline)
            throw new Error("Recovery ingestion continues on next delivery");
        } while (pageToken);
      }
      // The cursor tracks durable ingestion, independently of classifier or Gmail action success.
      await accountRef(email).update({
        historyId: checkpoint,
        lastSync: syncStarted,
        lastError: null,
      });
      const jobs = await pendingJobs(email);
      let processed = 0,
        failed = 0;
      for (const job of jobs) {
        if (Date.now() > deadline - 50000) break;
        try {
          await processJob(gmail, job, deadline);
          processed++;
        } catch (error) {
          failed++;
          await retryJob(job, reasonFor(error));
        }
      }
      if (failed)
        await accountRef(email).update({
          lastError: `${failed} message jobs need retry. See Activity for rule errors.`,
        });
      return { ingested, processed, failed };
    } catch (error) {
      await accountRef(email).update({ lastError: reasonFor(error) });
      throw error;
    }
  });
}
export async function renewAccount(email: string) {
  if (!config.processingEnabled) return;
  return withAccountLock(email, async () => {
    const account = await getAccount(email);
    if (!account?.enabled) return;
    const watch = await new Gmail(account).watch();
    await accountRef(email).update({ watchExpires: Number(watch.expiration) });
  });
}
