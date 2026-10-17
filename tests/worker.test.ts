import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Rule,
  MessageJob,
  RuleExecution,
  Decision,
} from "../server/types";
const state = vi.hoisted(() => ({
  account: {
    email: "a@example.com",
    owner: "owner@example.com",
    enabled: true,
    historyId: "100",
    lastSync: 1700000000000,
  },
  thread: vi.fn(),
  request: vi.fn(),
  classify: vi.fn(),
  label: vi.fn(),
  fullContext: vi.fn(),
  events: [] as string[],
  rules: [] as Rule[],
  jobs: [] as MessageJob[],
  snapshots: new Map<string, Rule>(),
  executions: new Map<string, RuleExecution>(),
  decisions: new Map<string, Decision>(),
  applied: new Map<string, string[]>(),
  intents: new Map<string, any>(),
  processing: true,
  active: true,
  failSaveDecided: false,
  failCompletedActivity: false,
}));
vi.mock("../server/config", () => ({
  config: {
    declineReplyText:
      "Thanks for reaching out. I am not exploring new opportunities right now.",
    get processingEnabled() {
      return state.processing;
    },
  },
}));
vi.mock("../server/store", () => ({
  ruleIsActive: async () => state.active,
  recordRuleError: async () => {},
  getAccount: async () => state.account,
  withAccountLock: async (_email: string, fn: any) => fn(),
  accountRef: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        create: async (value: any) => {
          if (state.intents.has(`${name}/${id}`))
            throw Object.assign(new Error("Already exists"), { code: 6 });
          state.intents.set(`${name}/${id}`, value);
        },
        set: async (value: any) =>
          state.intents.set(`${name}/${id}`, {
            ...state.intents.get(`${name}/${id}`),
            ...value,
          }),
      }),
    }),
    update: async (v: any) => {
      state.events.push(v.historyId ? "cursor" : "update");
      Object.assign(state.account, v);
    },
  }),
  listRules: async () => state.rules,
  enqueueMessages: async (email: string, ids: string[], rules: Rule[]) => {
    state.events.push("enqueue");
    for (const messageId of ids)
      if (!state.jobs.some((j) => j.messageId === messageId))
        state.jobs.push({
          email,
          messageId,
          rules,
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
          attempts: 0,
          nextAttemptAt: 0,
        });
  },
  pendingJobs: async () => state.jobs.filter((j) => j.status === "pending"),
  loadJobRules: async (job: MessageJob) =>
    job.rules.map((r) =>
      structuredClone(
        state.snapshots.get(`${r.id}:${r.version}`) ??
          state.rules.find(
            (current) => current.id === r.id && current.version === r.version,
          )!,
      ),
    ),
  finishJob: async (job: MessageJob) => {
    job.status = "complete";
  },
  retryJob: async (job: MessageJob) => {
    job.attempts++;
  },
  executionId: (m: string, r: Rule) => `${m}:${r.id}:${r.version}`,
  getExecution: async (_email: string, id: string) => {
    const e = state.executions.get(id);
    return e ? structuredClone(e) : undefined;
  },
  saveExecution: async (e: RuleExecution) => {
    if (e.status === "decided" && state.failSaveDecided) {
      state.failSaveDecided = false;
      throw new Error("Persistence unavailable");
    }
    state.events.push(`execution:${e.rule.id}:${e.status}`);
    state.executions.set(e.id, structuredClone(e));
  },
  saveDecision: async (d: Decision) => {
    if (d.outcome === "labeled" && state.failCompletedActivity) {
      state.failCompletedActivity = false;
      throw new Error("Activity unavailable");
    }
    state.decisions.set(d.executionId!, structuredClone(d));
  },
}));
vi.mock("../server/classifier", () => ({
  classifyRules: state.classify,
  NO_MATCH: "no_match",
}));
vi.mock("../server/gmail", () => ({
  GmailContentError: class extends Error {},
  GmailError: class extends Error {
    constructor(public status: number) {
      super("gmail");
    }
  },
  header: (m: any, name: string) =>
    m.payload?.headers?.find((h: any) => h.name === name)?.value ??
    (name === "subject" ? "An email" : ""),
  Gmail: class {
    account = state.account;
    request = state.request;
    fullContext = state.fullContext;
    label = state.label;
    labels = async () => [
      { id: "L1", name: "Work", type: "user" },
      { id: "L2", name: "Finance", type: "user" },
    ];
    thread = state.thread;
    watch = async () => ({ expiration: "999999", historyId: "200" });
    profile = async () => ({ historyId: "200" });
  },
}));
import {
  syncAccount,
  processJob,
  renewAccount,
  ruleProtectsThread,
  latestMessage,
} from "../server/worker";
import { Gmail, GmailError } from "../server/gmail";
const makeRule = (id = "work", labelId = "L1"): Rule => ({
  id,
  email: "a@example.com",
  name: id,
  prompt: "Classify the incoming email by intent.",
  enabled: true,
  threshold: 0.8,
  choices: [
    {
      id: "yes",
      name: "Yes",
      description: "Matches",
      labelId,
      labelName: labelId,
    },
  ],
  scope: "message",
  draftReplies: false,
  preserveJobSearch: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
});
const prediction = (choiceId = "yes", probability = 0.99) => ({
  choiceId,
  choiceName: choiceId,
  probability,
  confidence: 0.8,
  refused: false,
  probabilities: [],
});
const job = (): MessageJob => {
  for (const r of state.rules)
    state.snapshots.set(`${r.id}:${r.version}`, structuredClone(r));
  return {
    email: "a@example.com",
    messageId: "m",
    rules: state.rules.map((r) => ({ id: r.id, version: r.version })),
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    attempts: 0,
    nextAttemptAt: 0,
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  state.snapshots.clear();
  state.executions.clear();
  state.decisions.clear();
  state.applied.clear();
  state.intents.clear();
  state.events.length = 0;
  state.jobs = [];
  state.processing = true;
  state.active = true;
  state.failSaveDecided = false;
  state.failCompletedActivity = false;
  state.account.historyId = "100";
  state.rules = [makeRule()];
  state.request.mockImplementation(async (path: string) =>
    path.startsWith("history")
      ? {
          history: [{ messagesAdded: [{ message: { id: "m" } }] }],
          historyId: "101",
        }
      : { id: "m", threadId: "t", internalDate: "2" },
  );
  state.thread.mockImplementation(async () => ({
    id: "t",
    messages: [
      {
        id: "m",
        threadId: "t",
        internalDate: "2",
        labelIds: state.applied.get("m") ?? [],
      },
      { id: "older", threadId: "t", internalDate: "1", labelIds: [] },
    ],
  }));
  state.fullContext.mockResolvedValue([{ id: "m", bodies: ["mail"] }]);
  state.classify.mockImplementation(
    async () => new Map(state.rules.map((r) => [r.id, prediction()])),
  );
  state.label.mockImplementation(async (ids: string[], label: string) => {
    state.events.push(`label:${label}`);
    for (const id of ids)
      state.applied.set(id, [...(state.applied.get(id) ?? []), label]);
  });
});
describe("Durable independent classification", () => {
  it("persists discovery before cursor advance even when inference fails", async () => {
    state.classify.mockRejectedValue(new Error("Decisions unavailable"));
    expect(await syncAccount(state.account.email)).toMatchObject({ failed: 1 });
    expect(state.events.indexOf("enqueue")).toBeLessThan(
      state.events.indexOf("cursor"),
    );
    expect(state.account.historyId).toBe("101");
    expect(state.jobs[0]).toMatchObject({ status: "pending", attempts: 1 });
  });
  it("records decisions before Gmail actions and retries only failed actions without inference", async () => {
    state.rules.push(makeRule("finance", "L2"));
    const originalLabel = state.label.getMockImplementation()!;
    let fail = true;
    state.label.mockImplementation(async (...args: any[]) => {
      if (args[1] === "L2" && fail) {
        fail = false;
        throw new Error("Temporary Gmail failure");
      }
      return originalLabel(...args);
    });
    const work = job();
    await expect(
      processJob(new Gmail(state.account as any), work),
    ).rejects.toThrow();
    expect(state.decisions.get("m:work:1")?.outcome).toBe("labeled");
    expect(state.decisions.get("m:finance:1")?.outcome).toBe("failed");
    expect(state.executions.get("m:finance:1")?.status).toBe("decided");
    await processJob(new Gmail(state.account as any), work);
    expect(state.classify).toHaveBeenCalledTimes(1);
    expect(state.fullContext).toHaveBeenCalledTimes(1);
    expect(state.label.mock.calls.filter((c) => c[1] === "L1")).toHaveLength(1);
    expect(state.label.mock.calls.every((c) => c[0].join(",") === "m")).toBe(
      true,
    );
    expect(state.events.indexOf("execution:work:decided")).toBeLessThan(
      state.events.indexOf("label:L1"),
    );
    expect(work.status).toBe("complete");
  });
  it("does not let one malformed answer discard a valid independent answer", async () => {
    state.rules.push(makeRule("finance", "L2"));
    state.classify.mockResolvedValueOnce(
      new Map([
        ["work", prediction()],
        ["finance", new Error("Invalid response")],
      ]),
    );
    const work = job();
    await expect(
      processJob(new Gmail(state.account as any), work),
    ).rejects.toThrow();
    expect(state.executions.get("m:work:1")?.status).toBe("complete");
    expect(state.executions.get("m:finance:1")?.status).toBe("pending");
    await processJob(new Gmail(state.account as any), work);
    expect(state.classify.mock.calls[1][2].map((r: Rule) => r.id)).toEqual([
      "finance",
    ]);
    expect(state.applied.get("m")).toEqual(["L1", "L2"]);
  });
  it.each([
    ["no_match", 0.99, "no_match"],
    ["yes", 0.65, "uncertain"],
  ])("leaves Gmail unchanged for %s", async (choice, probability, outcome) => {
    state.classify.mockResolvedValue(
      new Map([["work", prediction(choice as string, probability as number)]]),
    );
    await processJob(new Gmail(state.account as any), job());
    expect(state.label).not.toHaveBeenCalled();
    expect(state.decisions.get("m:work:1")?.outcome).toBe(outcome);
  });
  it("does not process or renew staged deployment watches", async () => {
    state.processing = false;
    expect(await syncAccount(state.account.email)).toMatchObject({
      staged: true,
    });
    await renewAccount(state.account.email);
    expect(state.request).not.toHaveBeenCalled();
  });
  it("watch renewal does not change the cursor", async () => {
    await renewAccount(state.account.email);
    expect(state.account.historyId).toBe("100");
  });
  it("preserves opted-in Job Search namespaces across a thread", () => {
    expect(
      ruleProtectsThread(
        { ...makeRule(), preserveJobSearch: true },
        {
          id: "t",
          messages: [
            { id: "old", threadId: "t", internalDate: "1", labelIds: ["job"] },
          ],
        },
        [{ id: "job", name: "Job Search/ExampleCo" }],
      ),
    ).toBe(true);
  });
  it("rejects ambiguous draft chronology", () => {
    const m = { id: "a", threadId: "t", internalDate: "1" };
    expect(latestMessage([m, { ...m, id: "b" }])).toBeUndefined();
  });
});

it("never applies an action when prediction persistence fails", async () => {
  state.failSaveDecided = true;
  await expect(
    processJob(new Gmail(state.account as any), job()),
  ).rejects.toThrow();
  expect(state.label).not.toHaveBeenCalled();
  expect(state.executions.get("m:work:1")?.status).toBe("pending");
});
it("retries completed activity writes without falsely recording a failed Gmail action", async () => {
  state.failCompletedActivity = true;
  const work = job();
  await expect(
    processJob(new Gmail(state.account as any), work),
  ).rejects.toThrow("Activity unavailable");
  expect(state.executions.get("m:work:1")?.status).toBe("complete");
  expect(state.decisions.get("m:work:1")?.outcome).not.toBe("failed");
  await processJob(new Gmail(state.account as any), work);
  expect(state.label).toHaveBeenCalledTimes(1);
  expect(state.decisions.get("m:work:1")?.outcome).toBe("labeled");
  expect(work.status).toBe("complete");
});
it("finishes deleted threads even when message metadata was available", async () => {
  state.thread.mockRejectedValue(new GmailError(404));
  const work = job();
  await processJob(new Gmail(state.account as any), work);
  expect(state.decisions.get("m:work:1")?.reason).toBe("Message deleted");
  expect(work.status).toBe("complete");
});
it("cancels queued work for a paused or deleted rule without classification", async () => {
  state.active = false;
  const work = job();
  await processJob(new Gmail(state.account as any), work);
  expect(state.classify).not.toHaveBeenCalled();
  expect(state.label).not.toHaveBeenCalled();
  expect(state.decisions.get("m:work:1")?.reason).toBe(
    "Rule paused or deleted",
  );
});
it("does not draft for a preexisting manually applied label", async () => {
  state.rules[0].draftReplies = true;
  state.applied.set("m", ["L1"]);
  await processJob(new Gmail(state.account as any), job());
  expect(state.label).not.toHaveBeenCalled();
  expect(
    state.request.mock.calls.some((c) => String(c[0]).startsWith("drafts")),
  ).toBe(false);
  expect(state.decisions.get("m:work:1")?.reason).toBe("Already labeled");
});
it.each([
  new Error("Processing deadline reached"),
  new TypeError("fetch failed"),
])(
  "retries transient context errors rather than dropping the email",
  async (error) => {
    state.fullContext.mockRejectedValue(error);
    const work = job();
    await expect(
      processJob(new Gmail(state.account as any), work),
    ).rejects.toThrow();
    expect(work.status).toBe("pending");
    expect(state.decisions.size).toBe(0);
  },
);

it("does not draft a decline to a newer unclassified reply", async () => {
  state.rules[0].draftReplies = true;
  const thread = () => ({
    id: "t",
    messages: [
      {
        id: "m",
        threadId: "t",
        internalDate: "2",
        labelIds: state.applied.get("m") ?? [],
      },
      {
        id: "new",
        threadId: "t",
        internalDate: "3",
        labelIds: [],
        payload: {
          headers: [
            { name: "from", value: "recruiter@example.com" },
            { name: "message-id", value: "<new@example.com>" },
          ],
        },
      },
    ],
  });
  state.thread.mockImplementation(async () => thread());
  await processJob(new Gmail(state.account as any), job());
  expect(state.label).toHaveBeenCalledWith(["m"], "L1");
  expect(
    state.request.mock.calls.some((c) => String(c[0]).startsWith("drafts")),
  ).toBe(false);
  expect(state.decisions.get("m:work:1")?.draft).toBe("skipped");
});

it.each([false, true])(
  "reserves a draft once across thread messages, including ambiguous delivery: %s",
  async (ambiguous) => {
    state.rules[0].draftReplies = true;
    let arrived = false;
    const makeMessage = (id: string, date: string) => ({
      id,
      threadId: "t",
      internalDate: date,
      labelIds: state.applied.get(id) ?? [],
      payload: {
        headers: [
          { name: "from", value: "recruiter@example.com" },
          { name: "message-id", value: `<${id}@example.com>` },
        ],
      },
    });
    state.thread.mockImplementation(async () => ({
      id: "t",
      messages: [
        makeMessage("m", "1"),
        ...(arrived ? [makeMessage("next", "2")] : []),
      ],
    }));
    state.request.mockImplementation(async (path: string, method?: string) => {
      if (path.startsWith("messages/"))
        return makeMessage(
          path.split("/")[1].split("?")[0],
          arrived ? "2" : "1",
        );
      if (path.startsWith("drafts?")) return { drafts: [] }; // Simulate stale Gmail listing after a successful write.
      if (path === "drafts" && method === "POST") {
        if (ambiguous)
          throw new Error("Response lost after Gmail accepted draft");
        return { id: "draft1" };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await processJob(new Gmail(state.account as any), job());
    expect(state.decisions.get("m:work:1")?.draft).toBe(
      ambiguous ? "unknown" : "created",
    );
    expect(state.intents.get("draftIntents/t").status).toBe(
      ambiguous ? "unknown" : "created",
    );
    arrived = true;
    await processJob(new Gmail(state.account as any), {
      ...job(),
      messageId: "next",
    });
    expect(
      state.request.mock.calls.filter(
        (c) => c[0] === "drafts" && c[1] === "POST",
      ),
    ).toHaveLength(1);
    expect(state.decisions.get("next:work:1")?.draft).toBe("skipped");
  },
);
