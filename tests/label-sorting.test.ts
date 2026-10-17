import { describe, expect, it } from "vitest";
import { sortLabels } from "../web/src/labels";
import type { GmailLabel } from "../web/src/api";

const label = (name: string, id: string): GmailLabel => ({
  id,
  name,
  type: "user",
});

describe("Gmail label ordering", () => {
  it("keeps pinned folders first and their children together in natural date order", () => {
    const shuffled = [
      label("Holiday/2026-10", "id-a"),
      label("!Travel/Trip 10", "id-b"),
      label("Work", "id-c"),
      label("Holiday/2026-02", "id-d"),
      label("!Travel", "id-e"),
      label("Holiday/2026-2/Day 10", "id-f"),
      label("!Pinned", "id-g"),
      label("!Travel/Trip 2", "id-h"),
      label("Holiday", "id-i"),
      label("Holiday/2026-2/Day 2", "id-j"),
    ];
    expect(sortLabels(shuffled).map((item) => item.name)).toEqual([
      "!Pinned",
      "!Travel",
      "!Travel/Trip 2",
      "!Travel/Trip 10",
      "Holiday",
      "Holiday/2026-02",
      "Holiday/2026-2/Day 2",
      "Holiday/2026-2/Day 10",
      "Holiday/2026-10",
      "Work",
    ]);
  });

  it("orders emoji-decorated labels by their text while preserving selected identity and input order", () => {
    const shuffled = Object.freeze([
      Object.freeze(label("🧳 Travel/2026-10", "selected-id")),
      Object.freeze(label("📁 Archive", "archive-id")),
      Object.freeze(label("🧳 Travel", "travel-id")),
      Object.freeze(label("🧳 Travel/2026-2", "trip-two-id")),
      Object.freeze(label("📌 !Pinned", "pinned-id")),
      Object.freeze(label("Bills", "bills-id")),
    ]);
    const sorted = sortLabels(shuffled);
    expect(sorted.map((item) => item.name)).toEqual([
      "📌 !Pinned",
      "📁 Archive",
      "Bills",
      "🧳 Travel",
      "🧳 Travel/2026-2",
      "🧳 Travel/2026-10",
    ]);
    expect(sorted.find((item) => item.id === "selected-id")).toBe(shuffled[0]);
    expect(shuffled[0].name).toBe("🧳 Travel/2026-10");
  });

  it("uses stable IDs for equivalent names instead of retaining random API order", () => {
    const labels = [label("Receipts", "id-z"), label("receipts", "id-a")];
    expect(sortLabels(labels).map((item) => item.id)).toEqual(["id-a", "id-z"]);
    expect(sortLabels([...labels].reverse()).map((item) => item.id)).toEqual([
      "id-a",
      "id-z",
    ]);
  });
});
