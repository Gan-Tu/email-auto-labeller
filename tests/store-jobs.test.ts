import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type {
  Rule,
  MessageJob,
  RuleExecution,
  Decision,
} from "../server/types";
const state = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  failCommit: false,
}));
vi.mock("@google-cloud/firestore", () => {
  const doc = (path: string): any => ({
    path,
    id: path.split("/").at(-1),
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => snapshot(doc(path)),
    set: async (data: any) => state.docs.set(path, structuredClone(data)),
    update: async (data: any) => {
      if (!state.docs.has(path)) throw new Error("Missing document");
      state.docs.set(path, {
        ...state.docs.get(path),
        ...structuredClone(data),
      });
    },
  });
  const collection = (path: string): any => ({
    path,
    doc: (id: string) => doc(`${path}/${id}`),
  });
  const snapshot = (ref: any) => ({
    ref,
    id: ref.id,
    exists: state.docs.has(ref.path),
    data: () => structuredClone(state.docs.get(ref.path)),
  });
  return {
    Timestamp: { fromMillis: (value: number) => value },
    Firestore: class {
      collection = collection;
      getAll = async (...refs: any[]) => refs.map(snapshot);
      runTransaction = async (fn: any) => {
        const writes: { ref: any; data: any }[] = [];
        await fn({
          getAll: async (...refs: any[]) => refs.map(snapshot),
          create: (ref: any, data: any) => writes.push({ ref, data }),
        });
        if (state.failCommit) throw new Error("Commit unavailable");
        for (const w of writes) {
          if (state.docs.has(w.ref.path)) throw new Error("Already exists");
          state.docs.set(w.ref.path, structuredClone(w.data));
        }
      };
    },
  };
});
import {
  accountRef,
  jobRef,
  decisionRef,
  enqueueMessages,
  loadJobRules,
  ruleRef,
  ruleVersionRef,
  executionRef,
  saveExecution,
  saveDecision,
  finishJob,
} from "../server/store";
const email = "a@example.com";
const rule = (id = "recruiting", version = 1) =>
  ({
    id,
    email,
    name: id,
    prompt: "Classify incoming email by hiring intent.",
    enabled: true,
    threshold: 0.8,
    choices: [
      {
        id: "yes",
        name: "Yes",
        description: "Hiring",
        labelId: "L",
        labelName: "Recruiting",
      },
    ],
    scope: "thread",
    draftReplies: false,
    preserveJobSearch: false,
    version,
    createdAt: 1,
    updatedAt: 1,
  }) satisfies Rule;
beforeEach(() => {
  state.docs.clear();
  state.failCommit = false;
  state.docs.set(accountRef(email).path, {
    email,
    enabled: true,
    rulesMigratedAt: 1,
  });
});
it("re-delivery retains the original rule versions, even when rules have changed", async () => {
  await enqueueMessages(email, ["m"], [rule()]);
  await enqueueMessages(email, ["m"], [rule("recruiting", 2), rule("finance")]);
  expect(state.docs.get(jobRef(email, "m").path).rules).toEqual([
    { id: "recruiting", version: 1 },
  ]);
});
it("uses immutable snapshots rather than current mutable rule settings", async () => {
  await enqueueMessages(email, ["m"], [rule()]);
  state.docs.set(ruleVersionRef(email, "recruiting", 1).path, rule());
  state.docs.set(ruleRef(email, "recruiting").path, {
    ...rule("recruiting", 2),
    prompt: "Changed prompt that must not affect pending mail.",
  });
  const rules = await loadJobRules(
    state.docs.get(jobRef(email, "m").path) as MessageJob,
  );
  expect(rules).toEqual([rule()]);
});
it("fails safely if a referenced version snapshot is absent", async () => {
  await enqueueMessages(email, ["m"], [rule()]);
  await expect(
    loadJobRules(state.docs.get(jobRef(email, "m").path)),
  ).rejects.toThrow("snapshot missing");
});
it.each(["labeled", "not_recruiting", "skipped", "uncertain"])(
  "does not replay imported recruiting decision %s while retaining independent new rules",
  async (outcome) => {
    state.docs.set(decisionRef(email, "m").path, {
      messageId: "m",
      email,
      outcome,
    });
    await enqueueMessages(email, ["m"], [rule(), rule("finance")]);
    expect(state.docs.get(jobRef(email, "m").path).rules).toEqual([
      { id: "finance", version: 1 },
    ]);
  },
);
it("does not treat modern activity or unmigrated mailboxes as legacy decisions", async () => {
  state.docs.set(decisionRef(email, "m").path, {
    messageId: "m",
    email,
    outcome: "labeled",
    ruleId: "finance",
  });
  await enqueueMessages(email, ["m"], [rule()]);
  expect(state.docs.get(jobRef(email, "m").path).rules).toHaveLength(1);
  state.docs.set(accountRef(email).path, { email, enabled: true });
  state.docs.set(decisionRef(email, "next").path, {
    messageId: "next",
    email,
    outcome: "labeled",
  });
  await enqueueMessages(email, ["next"], [rule()]);
  expect(state.docs.get(jobRef(email, "next").path).rules).toHaveLength(1);
});
it("does not report success or create partial jobs when persistence fails", async () => {
  state.failCommit = true;
  await expect(enqueueMessages(email, ["a", "b"], [rule()])).rejects.toThrow(
    "Commit unavailable",
  );
  expect(state.docs.has(jobRef(email, "a").path)).toBe(false);
  expect(state.docs.has(jobRef(email, "b").path)).toBe(false);
});

afterEach(() => vi.restoreAllMocks());
const retention = 30 * 86400000;
const execution = (): RuleExecution => ({
  id: "exec",
  email,
  messageId: "m",
  threadId: "t",
  subject: "A private subject",
  rule: rule(),
  status: "pending",
  attempts: 0,
  createdAt: 100,
  updatedAt: 100,
});
it("expires completed executions after 30 days while pending and decided work have no TTL", async () => {
  const now = 1700000000000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const status of ["pending", "decided"] as const) {
    await saveExecution({
      ...execution(),
      status,
      completedAt: now - 1,
      expiresAt: now - 1,
    } as RuleExecution);
    const saved = state.docs.get(executionRef(email, "exec").path);
    expect(saved).not.toHaveProperty("expiresAt");
    expect(saved).not.toHaveProperty("completedAt");
  }
  await saveExecution({
    ...execution(),
    status: "complete",
    completedAt: now - 100,
  });
  expect(state.docs.get(executionRef(email, "exec").path)).toMatchObject({
    completedAt: now - 100,
    expiresAt: now - 100 + retention,
  });
});
it("expires completed jobs from their first completion without refreshing expiry on retries", async () => {
  const now = 1700000000000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await enqueueMessages(email, ["m"], [rule()]);
  const pending = state.docs.get(jobRef(email, "m").path);
  expect(pending).not.toHaveProperty("expiresAt");
  await finishJob(pending);
  expect(state.docs.get(jobRef(email, "m").path)).toMatchObject({
    status: "complete",
    completedAt: now,
    expiresAt: now + retention,
  });
  clock.mockReturnValue(now + 5000);
  await finishJob(pending);
  expect(state.docs.get(jobRef(email, "m").path).expiresAt).toBe(
    now + retention,
  );
});
it("keeps completed activity expiry stable and does not recreate expired activity", async () => {
  const now = 1700000000000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const decision: Decision = {
    email,
    executionId: "exec",
    messageId: "m",
    threadId: "t",
    subject: "Private",
    outcome: "labeled",
    createdAt: now - 100,
    completedAt: now,
  };
  await saveDecision(decision);
  clock.mockReturnValue(now + 5000);
  await saveDecision(decision);
  expect(state.docs.get(decisionRef(email, "exec").path).expiresAt).toBe(
    now + retention,
  );
  state.docs.delete(decisionRef(email, "exec").path);
  clock.mockReturnValue(now + retention + 1);
  await saveDecision(decision);
  expect(state.docs.has(decisionRef(email, "exec").path)).toBe(false);
});
