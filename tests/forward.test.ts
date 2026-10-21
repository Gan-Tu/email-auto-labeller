import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gmail, GmailError } from "../server/gmail";
import type { Message } from "../server/types";
const state = vi.hoisted(() => ({
  intents: new Map<string, any>(),
  failSentSave: false,
}));
vi.mock("../server/store", () => ({
  accountRef: (email: string) => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        key: `${email}/${name}/${id}`,
        set: async (data: any) => {
          if (data.status === "sent" && state.failSentSave)
            throw new Error("Storage unavailable");
          state.intents.set(`${email}/${name}/${id}`, {
            ...state.intents.get(`${email}/${name}/${id}`),
            ...data,
          });
        },
      }),
    }),
  }),
  db: {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => ({ data: () => state.intents.get(ref.key) }),
        set: (ref: any, data: any) => state.intents.set(ref.key, data),
      }),
  },
}));
import { forwardMessage } from "../server/forward";
const original = Buffer.from(
  'From: sender@example.com\r\nContent-Type: multipart/mixed; boundary="abc"\r\n\r\n--abc\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQ=\r\n--abc--\r\n',
);
const message = (): Message => ({
  id: "incoming",
  threadId: "thread",
  internalDate: "1",
  payload: {
    headers: [
      { name: "from", value: "Sender <sender@example.com>" },
      { name: "subject", value: "Hello 世界\r\nBcc: bad@example.com" },
    ],
  },
});
function client() {
  const request = vi.fn(async (path: string) =>
    path.endsWith("format=raw")
      ? { raw: original.toString("base64url") }
      : { id: "sent-id" },
  );
  return {
    account: { email: "owner@example.com" },
    request,
    textPart: vi.fn().mockResolvedValue(["Readable body"]),
  } as unknown as Gmail;
}
beforeEach(() => {
  state.intents.clear();
  state.failSentSave = false;
});
describe("forwarding transport", () => {
  it("sends readable content and byte-identical original MIME with attachments", async () => {
    const gmail = client();
    expect(
      await forwardMessage(gmail, message(), "Destination@Example.com"),
    ).toEqual({ status: "sent", messageId: "sent-id" });
    const call = vi
      .mocked(gmail.request)
      .mock.calls.find(([path]) => path === "messages/send")!;
    const raw = Buffer.from((call[2] as any).raw, "base64url").toString();
    expect(raw).toContain("To: destination@example.com\r\n");
    expect(raw).toContain(
      "Auto-Submitted: auto-generated\r\nX-Email-Auto-Labeller-Forwarded: yes",
    );
    expect(raw).not.toContain("\r\nBcc:");
    const attachment = raw
      .split('Content-Disposition: attachment; filename="original.eml"')[1]
      .split("\r\n\r\n")[1]
      .split("\r\n--")[0];
    expect(Buffer.from(attachment, "base64")).toEqual(original);
    const summary = raw
      .split("Content-Transfer-Encoding: base64\r\n\r\n")[1]
      .split("\r\n--")[0];
    expect(Buffer.from(summary, "base64").toString()).toContain(
      "Readable body",
    );
  });
  it.each([
    "x@example.com\r\nBcc: bad@example.com",
    "a@example.com,b@example.com",
    "invalid",
    "Name <x@example.com>",
  ])("rejects invalid destination %s without API calls", async (to) => {
    const gmail = client();
    await expect(forwardMessage(gmail, message(), to)).rejects.toThrow(
      "Invalid forwarding",
    );
    expect(gmail.request).not.toHaveBeenCalled();
  });
  it.each(["owner@example.com", "sender@example.com"])(
    "skips forwarding loops to %s",
    async (to) => {
      const gmail = client();
      expect((await forwardMessage(gmail, message(), to)).status).toBe(
        "skipped",
      );
      expect(gmail.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["X-Email-Auto-Labeller-Forwarded", "yes"],
    ["From", "Owner <owner@example.com>"],
  ])("skips loop-indicating header %s", async (name, value) => {
    const gmail = client(),
      m = message();
    m.payload!.headers = [{ name, value }];
    expect(
      (await forwardMessage(gmail, m, "destination@example.com")).status,
    ).toBe("skipped");
    expect(gmail.request).not.toHaveBeenCalled();
  });
  it("forwards automated invoices when explicitly configured", async () => {
    const gmail = client(),
      invoice = message();
    invoice.payload!.headers!.push({
      name: "Auto-Submitted",
      value: "auto-generated",
    });
    expect(
      (await forwardMessage(gmail, invoice, "destination@example.com")).status,
    ).toBe("sent");
  });
  it("deduplicates repeated calls but permits different destinations", async () => {
    const gmail = client();
    await forwardMessage(gmail, message(), "destination@example.com");
    expect(
      await forwardMessage(gmail, message(), "DESTINATION@example.com"),
    ).toMatchObject({ status: "skipped", reason: "Already forwarded" });
    await forwardMessage(gmail, message(), "other@example.com");
    expect(
      vi
        .mocked(gmail.request)
        .mock.calls.filter(([p]) => p === "messages/send"),
    ).toHaveLength(2);
  });
  it.each([
    new Error("response lost"),
    new GmailError(500),
    new GmailError(408),
  ])("never retries ambiguous delivery", async (error) => {
    const gmail = client();
    vi.mocked(gmail.request).mockImplementation(async (path) => {
      if (path.endsWith("format=raw"))
        return { raw: original.toString("base64url") } as any;
      throw error;
    });
    expect(
      (await forwardMessage(gmail, message(), "destination@example.com"))
        .status,
    ).toBe("unknown");
    expect(
      (await forwardMessage(gmail, message(), "destination@example.com"))
        .status,
    ).toBe("unknown");
    expect(
      vi
        .mocked(gmail.request)
        .mock.calls.filter(([p]) => p === "messages/send"),
    ).toHaveLength(1);
  });
  it("allows retry after explicit Gmail rejection", async () => {
    const gmail = client();
    vi.mocked(gmail.request)
      .mockResolvedValueOnce({ raw: original.toString("base64url") })
      .mockRejectedValueOnce(new GmailError(429));
    await expect(
      forwardMessage(gmail, message(), "destination@example.com"),
    ).rejects.toBeInstanceOf(GmailError);
    expect(
      (await forwardMessage(gmail, message(), "destination@example.com"))
        .status,
    ).toBe("sent");
  });
  it("never resends if the sent-state write fails", async () => {
    const gmail = client();
    state.failSentSave = true;
    await expect(
      forwardMessage(gmail, message(), "destination@example.com"),
    ).rejects.toThrow("Storage unavailable");
    state.failSentSave = false;
    expect(
      (await forwardMessage(gmail, message(), "destination@example.com"))
        .status,
    ).toBe("unknown");
    expect(
      vi
        .mocked(gmail.request)
        .mock.calls.filter(([p]) => p === "messages/send"),
    ).toHaveLength(1);
  });
  it("does not reserve intent when reading original fails", async () => {
    const gmail = client();
    vi.mocked(gmail.request).mockRejectedValueOnce(new Error("network"));
    await expect(
      forwardMessage(gmail, message(), "destination@example.com"),
    ).rejects.toThrow("network");
    expect(state.intents.size).toBe(0);
  });
});
it("markRead only removes UNREAD, batching Gmail limits", async () => {
  const gmail = client();
  await Gmail.prototype.markRead.call(
    gmail,
    Array.from({ length: 1001 }, (_, i) => String(i)),
  );
  expect(vi.mocked(gmail.request).mock.calls).toHaveLength(2);
  expect(vi.mocked(gmail.request).mock.calls[1]).toEqual([
    "messages/batchModify",
    "POST",
    { ids: ["1000"], removeLabelIds: ["UNREAD"] },
  ]);
});
