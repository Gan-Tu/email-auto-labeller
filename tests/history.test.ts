import { it, expect } from "vitest";
import { latestActivity } from "../server/activity";
import { filteredHistory, historyPage, mergeHistory } from "../web/src/history";
import type { Decision } from "../server/types";
const record = (
  n: number,
  email = "a@example.com",
  outcome: Decision["outcome"] = "not_recruiting",
): Decision => ({
  messageId: String(n).padStart(5, "0"),
  threadId: "t" + n,
  email,
  subject: "Message " + n,
  outcome,
  createdAt: n,
});
it("merges mailbox histories into exactly the newest 500 records with stable ties", () => {
  const result = latestActivity([
    Array.from({ length: 500 }, (_, i) => record(i * 2)),
    Array.from({ length: 500 }, (_, i) => record(i * 2 + 1, "b@example.com")),
  ]);
  expect(result).toHaveLength(500);
  expect(result[0].createdAt).toBe(999);
  expect(result.at(-1)?.createdAt).toBe(500);
  expect(
    latestActivity([
      [record(1, "z@example.com")],
      [record(1, "a@example.com")],
    ]).map((d) => d.email),
  ).toEqual(["a@example.com", "z@example.com"]);
});
it("paginates to the 500th record without duplicates or missing rows", () => {
  const all = Array.from({ length: 500 }, (_, i) => record(500 - i));
  const pages = Array.from({ length: 20 }, (_, i) => historyPage(all, i + 1));
  expect(pages.flatMap((p) => p.rows)).toEqual(all);
  expect(pages[19]).toMatchObject({
    start: 476,
    end: 500,
    page: 20,
    pageCount: 20,
    total: 500,
  });
  expect(historyPage(all, 99).page).toBe(20);
  expect(historyPage([], 3)).toMatchObject({
    page: 1,
    pageCount: 1,
    start: 0,
    end: 0,
    total: 0,
  });
});
it("filters the entire history window and groups uncertain/skipped under no label applied", () => {
  const all = Array.from({ length: 400 }, (_, i) => record(i));
  all[350] = record(350, "a@example.com", "labeled");
  all[351] = record(351, "a@example.com", "uncertain");
  all[352] = record(352, "a@example.com", "skipped");
  expect(
    historyPage(filteredHistory(all, "applied"), 1).rows.map(
      (d) => d.messageId,
    ),
  ).toEqual(["00350"]);
  expect(filteredHistory(all, "not_applied")).toHaveLength(399);
});
it("merges incremental updates by mailbox and message without discarding older pages", () => {
  const before = Array.from({ length: 500 }, (_, i) => record(500 - i));
  const update = { ...record(499), draft: "created" as const };
  const after = mergeHistory(
    before,
    [update, record(501), record(499, "b@example.com")],
    500,
  );
  expect(after).toHaveLength(500);
  expect(after[0].messageId).toBe("00501");
  expect(
    after.find((d) => d.email === "a@example.com" && d.messageId === "00499")
      ?.draft,
  ).toBe("created");
  expect(after.filter((d) => d.messageId === "00499")).toHaveLength(2);
  expect(after.some((d) => d.messageId === "00001")).toBe(false);
});
