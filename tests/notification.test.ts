import { it, expect } from "vitest";
import { parseNotification } from "../server/notification";
const encode = (historyId: unknown) =>
  Buffer.from(
    JSON.stringify({ emailAddress: "a@example.com", historyId }),
  ).toString("base64");
it("accepts string and integer history IDs from Gmail", () => {
  expect(parseNotification(encode("123")).historyId).toBe("123");
  expect(parseNotification(encode(123)).historyId).toBe("123");
});
it("rejects lossy or malformed history IDs", () => {
  for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, "1e3", null])
    expect(() => parseNotification(encode(id))).toThrow();
});
