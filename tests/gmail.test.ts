import { describe, it, expect, vi } from "vitest";
import { Gmail, findLabel } from "../server/gmail";
import { encrypt, decrypt } from "../server/crypto";
import type { Account, Message } from "../server/types";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_CLIENT_SECRET = "test";
const account = {
  email: "a@example.com",
  clientType: "web",
  refreshToken: encrypt("refresh", "a@example.com"),
} as Account;
describe("Complete thread gate", () => {
  it("reads later messages and truncates oversized context instead of skipping", async () => {
    const gmail = new Gmail(account);
    const bodies = vi
      .spyOn(gmail, "textPart")
      .mockResolvedValueOnce(["x".repeat(200000)])
      .mockResolvedValueOnce(["Please join our engineering team."]);
    const context = await gmail.fullContext({
      id: "t",
      messages: [
        { id: "1", threadId: "t", internalDate: "1", payload: {} },
        { id: "2", threadId: "t", internalDate: "2", payload: {} },
      ],
    });
    expect(bodies).toHaveBeenCalledTimes(2);
    expect(context).toHaveLength(2);
    expect(context[1].bodies[0]).toContain("Please join our engineering team.");
    expect(context[0].truncated).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(180000);
  });
  it("reuses existing Gmail labels for automation search aliases", () => {
    expect(findLabel([{ id: "a", name: "Job Search" }], "job-search")?.id).toBe(
      "a",
    );
    expect(
      findLabel(
        [{ id: "b", name: "🗂 分类 Topics/工作机会 Job Opp" }],
        "🗂-分类-topics-工作机会-job-opp",
      )?.id,
    ).toBe("b");
  });
  it("reads both plain and attachment-backed HTML in all messages", async () => {
    const gmail = new Gmail(account);
    vi.spyOn(gmail, "request").mockResolvedValue({
      data: Buffer.from("<p>Hiring you</p>").toString("base64url"),
    });
    const message: Message = {
      id: "1",
      threadId: "t",
      internalDate: "1",
      payload: {
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("Hello").toString("base64url"), size: 5 },
          },
          { mimeType: "text/html", body: { attachmentId: "html", size: 17 } },
        ],
      },
    };
    const context = await gmail.fullContext({
      id: "t",
      messages: [message, { ...message, id: "2", internalDate: "2" }],
    });
    expect(context).toHaveLength(2);
    expect(context[0].bodies).toEqual(["Hello", "Hiring you"]);
  });
  it("refuses partial or missing message bodies", async () => {
    const gmail = new Gmail(account);
    await expect(
      gmail.fullContext({
        id: "t",
        messages: [
          {
            id: "1",
            threadId: "t",
            internalDate: "1",
            payload: { mimeType: "text/plain", body: { size: 200 } },
          },
        ],
      }),
    ).rejects.toThrow("Complete body unavailable");
  });
  it("adds only a label, leaving UNREAD untouched", async () => {
    const gmail = new Gmail(account);
    const call = vi.spyOn(gmail, "request").mockResolvedValue(undefined);
    await gmail.label(["1"], "Label_1");
    expect(call).toHaveBeenCalledWith("messages/batchModify", "POST", {
      ids: ["1"],
      addLabelIds: ["Label_1"],
    });
  });
});
describe("Credential isolation", () => {
  it("binds encrypted tokens to the mailbox", () => {
    const token = encrypt("secret", "a@example.com");
    expect(decrypt(token, "a@example.com")).toBe("secret");
    expect(() => decrypt(token, "b@example.com")).toThrow();
  });
});
