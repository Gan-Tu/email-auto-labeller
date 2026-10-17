/** Copy only this app's mailbox state. Credentials remain encrypted; never printed. */
import { Firestore, type DocumentReference } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  db,
  accountRef,
  ruleRef,
  ruleVersionRef,
  lockRef,
} from "../server/store.js";
import { config, requireEnv } from "../server/config.js";
import { useGcloudAuth } from "./local-auth.js";
import { buildRecruitingRule } from "../server/rules.js";
import { Gmail, findLabel } from "../server/gmail.js";
import {
  mergeMigrationAccount,
  assertMailboxIdentity,
} from "./migration-state.js";
import type { Account, Rule } from "../server/types.js";

const targetProject = requireEnv("GOOGLE_CLOUD_PROJECT");
const targetDatabase = requireEnv("FIRESTORE_DATABASE");
const targetService = process.env.SERVICE_NAME?.trim() || "email-auto-labeller";
const targetRegion = process.env.REGION?.trim() || "us-central1";
const sourceIdentity = {
  project: requireEnv("SOURCE_PROJECT"),
  database: requireEnv("SOURCE_DATABASE"),
};
const sourceService = requireEnv("SOURCE_SERVICE");
const sourceRegion = requireEnv("SOURCE_REGION");
const sourceSubscription = requireEnv("SOURCE_PUSH_SUBSCRIPTION");
const sourceSchedulerPrefix = requireEnv("SOURCE_SCHEDULER_PREFIX");
if (
  sourceIdentity.project === targetProject &&
  sourceIdentity.database === targetDatabase
)
  throw new Error("Source and destination Firestore databases must differ");
useGcloudAuth();
const auth = new OAuth2Client();
auth.setCredentials({
  access_token: execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim(),
  expiry_date: Date.now() + 3000000,
});
const source = new Firestore({
  projectId: sourceIdentity.project,
  databaseId: sourceIdentity.database,
  authClient: auth,
  preferRest: true,
  ignoreUndefinedProperties: true,
});
const mode = process.argv[2] ?? "inspect";
if (!["inspect", "stage", "cutover", "verify"].includes(mode))
  throw new Error("Mode must be inspect, stage, cutover, or verify");
const writing = mode === "stage" || mode === "cutover";
const token = `email-auto-labeller-migration:${randomUUID()}`;
const acquired: {
  database: Firestore;
  refs: DocumentReference[];
  source: boolean;
}[] = [];
const gcloudJson = (args: string[]) =>
  JSON.parse(
    execFileSync("gcloud", [...args, "--format=json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

function processingDisabled(): boolean {
  const service = gcloudJson([
    "run",
    "services",
    "describe",
    targetService,
    `--project=${targetProject}`,
    `--region=${targetRegion}`,
  ]);
  const disabled = (containers: any[]) =>
    containers?.length > 0 &&
    containers.every((container) =>
      container.env?.some(
        (env: any) =>
          env.name === "PROCESSING_ENABLED" && env.value === "false",
      ),
    );
  if (!disabled(service.spec?.template?.spec?.containers)) return false;
  const serving = (service.status?.traffic ?? []).filter(
    (traffic: any) => traffic.percent > 0,
  );
  if (!serving.length)
    throw new Error("Destination service has no ready traffic revision");
  for (const name of new Set<string>(
    serving.map(
      (traffic: any) =>
        traffic.revisionName ?? service.status.latestReadyRevisionName,
    ),
  )) {
    if (!name) throw new Error("Destination traffic revision is unresolved");
    const revision = gcloudJson([
      "run",
      "revisions",
      "describe",
      name,
      `--project=${targetProject}`,
      `--region=${targetRegion}`,
    ]);
    if (!disabled(revision.spec?.containers)) return false;
  }
  return true;
}
function assertOldDeliveryPaused() {
  const sub = gcloudJson([
    "pubsub",
    "subscriptions",
    "describe",
    sourceSubscription,
    `--project=${sourceIdentity.project}`,
  ]);
  const schedules = gcloudJson([
    "scheduler",
    "jobs",
    "list",
    `--project=${sourceIdentity.project}`,
    `--location=${sourceRegion}`,
  ]);
  if (
    sub.pushConfig?.pushEndpoint ||
    schedules.some(
      (job: any) =>
        job.name.split("/").at(-1)?.startsWith(sourceSchedulerPrefix) &&
        job.state === "ENABLED",
    )
  )
    throw new Error("Pause old push and schedules before final migration");
}
async function acquire(
  database: Firestore,
  refs: DocumentReference[],
  isSource: boolean,
) {
  if (!refs.length) return;
  await database.runTransaction(async (transaction) => {
    const locks = await transaction.getAll(...refs);
    if (locks.some((lock) => (lock.data()?.until ?? 0) > Date.now()))
      throw new Error(
        `${isSource ? "Source" : "Destination"} mailbox is busy; retry after its worker or reconnect completes`,
      );
    for (const ref of refs)
      transaction.set(ref, { token, until: Date.now() + 3600000 });
  });
  acquired.push({ database, refs, source: isSource });
}
async function release(lease: (typeof acquired)[number]) {
  await lease.database.runTransaction(async (transaction) => {
    const locks = await transaction.getAll(...lease.refs);
    for (const lock of locks)
      if (lock.data()?.token === token) transaction.delete(lock.ref);
  });
}
async function assertOwnLocks() {
  for (const lease of acquired) {
    const locks = await lease.database.getAll(...lease.refs);
    if (
      locks.some(
        (lock) =>
          lock.data()?.token !== token || lock.data()!.until <= Date.now(),
      )
    )
      throw new Error(
        "Migration maintenance lease expired or changed; retry safely",
      );
  }
}
interface Plan {
  source: Account;
  destination: Account | undefined;
  merged: ReturnType<typeof mergeMigrationAccount>;
  rule: Rule;
  records: {
    name: string;
    docs: { id: string; data: FirebaseFirestore.DocumentData }[];
  }[];
}
async function verifyAccount(plan: Plan, beforeProcessing: boolean) {
  const copied = (await accountRef(plan.source.email).get()).data() as
    Account | undefined;
  if (
    !copied ||
    copied.email !== plan.source.email ||
    copied.owner !== plan.source.owner
  )
    throw new Error("Account copy identity mismatch");
  const gmail = new Gmail(copied);
  assertMailboxIdentity(
    (await gmail.profile()).emailAddress,
    plan.source.email,
  );
  const rule = (await ruleRef(plan.source.email, "recruiting").get()).data() as
    Rule | undefined;
  if (!rule || rule.email !== plan.source.email)
    throw new Error("Migrated rule is unavailable");
  const labels = await gmail.labels();
  if (
    rule.choices.some(
      (choice) =>
        !labels.some(
          (label) => label.id === choice.labelId && label.type !== "system",
        ),
    )
  )
    throw new Error("Migrated rule label is unavailable");
  if (beforeProcessing) {
    for (const field of [
      "enabled",
      "historyId",
      "lastSync",
      "watchExpires",
      "connectedAt",
      "label",
      "threshold",
      "draftReplies",
      "classificationPrompt",
    ] as const)
      if (!isDeepStrictEqual(copied[field], plan.source[field]))
        throw new Error(`Source account setting/cursor mismatch: ${field}`);
    for (const field of [
      "prompt",
      "enabled",
      "threshold",
      "scope",
      "draftReplies",
      "preserveJobSearch",
      "choices",
    ] as const)
      if (!isDeepStrictEqual(rule[field], plan.rule[field]))
        throw new Error(`Rule copy mismatch: ${field}`);
    const version = (
      await ruleVersionRef(plan.source.email, rule.id, rule.version).get()
    ).data();
    if (!isDeepStrictEqual(version, rule))
      throw new Error("Immutable rule version differs from current rule");
    for (const collection of plan.records)
      for (let i = 0; i < collection.docs.length; i += 100) {
        const expected = collection.docs.slice(i, i + 100);
        const copied = await db.getAll(
          ...expected.map((record) =>
            accountRef(plan.source.email)
              .collection(collection.name)
              .doc(record.id),
          ),
        );
        for (let j = 0; j < copied.length; j++)
          if (!isDeepStrictEqual(copied[j].data(), expected[j].data))
            throw new Error(`Imported ${collection.name} record mismatch`);
      }
  }
}
let completed = false;
try {
  const beforeProcessing = mode === "inspect" ? false : processingDisabled();
  if (writing && !beforeProcessing)
    throw new Error(
      "Destination PROCESSING_ENABLED must be false on the service and every serving revision",
    );
  let sourceDocs = (await source.collection("accounts").get()).docs;
  if (!sourceDocs.length) throw new Error("Source has no mailbox accounts");
  if (mode === "cutover") {
    assertOldDeliveryPaused();
    await acquire(
      source,
      sourceDocs.map((doc) => source.collection("locks").doc(doc.id)),
      true,
    );
    const fresh = (await source.collection("accounts").get()).docs;
    if (
      fresh.length !== sourceDocs.length ||
      fresh.some(
        (doc) => !sourceDocs.some((previous) => previous.id === doc.id),
      )
    )
      throw new Error(
        "Source account inventory changed; retry to lock the complete inventory",
      );
    sourceDocs = fresh;
  }
  if (writing) {
    const destinationDocs = (await db.collection("accounts").get()).docs;
    const emails = [
      ...new Set([
        ...sourceDocs.map((doc) => (doc.data() as Account).email),
        ...destinationDocs.map((doc) => (doc.data() as Account).email),
      ]),
    ];
    await acquire(db, emails.map(lockRef), false);
  }
  const plans: Plan[] = [];
  // Validate every account and copy prerequisite before mutating any destination account.
  for (const document of sourceDocs) {
    const account = document.data() as Account;
    const destination = (await accountRef(account.email).get()).data() as
      Account | undefined;
    if (mode === "verify" && !destination)
      throw new Error("Destination mailbox is missing");
    if (writing) {
      const [jobs, executions, rule] = await Promise.all([
        accountRef(account.email).collection("jobs").limit(1).get(),
        accountRef(account.email).collection("executions").limit(1).get(),
        ruleRef(account.email, "recruiting").get(),
      ]);
      if (!jobs.empty || !executions.empty)
        throw new Error(
          "Destination has processed work; refuse to overwrite checkpoints or rule versions",
        );
      if (rule.exists && rule.data()?.version !== 1)
        throw new Error(
          "Destination recruiting rule was edited after staging; refuse to overwrite it",
        );
    }
    const merged = mergeMigrationAccount(account, destination, sourceIdentity);
    const gmail = new Gmail(merged);
    assertMailboxIdentity((await gmail.profile()).emailAddress, account.email);
    const label = findLabel(await gmail.labels(), account.label);
    if (!label)
      throw new Error(
        "Existing recruiting label is missing for " + account.email,
      );
    const rule = buildRecruitingRule(account, label);
    const records = [];
    for (const name of ["decisions", "draftIntents"]) {
      const snapshot = await document.ref.collection(name).get();
      records.push({
        name,
        docs: snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      });
    }
    plans.push({ source: account, destination, merged, rule, records });
  }
  if (writing) {
    await assertOwnLocks();
    if (!processingDisabled())
      throw new Error("Destination processing changed during preflight");
    if (mode === "cutover") assertOldDeliveryPaused();
    for (const plan of plans) {
      await assertOwnLocks();
      const batch = db.batch();
      batch.set(accountRef(plan.source.email), plan.merged);
      batch.set(ruleRef(plan.source.email, plan.rule.id), plan.rule);
      batch.set(
        ruleVersionRef(plan.source.email, plan.rule.id, plan.rule.version),
        plan.rule,
      );
      await batch.commit();
      for (const collection of plan.records)
        for (let i = 0; i < collection.docs.length; i += 400) {
          const batch = db.batch();
          for (const record of collection.docs.slice(i, i + 400))
            batch.set(
              accountRef(plan.source.email)
                .collection(collection.name)
                .doc(record.id),
              record.data,
            );
          await batch.commit();
        }
    }
  }
  for (const plan of plans) {
    if (writing || mode === "verify")
      await verifyAccount(plan, beforeProcessing);
    console.log(
      JSON.stringify({
        mode,
        email: plan.source.email,
        profileMatches: true,
        credentialSource: plan.destination?.refreshToken
          ? "validated destination"
          : "source",
        label: plan.rule.choices[0].labelName,
        labelId: plan.rule.choices[0].labelId,
        enabled: plan.source.enabled,
        threshold: plan.rule.threshold,
        draftReplies: plan.rule.draftReplies,
        historyId: plan.source.historyId,
        counts: Object.fromEntries(
          plan.records.map((collection) => [
            collection.name,
            collection.docs.length,
          ]),
        ),
        cursorCompared: (writing || mode === "verify") && beforeProcessing,
      }),
    );
  }
  completed = true;
  console.log(
    JSON.stringify({
      mode,
      accounts: plans.length,
      completed: true,
      sourceMaintenanceRetained: mode === "cutover",
      sourceService,
      destinationService: targetService,
    }),
  );
} finally {
  const failures: string[] = [];
  for (const lease of [...acquired].reverse()) {
    if (lease.source && completed && mode === "cutover") continue;
    try {
      await release(lease);
    } catch {
      failures.push(lease.source ? "source" : "destination");
    }
  }
  if (failures.length)
    throw new Error(
      `Maintenance lock release failed for ${failures.join(", ")}; release only locks bearing token ${token} before retrying`,
    );
}
