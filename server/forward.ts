import { createHash, randomUUID } from "node:crypto";
import { Gmail, GmailContentError, GmailError, header } from "./gmail.js";
import { accountRef, db } from "./store.js";
import type { Message } from "./types.js";

export interface ForwardResult {
  status: "sent" | "skipped" | "unknown";
  reason?: string;
  messageId?: string;
}
const address = (value: string) =>
  (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
const validAddress = (value: string) =>
  value.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(
    value,
  );
const clean = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]/g, " ");
const base64Lines = (value: Buffer) =>
  value
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") ?? "";

/** One delivery attempt per incoming message and destination, shared across rules and versions. */
export async function forwardMessage(
  gmail: Gmail,
  message: Message,
  destination: string,
): Promise<ForwardResult> {
  const to = destination.trim().toLowerCase();
  if (!validAddress(to)) throw new Error("Invalid forwarding email address");
  const sender = address(header(message, "from"));
  const own = gmail.account.email.toLowerCase();
  if (to === own || to === sender || sender === own)
    return {
      status: "skipped",
      reason: "Forwarding to self or original sender is disabled",
    };
  if (
    message.labelIds?.some((id) =>
      ["SENT", "DRAFT", "SPAM", "TRASH"].includes(id),
    ) ||
    header(message, "x-email-auto-labeller-forwarded")
  )
    return {
      status: "skipped",
      reason: "Excluded or previously forwarded message",
    };

  // Read content before reserving: a failed read cannot have sent anything and is safe to retry.
  const original = await gmail.request<{ raw?: string }>(
    `messages/${encodeURIComponent(message.id)}?format=raw`,
  );
  if (!original.raw)
    throw new GmailContentError("Original message unavailable for forwarding");
  const originalBytes = Buffer.from(original.raw, "base64url");
  const body = message.payload
    ? (await gmail.textPart(message.id, message.payload)).join("\n\n")
    : "";
  const summary = [
    "---------- Forwarded message ----------",
    `From: ${clean(header(message, "from"))}`,
    `Date: ${clean(header(message, "date"))}`,
    `Subject: ${clean(header(message, "subject"))}`,
    `To: ${clean(header(message, "to"))}`,
    "",
    body,
    "",
    "The original email, including attachments, is attached as original.eml.",
  ].join("\n");
  const boundary = `forward_${randomUUID()}`;
  const subject = clean(header(message, "subject"));
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(/^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`).toString("base64")}?=`,
    "Auto-Submitted: auto-generated",
    "X-Email-Auto-Labeller-Forwarded: yes",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(summary)),
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="original.eml"',
    'Content-Disposition: attachment; filename="original.eml"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(originalBytes),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const key = createHash("sha256")
    .update(JSON.stringify([message.id, to]))
    .digest("hex");
  const intent = accountRef(own).collection("forwardIntents").doc(key);
  const existing = await db.runTransaction(async (tx) => {
    const previous = (await tx.get(intent)).data();
    if (previous && previous.status !== "rejected") return previous;
    tx.set(intent, {
      status: "pending",
      messageId: message.id,
      destination: to,
      createdAt: Date.now(),
    });
    return undefined;
  });
  if (existing)
    return existing.status === "sent"
      ? {
          status: "skipped",
          reason: "Already forwarded",
          messageId: existing.sentMessageId,
        }
      : {
          status: "unknown",
          reason: "Previous forwarding delivery is uncertain; not resent",
        };

  let sent: { id: string };
  try {
    sent = await gmail.request<{ id: string }>("messages/send", "POST", {
      raw: Buffer.from(raw).toString("base64url"),
    });
  } catch (error) {
    // An explicit rejection cannot have delivered the message. Timeouts and server errors are ambiguous.
    if (
      error instanceof GmailError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      await intent.set({ status: "rejected" }, { merge: true });
      throw error;
    }
    await intent.set({ status: "unknown" }, { merge: true });
    return {
      status: "unknown",
      reason: "Forwarding delivery could not be confirmed; not resent",
    };
  }
  // A failed persistence write leaves pending in place, preventing an unsafe second send.
  await intent.set({ status: "sent", sentMessageId: sent.id }, { merge: true });
  return { status: "sent", messageId: sent.id };
}
