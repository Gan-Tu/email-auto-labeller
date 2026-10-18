import { OAuth2Client } from "google-auth-library";
import { convert } from "html-to-text";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import type { Account, GmailPart, Label, Message, Thread } from "./types.js";
import { fitThreadContext } from "./context.js";
export class GmailContentError extends Error {}
export class GmailError extends Error {
  constructor(public status: number) {
    super(`Gmail request failed (${status})`);
  }
}
export const header = (m: Message, name: string) =>
  m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
const canonicalLabel = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export const findLabel = (labels: Label[], name: string) =>
  labels.find((l) => l.type !== "system" && l.name === name) ??
  labels.find(
    (l) =>
      l.type !== "system" && canonicalLabel(l.name) === canonicalLabel(name),
  );
type GmailTopics = Pick<
  typeof config,
  "topic" | "previousWebTopic" | "legacyTopic"
>;
interface GmailClientConfiguration {
  kind: "current" | "previous" | "legacy";
  clientId: string;
  clientSecret: string;
  topic: string;
}
/** Resolve both token-refresh credentials and the Gmail watch topic as one immutable pair. */
export function resolveGmailClient(
  account: Pick<Account, "clientType" | "oauthClientId">,
  env: NodeJS.ProcessEnv = process.env,
  topics: GmailTopics = config,
): GmailClientConfiguration {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  };
  if (account.clientType === "legacy")
    return {
      kind: "legacy",
      clientId: required("LEGACY_GOOGLE_CLIENT_ID"),
      clientSecret: required("LEGACY_GOOGLE_CLIENT_SECRET"),
      topic: topics.legacyTopic || topics.previousWebTopic || topics.topic,
    };
  const currentId = required("GOOGLE_CLIENT_ID");
  const previousId = env.PREVIOUS_WEB_GOOGLE_CLIENT_ID?.trim();
  const previousSecret = env.PREVIOUS_WEB_GOOGLE_CLIENT_SECRET?.trim();
  if (!!previousId !== !!previousSecret)
    throw new Error(
      "Previous web OAuth client ID and secret must be configured together",
    );
  if (
    account.oauthClientId === currentId ||
    (account.oauthClientId === undefined && !previousId)
  )
    return {
      kind: "current",
      clientId: currentId,
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      topic: topics.topic,
    };
  if (
    previousId &&
    (account.oauthClientId === undefined ||
      account.oauthClientId === previousId)
  ) {
    if (!topics.previousWebTopic)
      throw new Error("Previous web Gmail topic is not configured");
    return {
      kind: "previous",
      clientId: previousId,
      clientSecret: previousSecret!,
      topic: topics.previousWebTopic,
    };
  }
  throw new Error(
    "Reconnect Gmail: this account's OAuth client is not configured",
  );
}
export function usesCurrentWebClient(
  account: Pick<Account, "clientType" | "oauthClientId">,
): boolean {
  return (
    account.clientType === "web" &&
    resolveGmailClient(account).kind === "current"
  );
}
export class Gmail {
  auth: OAuth2Client;
  deadline?: number;
  readonly topic: string;
  constructor(public account: Account) {
    const client = resolveGmailClient(account);
    this.topic = client.topic;
    this.auth = new OAuth2Client(client.clientId, client.clientSecret);
    this.auth.setCredentials({
      refresh_token: decrypt(account.refreshToken, account.email),
    });
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (this.deadline && this.deadline - Date.now() <= 1000)
      throw new Error("Processing deadline reached");
    let token: string | null | undefined;
    try {
      token = (await this.auth.getAccessToken()).token;
    } catch {
      throw new GmailError(401);
    }
    if (this.deadline && this.deadline - Date.now() <= 1000)
      throw new Error("Processing deadline reached");
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(30000, this.deadline ? this.deadline - Date.now() : 30000),
          ),
        ),
      },
    );
    if (!r.ok) throw new GmailError(r.status);
    return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
  }
  profile() {
    return this.request<{ emailAddress: string; historyId: string }>("profile");
  }
  async labels() {
    return (await this.request<{ labels: Label[] }>("labels")).labels ?? [];
  }
  thread(id: string) {
    return this.request<Thread>(
      `threads/${encodeURIComponent(id)}?format=full`,
    );
  }
  watch() {
    return this.request<{ historyId: string; expiration: string }>(
      "watch",
      "POST",
      {
        topicName: this.topic,
        labelFilterBehavior: "exclude",
        labelIds: ["SPAM", "TRASH"],
      },
    );
  }
  async ensureLabel(name: string, labels: Label[]) {
    const existing = findLabel(labels, name);
    if (existing) return existing;
    try {
      return await this.request<Label>("labels", "POST", {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      });
    } catch (error) {
      if (error instanceof GmailError && error.status === 409) {
        const found = findLabel(await this.labels(), name);
        if (found) return found;
      }
      throw error;
    }
  }
  async label(ids: string[], labelId: string) {
    for (let i = 0; i < ids.length; i += 1000)
      await this.request("messages/batchModify", "POST", {
        ids: ids.slice(i, i + 1000),
        addLabelIds: [labelId],
      });
  }
  async textPart(messageId: string, part: GmailPart): Promise<string[]> {
    const texts: string[] = [];
    if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
      let data = part.body?.data;
      if (part.body?.attachmentId)
        data = (
          await this.request<{ data: string }>(
            `messages/${messageId}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
          )
        ).data;
      if (!data && (part.body?.size ?? 0) > 0)
        throw new GmailContentError("Complete body unavailable");
      if (data) {
        const bytes = Buffer.from(data, "base64url");
        if (part.body?.size && bytes.length !== part.body.size)
          throw new GmailContentError("Complete body unavailable");
        const contentType =
          part.headers?.find((h) => h.name?.toLowerCase() === "content-type")
            ?.value ?? "";
        const charset =
          contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
        let text: string;
        try {
          text = new TextDecoder(charset, { fatal: true }).decode(bytes);
        } catch {
          throw new GmailContentError(
            "Unsupported or invalid message encoding",
          );
        }
        texts.push(
          part.mimeType === "text/html"
            ? convert(text, {
                wordwrap: false,
                selectors: [
                  { selector: "script", format: "skip" },
                  { selector: "style", format: "skip" },
                  { selector: "img", format: "skip" },
                ],
              })
            : text,
        );
      }
    }
    for (const child of part.parts ?? [])
      texts.push(...(await this.textPart(messageId, child)));
    return texts;
  }
  async fullContext(thread: Thread, incomingMessageId?: string) {
    if (!thread.messages?.length)
      throw new GmailContentError("Complete body unavailable");
    const messages = [];
    for (const m of [...thread.messages].sort(
      (a, b) => Number(a.internalDate) - Number(b.internalDate),
    )) {
      if (!m.payload) throw new GmailContentError("Complete body unavailable");
      const bodies = await this.textPart(m.id, m.payload);
      if (!bodies.some((t) => t.trim()))
        throw new GmailContentError("Complete body unavailable");
      const item = {
        id: m.id,
        threadId: m.threadId,
        internalDate: m.internalDate,
        from: header(m, "from"),
        to: header(m, "to"),
        subject: header(m, "subject"),
        date: header(m, "date"),
        bodies,
      };
      messages.push(item);
    }
    return fitThreadContext(messages, 180000, incomingMessageId);
  }
}
