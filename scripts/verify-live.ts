/**
 * Live verification only: inserts synthetic mail directly into Gmail, never sends it.
 * Run with the deployed app's environment and `node --import tsx scripts/verify-live.ts`.
 *
 * create [--email ADDRESS]             Two cases for each of the configured migrated inboxes.
 * create-choices --email ADDRESS --rule-id ID --fixtures PATH
 *   Fixtures: [{ name, subject, body, choiceId }], including every configured choice
 *   and "no_match". This tests an existing rule; it never edits rules or labels.
 * inspect [--email ADDRESS]            Exit 1 until every recorded case passes.
 * cleanup [--email ADDRESS]            Trash only marked test mail; remove its app records.
 * --state .local/NAME.json             Optional separate manifest for an additional run.
 *
 * The manifest is saved before each insertion, so interrupted/ambiguous inserts can
 * be recovered by their unique RFC Message-ID. Last-push timing is checked here;
 * correlate /hooks/gmail Cloud Run request logs to independently prove the trigger.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { useGcloudAuth } from "./local-auth.js";
import { config } from "../server/config.js";
import { Gmail, GmailError, header } from "../server/gmail.js";
import {
  accountRef,
  db,
  executionId,
  executionRef,
  getAccount,
  jobRef,
  listRules,
  loadJobRules,
  decisionRef,
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

interface Fixture {
  name: string;
  subject: string;
  body: string;
  choiceId: string;
}
interface TestCase {
  email: string;
  name: string;
  marker: string;
  rfcMessageId: string;
  ruleId: string;
  ruleVersion: number;
  expectedChoiceId: string;
  expectedLabelId: string | null;
  mappedLabelIds: string[];
  beforeLastPush: number;
  insertRequestedAt: number;
  insertedAt?: number;
  messageId?: string;
  threadId?: string;
  cleanedAt?: number;
}
interface Manifest {
  schema: 1;
  project: string;
  database: string;
  runId: string;
  createdAt: number;
  cases: TestCase[];
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.shift() ?? "inspect";
const options = new Map<string, string>();
while (args.length) {
  const flag = args.shift()!,
    value = args.shift();
  if (
    !["--email", "--rule-id", "--fixtures", "--state"].includes(flag) ||
    !value ||
    value.startsWith("--") ||
    options.has(flag)
  )
    throw new Error(
      "Usage: create|create-choices|inspect|cleanup [--email ADDRESS] [--state .local/NAME.json] [--rule-id ID --fixtures PATH]",
    );
  options.set(flag, value);
}
if (!["create", "create-choices", "inspect", "cleanup"].includes(mode))
  throw new Error("Unknown verification mode");
const emailFilter = options.get("--email")?.toLowerCase();
const local = path.join(root, ".local");
const statePath = path.resolve(
  root,
  options.get("--state") ?? ".local/live-verification.json",
);
if (
  !statePath.startsWith(local + path.sep) ||
  path.extname(statePath) !== ".json"
)
  throw new Error(
    "State file must be a JSON file inside this app's ignored .local directory",
  );
let manifest: Manifest;

async function saveManifest() {
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temporary, statePath);
}
async function readManifest() {
  const value = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    value.schema !== 1 ||
    value.project !== config.project ||
    value.database !== config.database ||
    !Array.isArray(value.cases)
  )
    throw new Error("Manifest does not match this app's project/database");
  for (const test of value.cases) {
    if (
      typeof test.email !== "string" ||
      typeof test.marker !== "string" ||
      !test.marker.startsWith("email-auto-labeller-verify-") ||
      typeof test.rfcMessageId !== "string" ||
      !test.rfcMessageId.endsWith("@email-auto-labeller.test")
    )
      throw new Error("Invalid verification manifest");
  }
  manifest = value as Manifest;
}
async function account(email: string): Promise<Account> {
  const value = await getAccount(email);
  if (!value || value.email !== email || !value.refreshToken)
    throw new Error(`Mailbox unavailable: ${email}`);
  return value;
}
const selection = () => {
  const result = manifest.cases.filter(
    (test) => !emailFilter || test.email === emailFilter,
  );
  if (!result.length)
    throw new Error("No verification cases match the selected mailbox");
  return result;
};
function fixturesFrom(value: unknown): Fixture[] {
  if (!Array.isArray(value) || !value.length || value.length > 15)
    throw new Error("Expected 1–15 fixture rows");
  return value.map((row) => {
    if (
      !row ||
      !["name", "subject", "body", "choiceId"].every(
        (key) => typeof row[key] === "string" && row[key].trim(),
      )
    )
      throw new Error("Each fixture needs name, subject, body and choiceId");
    if (/[\r\n]/.test(row.subject) || row.body.length > 100000)
      throw new Error("Invalid fixture subject or body");
    return {
      name: row.name,
      subject: row.subject,
      body: row.body,
      choiceId: row.choiceId,
    };
  });
}
const recruitingFixtures: Fixture[] = [
  {
    name: "recruiting",
    choiceId: "recruiting",
    subject: "Personal invitation: Staff Software Engineer at Example Robotics",
    body: "Hi there, I am an engineering recruiter at Example Robotics. We are hiring a Staff Software Engineer and I am personally reaching out to ask whether you would consider joining our platform team as a full-time employee. Your engineering background looks like an excellent fit. Are you available for an introductory call on Thursday to discuss the position, compensation, and interview process? This is direct recruitment for employment, not a sales pitch or a newsletter.",
  },
  {
    name: "newsletter",
    choiceId: "no_match",
    subject: "Monthly product newsletter: release notes and public webinars",
    body: "This is the monthly Example Robotics product newsletter sent to our general mailing list. Read our release notes, product announcements, and public webinar calendar. You can unsubscribe at any time. This is general marketing content, not a personal invitation, recruitment, employment opportunity, consulting offer, or speaking invitation.",
  },
];

async function create() {
  try {
    await fs.access(statePath);
    throw new Error(
      "A manifest already exists. Inspect/clean it up and choose a new --state file for a new run.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const custom = mode === "create-choices";
  if (
    custom &&
    (!emailFilter || !options.get("--rule-id") || !options.get("--fixtures"))
  )
    throw new Error(
      "create-choices requires --email, --rule-id and --fixtures",
    );
  if (!custom && (options.has("--rule-id") || options.has("--fixtures")))
    throw new Error("Use create-choices for custom rule fixtures");
  const fixtures = custom
    ? fixturesFrom(
        JSON.parse(
          await fs.readFile(
            path.resolve(root, options.get("--fixtures")!),
            "utf8",
          ),
        ),
      )
    : recruitingFixtures;
  const emails = emailFilter ? [emailFilter] : config.allowed;
  const plans: {
    mailbox: Account;
    gmail: Gmail;
    rule: Rule;
    fixtures: Fixture[];
  }[] = [];
  // Preflight every mailbox before adding any synthetic mail.
  for (const email of emails) {
    const mailbox = await account(email),
      gmail = new Gmail(mailbox);
    if (!mailbox.enabled || mailbox.watchExpires <= Date.now())
      throw new Error(`Mailbox is paused or its watch expired: ${email}`);
    const profile = await gmail.profile();
    if (profile.emailAddress.toLowerCase() !== email)
      throw new Error(`Gmail identity mismatch: ${email}`);
    const rule = (await listRules(email)).find(
      (rule) => rule.id === (custom ? options.get("--rule-id") : "recruiting"),
    );
    if (!rule?.enabled)
      throw new Error(`Enabled verification rule missing: ${email}`);
    const labels = await gmail.labels();
    for (const choice of rule.choices)
      if (
        !labels.some(
          (label) => label.id === choice.labelId && label.type === "user",
        )
      )
        throw new Error(`Verification label missing: ${email}/${choice.id}`);
    const choices = new Set([
      ...rule.choices.map((choice) => choice.id),
      "no_match",
    ]);
    if (fixtures.some((fixture) => !choices.has(fixture.choiceId)))
      throw new Error(`Fixture choice not configured in ${email}/${rule.id}`);
    if (
      custom &&
      [...choices].some(
        (choice) => !fixtures.some((fixture) => fixture.choiceId === choice),
      )
    )
      throw new Error(
        "Custom fixtures must exercise every configured choice plus no_match",
      );
    plans.push({ mailbox, gmail, rule, fixtures });
  }
  manifest = {
    schema: 1,
    project: config.project,
    database: config.database,
    runId: randomUUID(),
    createdAt: Date.now(),
    cases: [],
  };
  await saveManifest();
  for (const { mailbox, gmail, rule, fixtures } of plans) {
    for (const fixture of fixtures) {
      const marker = `email-auto-labeller-verify-${manifest.runId}-${randomUUID()}`;
      const test: TestCase = {
        email: mailbox.email,
        name: fixture.name,
        marker,
        rfcMessageId: `${marker}@email-auto-labeller.test`,
        ruleId: rule.id,
        ruleVersion: rule.version,
        expectedChoiceId: fixture.choiceId,
        expectedLabelId:
          rule.choices.find((choice) => choice.id === fixture.choiceId)
            ?.labelId ?? null,
        mappedLabelIds: rule.choices.map((choice) => choice.labelId),
        beforeLastPush: mailbox.lastPush ?? 0,
        insertRequestedAt: Date.now(),
      };
      manifest.cases.push(test);
      await saveManifest();
      const raw = [
        "From: Example Robotics <inmail-hit-reply@linkedin.com>",
        `To: ${mailbox.email}`,
        `Subject: [${marker}] ${fixture.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${test.rfcMessageId}>`,
        `X-Email-Auto-Labeller-Verification: ${marker}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        fixture.body,
      ].join("\r\n");
      const inserted = await gmail.request<{ id: string; threadId: string }>(
        "messages?internalDateSource=receivedTime",
        "POST",
        {
          raw: Buffer.from(raw).toString("base64url"),
          labelIds: ["INBOX", "UNREAD"],
        },
      );
      Object.assign(test, {
        messageId: inserted.id,
        threadId: inserted.threadId,
        insertedAt: Date.now(),
      });
      await saveManifest();
      console.log(
        JSON.stringify({
          event: "inserted",
          email: test.email,
          case: test.name,
          messageId: test.messageId,
          rule: test.ruleId,
          expectedChoice: test.expectedChoiceId,
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      event: "created",
      cases: manifest.cases.length,
      state: path.relative(root, statePath),
      sentEmail: false,
    }),
  );
}

async function resolveMessage(
  gmail: Gmail,
  test: TestCase,
): Promise<Message | undefined> {
  if (!test.messageId) {
    const found = await gmail.request<{
      messages?: { id: string; threadId: string }[];
    }>(
      `messages?includeSpamTrash=true&maxResults=10&q=${encodeURIComponent(`rfc822msgid:${test.rfcMessageId}`)}`,
    );
    if ((found.messages?.length ?? 0) > 1)
      throw new Error("Ambiguous test Message-ID; refusing cleanup");
    if (!found.messages?.length) return undefined;
    Object.assign(test, {
      messageId: found.messages[0].id,
      threadId: found.messages[0].threadId,
    });
    await saveManifest();
  }
  try {
    const message = await gmail.request<Message>(
      `messages/${encodeURIComponent(test.messageId!)}?format=metadata`,
    );
    if (
      header(message, "x-email-auto-labeller-verification") !== test.marker ||
      header(message, "message-id") !== `<${test.rfcMessageId}>` ||
      !header(message, "subject").includes(test.marker) ||
      (test.threadId && message.threadId !== test.threadId)
    )
      throw new Error(
        "Gmail message does not match the manifest; refusing to touch it",
      );
    return message;
  } catch (error) {
    if (error instanceof GmailError && error.status === 404) return undefined;
    throw error;
  }
}

async function inspect() {
  let failed = 0;
  for (const test of selection()) {
    const issues: string[] = [];
    try {
      if (test.cleanedAt) throw new Error("This case was already cleaned up");
      const mailbox = await account(test.email),
        gmail = new Gmail(mailbox);
      const message = await resolveMessage(gmail, test);
      if (!message)
        throw new Error(
          "Test message is missing or insertion is not yet visible",
        );
      const job = (await jobRef(test.email, message.id).get()).data() as
        MessageJob | undefined;
      const rules = job ? await loadJobRules(job) : [];
      const target = rules.find((rule) => rule.id === test.ruleId);
      if (
        !job ||
        job.email !== test.email ||
        job.messageId !== message.id ||
        job.status !== "complete"
      )
        issues.push("Message job is not complete");
      if (!target || target.version !== test.ruleVersion)
        issues.push(
          "Expected rule version is not in the immutable job snapshot",
        );
      const id = target ? executionId(message.id, target) : undefined;
      const execution = id
        ? ((await executionRef(test.email, id).get()).data() as
            RuleExecution | undefined)
        : undefined;
      const activity = id
        ? ((await decisionRef(test.email, id).get()).data() as
            Decision | undefined)
        : undefined;
      if (
        !execution ||
        execution.status !== "complete" ||
        execution.messageId !== message.id ||
        execution.email !== test.email
      )
        issues.push("Rule execution is not complete");
      if (
        !execution?.prediction ||
        execution.prediction.refused ||
        execution.prediction.choiceId !== test.expectedChoiceId
      )
        issues.push("Decisions choice does not match the expected choice");
      const expectedOutcome = test.expectedLabelId ? "labeled" : "no_match";
      if (
        execution?.decision?.outcome !== expectedOutcome ||
        activity?.outcome !== expectedOutcome ||
        activity?.choiceId !== test.expectedChoiceId ||
        activity?.executionId !== id ||
        activity?.messageId !== message.id ||
        activity?.ruleVersion !== test.ruleVersion
      )
        issues.push(
          "Execution and Activity do not agree with the expected result",
        );
      if (
        test.expectedLabelId &&
        (!message.labelIds?.includes(test.expectedLabelId) ||
          activity?.labelId !== test.expectedLabelId ||
          execution?.decision?.labelId !== test.expectedLabelId)
      )
        issues.push("Expected Gmail label was not applied");
      const mapped = new Set([
        ...test.mappedLabelIds,
        ...rules.flatMap((rule) =>
          rule.choices.map((choice) => choice.labelId),
        ),
      ]);
      const appliedMapped = (message.labelIds ?? []).filter((id) =>
        mapped.has(id),
      );
      if (!test.expectedLabelId && appliedMapped.length)
        issues.push("No-match mail acquired a mapped Gmail label");
      if (!message.labelIds?.includes("UNREAD"))
        issues.push("Test message was marked read");
      if (
        message.labelIds?.some((label) =>
          ["TRASH", "SPAM", "SENT", "DRAFT"].includes(label),
        )
      )
        issues.push("Unexpected Gmail message state");
      if (
        !mailbox.lastPush ||
        mailbox.lastPush < test.insertRequestedAt ||
        mailbox.lastPush <= test.beforeLastPush
      )
        issues.push("No newer authenticated Gmail push has been recorded");
      const thread = await gmail.thread(message.threadId);
      if (
        thread.messages.some((message) => message.labelIds?.includes("DRAFT"))
      )
        issues.push("Unexpected draft exists in the verification thread");
      if (
        (
          await accountRef(test.email)
            .collection("draftIntents")
            .doc(message.threadId)
            .get()
        ).exists
      )
        issues.push(
          "Unexpected draft intent exists for LinkedIn verification mail",
        );
      for (const rule of rules) {
        const siblingId = executionId(message.id, rule);
        const sibling = (
          await executionRef(test.email, siblingId).get()
        ).data() as RuleExecution | undefined;
        if (sibling?.status !== "complete")
          issues.push(`Sibling rule ${rule.id} is incomplete`);
        if (sibling?.decision?.draft && sibling.decision.draft !== "skipped")
          issues.push(`Sibling rule ${rule.id} unexpectedly attempted a draft`);
      }
      const completedAt = activity?.completedAt;
      if (!completedAt || completedAt < test.insertRequestedAt)
        issues.push(
          "Completion timestamp is unavailable or precedes insertion",
        );
      console.log(
        JSON.stringify({
          event: "inspection",
          email: test.email,
          case: test.name,
          messageId: message.id,
          passed: !issues.length,
          expectedChoice: test.expectedChoiceId,
          actualChoice: execution?.prediction?.choiceId ?? null,
          outcome: activity?.outcome ?? null,
          probability: execution?.prediction?.probability ?? null,
          unread: message.labelIds?.includes("UNREAD") ?? false,
          appliedMappedLabels: appliedMapped,
          lastPush: mailbox.lastPush
            ? new Date(mailbox.lastPush).toISOString()
            : null,
          latencyMs: completedAt ? completedAt - test.insertRequestedAt : null,
          issues,
        }),
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Inspection failed");
      console.log(
        JSON.stringify({
          event: "inspection",
          email: test.email,
          case: test.name,
          passed: false,
          issues,
        }),
      );
    }
    if (issues.length) failed++;
  }
  console.log(
    JSON.stringify({
      event: "inspection_summary",
      cases: selection().length,
      failed,
      passed: failed === 0,
    }),
  );
  if (failed) process.exitCode = 1;
}

async function cleanup() {
  let failed = 0;
  for (const test of selection()) {
    try {
      await withAccountLock(test.email, async () => {
        const gmail = new Gmail(await account(test.email));
        const message = await resolveMessage(gmail, test);
        // A persisted Gmail id was returned by insert or recovered from the exact
        // RFC Message-ID; an absent message may already have been trashed/deleted.
        if (!test.messageId)
          throw new Error(
            "Insertion has no recoverable Gmail ID; no records were deleted",
          );
        const id = test.messageId;
        if (message && !message.labelIds?.includes("TRASH"))
          await gmail.request(
            `messages/${encodeURIComponent(id)}/trash`,
            "POST",
          );
        const accountDocument = accountRef(test.email);
        const [executions, decisions, job] = await Promise.all([
          accountDocument
            .collection("executions")
            .where("messageId", "==", id)
            .get(),
          accountDocument
            .collection("decisions")
            .where("messageId", "==", id)
            .get(),
          jobRef(test.email, id).get(),
        ]);
        const docs = [
          ...executions.docs,
          ...decisions.docs,
          ...(job.exists ? [job] : []),
        ];
        for (const document of docs) {
          const value = document.data();
          if (value?.email !== test.email || value?.messageId !== id)
            throw new Error("App record identity mismatch; refusing deletion");
        }
        for (let offset = 0; offset < docs.length; offset += 400) {
          const batch = db.batch();
          for (const document of docs.slice(offset, offset + 400))
            batch.delete(document.ref);
          await batch.commit();
        }
        test.cleanedAt = Date.now();
        await saveManifest();
        console.log(
          JSON.stringify({
            event: "cleaned",
            email: test.email,
            case: test.name,
            messageId: id,
            removedAppRecords: docs.length,
            wasComplete: job.data()?.status === "complete",
            note:
              job.data()?.status === "complete"
                ? undefined
                : "Ingestion was not complete; rerun cleanup after catch-up to remove any later skipped test records.",
          }),
        );
      });
    } catch (error) {
      failed++;
      console.log(
        JSON.stringify({
          event: "cleanup_failed",
          email: test.email,
          case: test.name,
          error: error instanceof Error ? error.message : "Cleanup failed",
        }),
      );
    }
  }
  if (failed) process.exitCode = 1;
}

async function main() {
  useGcloudAuth();
  if (mode === "create" || mode === "create-choices") await create();
  else {
    await readManifest();
    if (mode === "inspect") await inspect();
    else await cleanup();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Live verification failed",
  );
  process.exitCode = 1;
});
