import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { config } from "../server/config";
import {
  Gmail,
  resolveGmailClient,
  usesCurrentWebClient,
} from "../server/gmail";
import { encrypt } from "../server/crypto";
import type { Account } from "../server/types";
const env = {
  GOOGLE_CLIENT_ID: "current-client",
  GOOGLE_CLIENT_SECRET: "current-test-secret",
  PREVIOUS_WEB_GOOGLE_CLIENT_ID: "previous-client",
  PREVIOUS_WEB_GOOGLE_CLIENT_SECRET: "previous-test-secret",
  LEGACY_GOOGLE_CLIENT_ID: "legacy-client",
  LEGACY_GOOGLE_CLIENT_SECRET: "legacy-test-secret",
};
const topics = {
  topic: "projects/new-project/topics/gmail",
  previousWebTopic: "projects/old-project/topics/web-gmail",
  legacyTopic: "projects/old-project/topics/legacy-gmail",
};
const savedTopics = {
  topic: config.topic,
  previousWebTopic: config.previousWebTopic,
  legacyTopic: config.legacyTopic,
};
beforeEach(() => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  Object.assign(config, topics);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.assign(config, savedTopics);
});
describe("Per-mailbox OAuth transition", () => {
  it("supports retiring both migration clients without changing current mailbox routing", () => {
    const currentOnly = {
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    };
    const currentTopics = {
      topic: topics.topic,
      previousWebTopic: "",
      legacyTopic: "",
    };
    expect(
      resolveGmailClient(
        { clientType: "web", oauthClientId: "current-client" },
        currentOnly,
        currentTopics,
      ),
    ).toEqual({
      kind: "current",
      clientId: "current-client",
      clientSecret: "current-test-secret",
      topic: topics.topic,
    });
    expect(() =>
      resolveGmailClient(
        { clientType: "web", oauthClientId: "previous-client" },
        currentOnly,
        currentTopics,
      ),
    ).toThrow("Reconnect Gmail");
    expect(() =>
      resolveGmailClient({ clientType: "legacy" }, currentOnly, currentTopics),
    ).toThrow("Missing configuration: LEGACY_GOOGLE_CLIENT_ID");
  });

  it.each([
    [
      { clientType: "web", oauthClientId: "current-client" },
      "current",
      "current-client",
      topics.topic,
    ],
    [
      { clientType: "web", oauthClientId: "previous-client" },
      "previous",
      "previous-client",
      topics.previousWebTopic,
    ],
    [
      { clientType: "web" },
      "previous",
      "previous-client",
      topics.previousWebTopic,
    ],
    [{ clientType: "legacy" }, "legacy", "legacy-client", topics.legacyTopic],
  ] as const)(
    "keeps refresh credentials and watch topic together for %o",
    (account, kind, clientId, topic) => {
      expect(resolveGmailClient(account, env, topics)).toMatchObject({
        kind,
        clientId,
        topic,
      });
    },
  );
  it("keeps the existing missing-ID behavior when no previous client is configured", () => {
    const {
      PREVIOUS_WEB_GOOGLE_CLIENT_ID,
      PREVIOUS_WEB_GOOGLE_CLIENT_SECRET,
      ...currentOnly
    } = env;
    expect(
      resolveGmailClient({ clientType: "web" }, currentOnly, topics),
    ).toMatchObject({ kind: "current", topic: topics.topic });
  });
  it.each(["unknown-client", ""])(
    "fails closed for an unknown explicit OAuth client: %s",
    (oauthClientId) => {
      expect(() =>
        resolveGmailClient({ clientType: "web", oauthClientId }, env, topics),
      ).toThrow("OAuth client is not configured");
    },
  );
  it("never silently falls back for incomplete previous credentials or a missing previous topic", () => {
    expect(() =>
      resolveGmailClient(
        { clientType: "web" },
        { ...env, PREVIOUS_WEB_GOOGLE_CLIENT_SECRET: "" },
        topics,
      ),
    ).toThrow("configured together");
    expect(() =>
      resolveGmailClient({ clientType: "web" }, env, {
        ...topics,
        previousWebTopic: "",
      }),
    ).toThrow("topic is not configured");
  });
  it("uses the documented legacy topic fallback chain", () => {
    expect(
      resolveGmailClient({ clientType: "legacy" }, env, {
        ...topics,
        legacyTopic: "",
      }).topic,
    ).toBe(topics.previousWebTopic);
    expect(
      resolveGmailClient({ clientType: "legacy" }, env, {
        ...topics,
        legacyTopic: "",
        previousWebTopic: "",
      }).topic,
    ).toBe(topics.topic);
  });
  it("reports whether an existing refresh token belongs to the current web client", () => {
    expect(
      usesCurrentWebClient({
        clientType: "web",
        oauthClientId: env.GOOGLE_CLIENT_ID,
      }),
    ).toBe(true);
    expect(
      usesCurrentWebClient({
        clientType: "web",
        oauthClientId: env.PREVIOUS_WEB_GOOGLE_CLIENT_ID,
      }),
    ).toBe(false);
    expect(usesCurrentWebClient({ clientType: "web" })).toBe(false);
    expect(usesCurrentWebClient({ clientType: "legacy" })).toBe(false);
  });
  it.each([
    ["current-client", "current-test-secret", topics.topic],
    ["previous-client", "previous-test-secret", topics.previousWebTopic],
    [undefined, "previous-test-secret", topics.previousWebTopic],
  ])(
    "refreshes and watches using the account's selected client: %s",
    async (oauthClientId, clientSecret, topic) => {
      const account = {
        email: "owner@example.com",
        clientType: "web",
        oauthClientId,
        refreshToken: encrypt("stored-refresh-token", "owner@example.com"),
      } as Account;
      const getAccessToken = vi
        .spyOn(OAuth2Client.prototype, "getAccessToken")
        .mockResolvedValue({ token: "test-access-token", res: null });
      const request = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ historyId: "100", expiration: "999999" }),
          ),
        );
      const gmail = new Gmail(account);
      expect((gmail.auth as any)._clientId).toBe(
        oauthClientId ?? "previous-client",
      );
      expect((gmail.auth as any)._clientSecret).toBe(clientSecret);
      expect(gmail.auth.credentials.refresh_token).toBe("stored-refresh-token");
      await gmail.watch();
      expect(getAccessToken).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(request.mock.calls[0][1]!.body as string).topicName,
      ).toBe(topic);
    },
  );
});
