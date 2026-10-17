import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
const state = vi.hoisted(() => ({
  recent: vi.fn(),
  accounts: [
    { email: "first@example.com", owner: "owner@example.com" },
    { email: "second@example.com", owner: "owner@example.com" },
    { email: "private@example.com", owner: "another@example.com" },
  ],
}));
vi.mock("../server/store", () => ({
  listAccounts: async () => state.accounts,
  recentDecisions: state.recent,
  db: { collection: () => ({}) },
  BusyError: class extends Error {},
}));
vi.mock("../server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/auth")>()),
  loadSession: (req: any, _res: any, next: any) => {
    req.session = {
      email: "owner@example.com",
      csrf: "test",
      expiresAt: Date.now() + 10000,
    };
    next();
  },
}));
import { createApp } from "../server/app";
const app = createApp();
beforeEach(() => {
  vi.clearAllMocks();
  state.recent.mockImplementation(async (email: string) =>
    Array.from({ length: 300 }, (_, i) => ({
      email,
      messageId: String(i),
      threadId: String(i),
      createdAt: i,
      subject: "Subject",
      outcome: "not_recruiting",
    })),
  );
});
it("returns the latest 500 only from authorized mailboxes", async () => {
  const r = await request(app).get("/api/activity");
  expect(r.status).toBe(200);
  expect(r.body.decisions).toHaveLength(500);
  expect(r.body.limit).toBe(500);
  expect(r.body.retentionDays).toBe(30);
  expect(r.body.asOf).toBeGreaterThan(0);
  expect(
    r.body.decisions.every((d: any) => d.email !== "private@example.com"),
  ).toBe(true);
  expect(state.recent).toHaveBeenCalledTimes(2);
});
it("loads a full window for the selected inbox and passes the incremental watermark", async () => {
  const r = await request(app)
    .get("/api/activity")
    .query({ inbox: "second@example.com", after: 123 });
  expect(r.status).toBe(200);
  expect(
    r.body.decisions.every((d: any) => d.email === "second@example.com"),
  ).toBe(true);
  expect(state.recent).toHaveBeenCalledOnce();
  expect(state.recent).toHaveBeenCalledWith("second@example.com", {
    limit: 500,
    completedAfter: 123,
  });
});
it("rejects another mailbox and malformed cursors before querying history", async () => {
  expect(
    (
      await request(app)
        .get("/api/activity")
        .query({ inbox: "private@example.com" })
    ).status,
  ).toBe(404);
  for (const after of ["not-a-number", "-1", "1.5"])
    expect(
      (await request(app).get("/api/activity").query({ after })).status,
    ).toBe(400);
  expect(state.recent).not.toHaveBeenCalled();
});
