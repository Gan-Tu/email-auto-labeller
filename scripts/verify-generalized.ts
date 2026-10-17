/**
 * Isolated live Gmail/Decisions verification. Never sends email or creates labels.
 *
 * node --import tsx scripts/verify-generalized.ts create
 *   --email owner@example.com [--invoice-label Invoice] [--recruiting-label Recruiting]
 *   [--independent-label Actionable] [--state .local/generalized-verification.json]
 * node --import tsx scripts/verify-generalized.ts inspect [--state .local/NAME.json]
 * node --import tsx scripts/verify-generalized.ts cleanup [--state .local/NAME.json]
 *
 * Use the deployed app environment. create is the only mode that creates/enables
 * rules or inserts mail; inspect is read-only apart from recovering local IDs.
 * Cleanup refuses while any pending mailbox job refers to these temporary rules.
 * All inserted mail uses a LinkedIn sender to suppress migrated decline drafts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FieldValue } from "@google-cloud/firestore";
import { useGcloudAuth } from "./local-auth.js";
import { config } from "../server/config.js";
import { Gmail, GmailError, header } from "../server/gmail.js";
import { createRule } from "../server/rules.js";
import {
  accountRef,
  db,
  decisionRef,
  executionId,
  executionRef,
  getAccount,
  jobRef,
  listRules,
  loadJobRules,
  ruleRef,
  withAccountLock,
} from "../server/store.js";
import type {
  Account,
  Decision,
  Message,
  MessageJob,
  Rule,
  RuleExecution,
} from "../server/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2),
  mode = args.shift() ?? "inspect";
const options = new Map<string, string>();
while (args.length) {
  const flag = args.shift()!,
    value = args.shift();
  if (
    ![
      "--email",
      "--invoice-label",
      "--recruiting-label",
      "--independent-label",
      "--state",
    ].includes(flag) ||
    !value ||
    value.startsWith("--") ||
    options.has(flag)
  )
    throw new Error(
      "Use create|inspect|cleanup with --state and optional create-only label name overrides",
    );
  options.set(flag, value);
}
if (!["create", "inspect", "cleanup"].includes(mode))
  throw new Error("Unknown verification mode");
if (
  mode !== "create" &&
  [...options.keys()].some((key) => !["--state", "--email"].includes(key))
)
  throw new Error("Label overrides are only accepted by create");
const EMAIL = (options.get("--email") ?? process.env.VERIFY_EMAIL ?? "")
  .trim()
  .toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL))
  throw new Error(
    "Set VERIFY_EMAIL or supply --email for the verification mailbox",
  );
const statePath = path.resolve(
  root,
  options.get("--state") ?? ".local/generalized-verification.json",
);
if (
  !statePath.startsWith(path.join(root, ".local") + path.sep) ||
  path.extname(statePath) !== ".json"
)
  throw new Error(
    "State must be a JSON file inside this app's ignored .local directory",
  );
interface TemporaryRule {
  kind: "category" | "independent";
  name: string;
  id?: string;
  version?: number;
}
interface Case {
  name: "invoice" | "recruiting" | "newsletter";
  marker: string;
  rfcMessageId: string;
  insertRequestedAt: number;
  messageId?: string;
  threadId?: string;
  insertedAt?: number;
  cleanedAt?: number;
}
interface State {
  schema: 1;
  project: string;
  database: string;
  email: typeof EMAIL;
  runId: string;
  marker: string;
  createdAt: number;
  beforeLastPush: number;
  labels: { invoice: string; recruiting: string; independent: string };
  rules: TemporaryRule[];
  cases: Case[];
  rulesRemovedAt?: number;
}
let state: State;
async function saveState() {
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    `${statePath}.tmp`,
    JSON.stringify(state, null, 2) + "\n",
    { mode: 0o600 },
  );
  await fs.rename(`${statePath}.tmp`, statePath);
}
async function readState() {
  const value = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    value.schema !== 1 ||
    value.project !== config.project ||
    value.database !== config.database ||
    value.email !== EMAIL ||
    typeof value.marker !== "string" ||
    !value.marker.startsWith("generalized-verification-") ||
    !Array.isArray(value.rules) ||
    value.rules.length !== 2 ||
    !Array.isArray(value.cases)
  )
    throw new Error(
      "Verification state does not match this app/project/mailbox",
    );
  state = value as State;
}
async function mailbox(): Promise<Account> {
  const value = await getAccount(EMAIL);
  if (!value || value.email !== EMAIL || !value.refreshToken)
    throw new Error("Verification mailbox is not connected");
  return value;
}
function assertOwnedRule(rule: Rule, expected: TemporaryRule) {
  if (
    rule.email !== EMAIL ||
    rule.name !== expected.name ||
    !rule.prompt.includes(state.marker) ||
    rule.draftReplies ||
    rule.scope !== "message" ||
    (expected.id && rule.id !== expected.id) ||
    (expected.version && rule.version !== expected.version)
  )
    throw new Error(
      "Temporary rule identity or version changed; refusing to remove it",
    );
}
async function recoverRules(): Promise<Rule[]> {
  const existing = await listRules(EMAIL),
    result: Rule[] = [];
  for (const expected of state.rules) {
    if (!expected.id) {
      const found = existing.filter(
        (rule) =>
          rule.name === expected.name && rule.prompt.includes(state.marker),
      );
      if (found.length > 1)
        throw new Error("Ambiguous temporary rules; refusing cleanup");
      if (!found.length) continue;
      assertOwnedRule(found[0], expected);
      expected.id = found[0].id;
      expected.version = found[0].version;
      await saveState();
    }
    const rule = (await ruleRef(EMAIL, expected.id).get()).data() as
      Rule | undefined;
    if (rule) {
      assertOwnedRule(rule, expected);
      result.push(rule);
    }
  }
  return result;
}
const fixtures = [
  {
    name: "invoice" as const,
    subject: "Invoice INV-VER-1001: consulting services completed",
    body: "Hi there, please find invoice INV-VER-1001 for the consulting services we completed this month. The amount due is USD 125.00, payable within 30 days. This is a bill for completed work, not an offer of employment or an invitation to join a team.",
  },
  {
    name: "recruiting" as const,
    subject:
      "Personal invitation to join Example Robotics as Staff Software Engineer",
    body: "Hi there, I am an engineering recruiter at Example Robotics. We would like to hire you as a full-time Staff Software Engineer on our platform team. Your engineering background looks like an excellent fit. Are you available for an introductory call to discuss the position, compensation, and interview process? This is a personal employment opportunity.",
  },
  {
    name: "newsletter" as const,
    subject: "Monthly product newsletter: public release notes",
    body: "Welcome to our monthly product newsletter sent to all subscribers. Read this month's release notes and general product announcements. Join our public webinar to learn about the new features. You may unsubscribe from this mailing list at any time.",
  },
];
async function create() {
  try {
    await fs.access(statePath);
    throw new Error(
      "State already exists; inspect/cleanup it, then use a new --state for another run",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  {
    const account = await mailbox(),
      gmail = new Gmail(account);
    if (!account.enabled || account.watchExpires <= Date.now())
      throw new Error("Mailbox must be enabled with an active Gmail watch");
    if ((await gmail.profile()).emailAddress.toLowerCase() !== EMAIL)
      throw new Error("Gmail identity mismatch");
    if ((await listRules(EMAIL)).length > 18)
      throw new Error("Two free rule slots are required for verification");
    const labels = await gmail.labels();
    const label = (name: string) => {
      const found = labels.filter(
        (label) => label.type === "user" && label.name === name,
      );
      if (found.length !== 1)
        throw new Error(
          `Existing Gmail label not found: ${name}. Supply its exact name with the label override flags.`,
        );
      return found[0];
    };
    const invoice = label(options.get("--invoice-label") ?? "Invoice"),
      recruiting = label(options.get("--recruiting-label") ?? "Recruiting"),
      independent = label(options.get("--independent-label") ?? "Actionable");
    if (new Set([invoice.id, recruiting.id, independent.id]).size !== 3)
      throw new Error(
        "The three verification mappings must use distinct existing labels",
      );
    const runId = randomUUID(),
      marker = `generalized-verification-${runId}`;
    state = {
      schema: 1,
      project: config.project,
      database: config.database,
      email: EMAIL,
      runId,
      marker,
      createdAt: Date.now(),
      beforeLastPush: account.lastPush ?? 0,
      labels: {
        invoice: invoice.id,
        recruiting: recruiting.id,
        independent: independent.id,
      },
      rules: [
        { kind: "category", name: `Verification ${runId} Category` },
        { kind: "independent", name: `Verification ${runId} Additive` },
      ],
      cases: [],
    };
    await saveState();
    const prefix = `This is a temporary isolated verification rule. Select no_match unless the incoming message's Subject contains the exact literal marker ${marker}. Never match mail without that exact marker, even if its content otherwise matches. The marker only limits scope; it does not determine the category. `;
    for (const expected of state.rules) {
      const category = expected.kind === "category";
      const rule = await createRule(account.owner, EMAIL, {
        name: expected.name,
        enabled: true,
        scope: "message",
        threshold: 0.8,
        draftReplies: false,
        preserveJobSearch: false,
        prompt:
          prefix +
          (category
            ? "Classify the actual purpose of the incoming message. Select Invoice for a bill requesting payment for services already completed, with an invoice number and amount due. Select Recruiting for personally directed outreach inviting the mailbox owner to join a team as an employee. Select no_match for newsletters, general marketing, public product announcements, or any other purpose."
            : "Select Verification only for a marked incoming message whose actual purpose is either an invoice requesting payment for completed services or personally directed employment recruitment. Select no_match for newsletters, general marketing, public announcements, all other purposes, and every message lacking the marker. The presence of the marker alone is insufficient."),
        choices: category
          ? [
              {
                id: "invoice",
                name: "Invoice",
                description:
                  "A bill requesting payment for completed services, containing an invoice identifier and amount due.",
                labelId: invoice.id,
                labelName: invoice.name,
              },
              {
                id: "recruiting",
                name: "Recruiting",
                description:
                  "Personal outreach inviting the recipient to join an employer as an employee.",
                labelId: recruiting.id,
                labelName: recruiting.name,
              },
            ]
          : [
              {
                id: "verification",
                name: "Verification",
                description:
                  "An exact-marker message that is an invoice or a personal employment invitation, excluding newsletters and public announcements.",
                labelId: independent.id,
                labelName: independent.name,
              },
            ],
      });
      expected.id = rule.id;
      expected.version = rule.version;
      await saveState();
    }
    // Both rules exist before inserting any marked messages; hold the lease during insertion.
    await withAccountLock(EMAIL, async () => {
      for (const fixture of fixtures) {
        const test: Case = {
          name: fixture.name,
          marker: `${marker}-${fixture.name}-${randomUUID()}`,
          rfcMessageId: "",
          insertRequestedAt: Date.now(),
        };
        test.rfcMessageId = `${test.marker}@email-auto-labeller.test`;
        state.cases.push(test);
        await saveState();
        const raw = [
          "From: Example Robotics <inmail-hit-reply@linkedin.com>",
          `To: ${EMAIL}`,
          `Subject: [${marker}] [${test.marker}] ${fixture.subject}`,
          `Date: ${new Date().toUTCString()}`,
          `Message-ID: <${test.rfcMessageId}>`,
          `X-Email-Auto-Labeller-Verification: ${test.marker}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "",
          fixture.body,
        ].join("\r\n");
        const message = await gmail.request<{ id: string; threadId: string }>(
          "messages?internalDateSource=receivedTime",
          "POST",
          {
            raw: Buffer.from(raw).toString("base64url"),
            labelIds: ["INBOX", "UNREAD"],
          },
        );
        Object.assign(test, {
          messageId: message.id,
          threadId: message.threadId,
          insertedAt: Date.now(),
        });
        await saveState();
        console.log(
          JSON.stringify({
            event: "inserted",
            email: EMAIL,
            case: test.name,
            messageId: message.id,
          }),
        );
      }
    });
  }
  console.log(
    JSON.stringify({
      event: "created",
      email: EMAIL,
      cases: state.cases.length,
      rules: state.rules.map((rule) => ({ kind: rule.kind, id: rule.id })),
      sentEmail: false,
      state: path.relative(root, statePath),
    }),
  );
}
async function resolveMessage(
  gmail: Gmail,
  test: Case,
): Promise<Message | undefined> {
  if (
    !test.marker.startsWith(state.marker + "-") ||
    test.rfcMessageId !== `${test.marker}@email-auto-labeller.test`
  )
    throw new Error("Invalid test message identity");
  if (!test.messageId) {
    const found = await gmail.request<{
      messages?: { id: string; threadId: string }[];
    }>(
      `messages?includeSpamTrash=true&maxResults=10&q=${encodeURIComponent(`rfc822msgid:${test.rfcMessageId}`)}`,
    );
    if ((found.messages?.length ?? 0) > 1)
      throw new Error("Ambiguous verification Message-ID");
    if (!found.messages?.length) return undefined;
    Object.assign(test, {
      messageId: found.messages[0].id,
      threadId: found.messages[0].threadId,
    });
    await saveState();
  }
  try {
    const message = await gmail.request<Message>(
      `messages/${encodeURIComponent(test.messageId!)}?format=metadata`,
    );
    if (
      header(message, "x-email-auto-labeller-verification") !== test.marker ||
      header(message, "message-id") !== `<${test.rfcMessageId}>` ||
      !header(message, "subject").includes(state.marker) ||
      (test.threadId && test.threadId !== message.threadId)
    )
      throw new Error(
        "Message does not match the verification manifest; refusing to touch it",
      );
    return message;
  } catch (error) {
    if (error instanceof GmailError && error.status === 404) return undefined;
    throw error;
  }
}
async function inspect() {
  const liveRules = await recoverRules();
  if (
    state.rulesRemovedAt ||
    liveRules.length !== 2 ||
    state.cases.length !== 3
  )
    throw new Error(
      "Expected two live verification rules and three recorded test cases",
    );
  const account = await mailbox(),
    gmail = new Gmail(account);
  let failures = 0;
  for (const test of state.cases) {
    const issues: string[] = [],
      outcomes: unknown[] = [];
    try {
      if (test.cleanedAt) throw new Error("Test case was already cleaned up");
      const message = await resolveMessage(gmail, test);
      if (!message) throw new Error("Verification message is not visible yet");
      const job = (await jobRef(EMAIL, message.id).get()).data() as
        MessageJob | undefined;
      if (
        !job ||
        job.status !== "complete" ||
        job.email !== EMAIL ||
        job.messageId !== message.id
      )
        issues.push("Message job is not complete");
      const snapshots = job ? await loadJobRules(job) : [];
      const expectedLabels =
        test.name === "newsletter"
          ? []
          : [state.labels[test.name], state.labels.independent];
      const allMapped = new Set([
        ...Object.values(state.labels),
        ...snapshots.flatMap((rule) =>
          rule.choices.map((choice) => choice.labelId),
        ),
      ]);
      const appliedMapped = (message.labelIds ?? []).filter((id) =>
        allMapped.has(id),
      );
      for (const id of expectedLabels)
        if (!message.labelIds?.includes(id))
          issues.push(`Expected label ${id} is missing`);
      if (test.name === "newsletter" && appliedMapped.length)
        issues.push("No-match newsletter acquired a mapped label");
      if (
        test.name !== "newsletter" &&
        appliedMapped.some((id) => !expectedLabels.includes(id))
      )
        issues.push("Message acquired an unexpected mapped label");
      if (!message.labelIds?.includes("UNREAD"))
        issues.push("Message was marked read");
      if (
        message.labelIds?.some((id) =>
          ["TRASH", "SPAM", "SENT", "DRAFT"].includes(id),
        )
      )
        issues.push("Unexpected Gmail message state");
      const completed: number[] = [];
      for (const expected of state.rules) {
        const rule = snapshots.find((rule) => rule.id === expected.id);
        if (!rule || rule.version !== expected.version) {
          issues.push(
            `${expected.kind} rule version missing from immutable job`,
          );
          continue;
        }
        const id = executionId(message.id, rule);
        const execution = (await executionRef(EMAIL, id).get()).data() as
          RuleExecution | undefined;
        const activity = (await decisionRef(EMAIL, id).get()).data() as
          Decision | undefined;
        const choice =
          test.name === "newsletter"
            ? "no_match"
            : expected.kind === "category"
              ? test.name
              : "verification";
        const label =
          choice === "no_match"
            ? null
            : expected.kind === "category"
              ? state.labels[test.name as "invoice" | "recruiting"]
              : state.labels.independent;
        if (
          execution?.status !== "complete" ||
          execution.email !== EMAIL ||
          execution.messageId !== message.id ||
          execution.rule.version !== expected.version ||
          execution.prediction?.refused ||
          execution.prediction?.choiceId !== choice
        )
          issues.push(
            `${expected.kind} execution/choice is incomplete or incorrect`,
          );
        const result = execution?.decision;
        // The migrated recruiting rule may add the recruiting label first. Its exact same
        // label is allowed to be already present for this category execution.
        const alreadyLabeled =
          test.name === "recruiting" &&
          expected.kind === "category" &&
          result?.outcome === "skipped" &&
          result.reason === "Already labeled";
        const expectedOutcome = choice === "no_match" ? "no_match" : "labeled";
        if (
          (!alreadyLabeled && result?.outcome !== expectedOutcome) ||
          activity?.outcome !== result?.outcome ||
          activity?.choiceId !== choice ||
          activity?.executionId !== id ||
          activity?.messageId !== message.id ||
          activity?.ruleVersion !== expected.version
        )
          issues.push(`${expected.kind} Activity/result mismatch`);
        if (
          label &&
          !alreadyLabeled &&
          (result?.labelId !== label || activity?.labelId !== label)
        )
          issues.push(`${expected.kind} recorded label mismatch`);
        if (result?.draft && result.draft !== "skipped")
          issues.push(`${expected.kind} unexpectedly attempted a draft`);
        if (
          !activity?.completedAt ||
          activity.completedAt < test.insertRequestedAt
        )
          issues.push(`${expected.kind} completion timestamp missing`);
        else completed.push(activity.completedAt);
        outcomes.push({
          rule: expected.kind,
          expectedChoice: choice,
          actualChoice: execution?.prediction?.choiceId ?? null,
          outcome: activity?.outcome ?? null,
          probability: execution?.prediction?.probability ?? null,
        });
      }
      const thread = await gmail.thread(message.threadId);
      if (
        thread.messages.some((message) =>
          message.labelIds?.includes("DRAFT"),
        ) ||
        (
          await accountRef(EMAIL)
            .collection("draftIntents")
            .doc(message.threadId)
            .get()
        ).exists
      )
        issues.push("Unexpected verification draft or draft intent");
      if (
        !account.lastPush ||
        account.lastPush < test.insertRequestedAt ||
        account.lastPush <= state.beforeLastPush
      )
        issues.push("No newer authenticated Gmail push was recorded");
      console.log(
        JSON.stringify({
          event: "inspection",
          email: EMAIL,
          case: test.name,
          messageId: message.id,
          passed: !issues.length,
          expectedLabels,
          appliedMappedLabels: appliedMapped,
          unread: message.labelIds?.includes("UNREAD") ?? false,
          latencyMs:
            completed.length === 2
              ? Math.max(...completed) - test.insertRequestedAt
              : null,
          outcomes,
          issues,
        }),
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Inspection failed");
      console.log(
        JSON.stringify({
          event: "inspection",
          email: EMAIL,
          case: test.name,
          passed: false,
          issues,
        }),
      );
    }
    if (issues.length) failures++;
  }
  console.log(
    JSON.stringify({
      event: "summary",
      passed: failures === 0,
      failures,
      assertions: [
        "two configured label choices plus no_match",
        "invoice receives labels from both independent rules",
        "newsletter selects no_match in both rules and receives no mapped label",
        "all synthetic messages remain unread and have no drafts",
      ],
    }),
  );
  if (failures) process.exitCode = 1;
}
async function cleanup() {
  await withAccountLock(EMAIL, async () => {
    const rules = await recoverRules(),
      ownedIds = new Set(
        state.rules.flatMap((rule) => (rule.id ? [rule.id] : [])),
      );
    const pending = await accountRef(EMAIL)
      .collection("jobs")
      .where("status", "==", "pending")
      .get();
    const affected = pending.docs.filter((document) =>
      (document.data() as MessageJob).rules.some((rule) =>
        ownedIds.has(rule.id),
      ),
    );
    if (affected.length)
      throw new Error(
        `${affected.length} pending jobs still refer to temporary rules. Wait for catch-up, then retry cleanup; nothing was removed.`,
      );
    const gmail = new Gmail(await mailbox());
    // Validate every message and test job before mutating anything.
    const messages: { test: Case; message?: Message; id: string }[] = [];
    for (const test of state.cases) {
      const message = await resolveMessage(gmail, test);
      if (!test.messageId)
        throw new Error(
          "An insertion has no recoverable Gmail ID; inspect again before cleanup",
        );
      const job = (await jobRef(EMAIL, test.messageId).get()).data() as
        MessageJob | undefined;
      if (!test.cleanedAt && job?.status !== "complete")
        throw new Error(
          "A verification message has not finished ingestion/processing; retry after catch-up",
        );
      messages.push({ test, message, id: test.messageId });
    }
    for (const { test, message, id } of messages) {
      if (message && !message.labelIds?.includes("TRASH"))
        await gmail.request(`messages/${encodeURIComponent(id)}/trash`, "POST");
      const [executions, decisions, job] = await Promise.all([
        accountRef(EMAIL)
          .collection("executions")
          .where("messageId", "==", id)
          .get(),
        accountRef(EMAIL)
          .collection("decisions")
          .where("messageId", "==", id)
          .get(),
        jobRef(EMAIL, id).get(),
      ]);
      const docs = [
        ...executions.docs,
        ...decisions.docs,
        ...(job.exists ? [job] : []),
      ];
      for (const doc of docs)
        if (doc.data()?.email !== EMAIL || doc.data()?.messageId !== id)
          throw new Error("App record identity mismatch; refusing deletion");
      for (let offset = 0; offset < docs.length; offset += 400) {
        const batch = db.batch();
        for (const doc of docs.slice(offset, offset + 400))
          batch.delete(doc.ref);
        await batch.commit();
      }
      test.cleanedAt = Date.now();
      await saveState();
      console.log(
        JSON.stringify({
          event: "cleaned_message",
          email: EMAIL,
          case: test.name,
          messageId: id,
          removedAppRecords: docs.length,
        }),
      );
    }
    for (const rule of rules) {
      const expected = state.rules.find((expected) => expected.id === rule.id)!;
      assertOwnedRule(rule, expected);
      const versions = await accountRef(EMAIL)
        .collection("ruleVersions")
        .where("id", "==", rule.id)
        .get();
      for (const version of versions.docs)
        assertOwnedRule(version.data() as Rule, expected);
      const batch = db.batch();
      batch.delete(ruleRef(EMAIL, rule.id));
      for (const version of versions.docs) batch.delete(version.ref);
      batch.update(accountRef(EMAIL), {
        rulesRevision: FieldValue.increment(1),
      });
      await batch.commit();
    }
    // Preserve migrated rules, all genuine messages, and all records for genuine
    // messages, including any completed no_match executions of temporary rules.
    state.rulesRemovedAt = Date.now();
    await saveState();
    console.log(
      JSON.stringify({
        event: "cleanup_complete",
        email: EMAIL,
        rulesRemoved: rules.length,
        migratedRulesPreserved: true,
        labelsCreatedOrDeleted: false,
      }),
    );
  });
}
async function main() {
  useGcloudAuth();
  if (mode === "create") await create();
  else {
    await readState();
    if (mode === "inspect") await inspect();
    else await cleanup();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Generalized verification failed",
  );
  process.exitCode = 1;
});
