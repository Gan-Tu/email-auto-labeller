import { beforeEach, afterEach, it, expect, vi } from "vitest";
import request from "supertest";
import { OAuth2Client } from "google-auth-library";
const state = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  account: undefined as any,
}));
vi.mock("../server/store", () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        key: `${name}/${id}`,
        create: async (value: any) => state.docs.set(`${name}/${id}`, value),
        delete: async () => state.docs.delete(`${name}/${id}`),
      }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          const snapshot = state.docs.get(ref.key);
          return { data: () => snapshot };
        },
        delete: (ref: any) => state.docs.delete(ref.key),
      }),
  },
  getAccount: async () => state.account,
  accountRef: () => ({
    set: async (value: any) => {
      state.account = value;
    },
    update: async (value: any) => Object.assign(state.account, value),
  }),
  withAccountLock: async (_email: string, fn: any) => fn(),
  listAccounts: async () => [],
  recentDecisions: async () => [],
  BusyError: class extends Error {},
}));
vi.mock("../server/gmail", () => ({
  Gmail: class {
    profile = async () => ({
      emailAddress: "owner@example.com",
      historyId: "123",
    });
    watch = async () => ({ expiration: String(Date.now() + 86400000) });
  },
}));
import { createApp } from "../server/app";
import { config } from "../server/config";
import { verifyService } from "../server/auth";
const app = createApp();
const origins = [
  "https://labels.example.com",
  "https://email-auto-labeller-example.us-central1.run.app",
];
const saved = [...config.appOrigins];
beforeEach(() => {
  state.docs.clear();
  state.account = {
    email: "owner@example.com",
    owner: "owner@example.com",
    clientType: "web",
    enabled: true,
    label: "Job Recruiting",
    threshold: 0.9,
    draftReplies: false,
    classificationPrompt: "Only label invitations to staff engineering roles.",
    historyId: "100",
  };
  config.appOrigins = origins;
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  config.appOrigins = saved;
  vi.restoreAllMocks();
});
const start = async (origin: string) => {
  const disclosure = await request(app)
    .get("/auth/google")
    .set("Host", new URL(origin).host)
    .set("X-Forwarded-Proto", "https");
  const token = disclosure.text.match(
    /name="consentToken" value="([a-f0-9]+)"/,
  )?.[1];
  return request(app)
    .post("/auth/google")
    .set("Host", new URL(origin).host)
    .set("X-Forwarded-Proto", "https")
    .set("Origin", origin)
    .set("Cookie", disclosure.headers["set-cookie"][0].split(";")[0])
    .type("form")
    .send({ consentToken: token, dataSharingConsent: "yes" });
};
const oauthCookie = (response: any) =>
  response.headers["set-cookie"]
    .find((value: string) => value.startsWith("oauth="))
    .split(";")[0];
it.each(origins)(
  "binds OAuth to its starting origin and preserves the custom prompt: %s",
  async (origin) => {
    const first = await start(origin);
    expect(first.status).toBe(302);
    const url = new URL(first.headers.location);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/google/callback`,
    );
    const transaction = [...state.docs.values()][0];
    const exchange = vi
      .spyOn(OAuth2Client.prototype, "getToken")
      .mockResolvedValue({
        tokens: {
          id_token: "test-id",
          refresh_token: "test-refresh",
          scope: "openid email https://www.googleapis.com/auth/gmail.modify",
        },
      } as any);
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: "owner@example.com",
        email_verified: true,
        nonce: transaction.nonce,
        name: "Test User",
      }),
    } as any);
    const callback = await request(app)
      .get("/auth/google/callback")
      .set("Host", new URL(origin).host)
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", oauthCookie(first))
      .query({ state: url.searchParams.get("state"), code: "test-code" });
    expect(callback.headers.location).toBe("/?connected=1");
    expect(exchange).toHaveBeenCalledWith({
      code: "test-code",
      codeVerifier: transaction.verifier,
    });
    expect(state.account.classificationPrompt).toBe(
      "Only label invitations to staff engineering roles.",
    );
    expect(state.account).not.toHaveProperty("openaiRouting");
    expect(state.account.dataConsentVersion).toBe("2026-10-21");
    expect(state.account.dataConsentAt).toBeGreaterThan(0);
    expect(
      [...state.docs.keys()].filter((k) => k.startsWith("oauth/")),
    ).toHaveLength(0);
  },
);
it("rejects a callback on another host before exchanging the authorization code", async () => {
  const first = await start(origins[0]);
  const url = new URL(first.headers.location);
  const exchange = vi.spyOn(OAuth2Client.prototype, "getToken");
  const r = await request(app)
    .get("/auth/google/callback")
    .set("Host", new URL(origins[1]).host)
    .set("X-Forwarded-Proto", "https")
    .set("Cookie", oauthCookie(first))
    .query({ state: url.searchParams.get("state"), code: "test-code" });
  expect(r.headers.location).toBe("/?error=connection_failed");
  expect(exchange).not.toHaveBeenCalled();
});
it("keeps machine-to-machine authentication bound to both approved audiences and the expected identity", async () => {
  const verify = vi
    .spyOn(OAuth2Client.prototype, "verifyIdToken")
    .mockResolvedValue({
      getPayload: () => ({ email: "push@example.com", email_verified: true }),
    } as any);
  const req = { get: () => "Bearer test-token" } as any;
  expect(await verifyService(req, "push@example.com")).toBe(true);
  expect(verify).toHaveBeenCalledWith({
    idToken: "test-token",
    audience: origins,
  });
  expect(await verifyService(req, "wrong@example.com")).toBe(false);
  expect(
    await verifyService(req, ["old@example.com", "push@example.com"]),
  ).toBe(true);
  expect(await verifyService(req, [])).toBe(false);
});

it("requires a prominent data-sharing disclosure before OAuth", async () => {
  const r = await request(app)
    .get("/auth/google")
    .set("Host", new URL(origins[0]).host)
    .set("X-Forwarded-Proto", "https");
  expect(r.status).toBe(200);
  expect(r.text).toContain("What is shared with OpenAI");
  expect(r.headers["referrer-policy"]).toBe("same-origin");
  expect(r.text).toContain('name="dataSharingConsent" value="yes" required');
  expect(r.text).toContain('href="/privacy"');
  expect(state.docs.size).toBe(0);
});
it.each([{}, { consentToken: "a".repeat(64), dataSharingConsent: "yes" }])(
  "rejects direct or forged consent submissions",
  async (body) => {
    const r = await request(app)
      .post("/auth/google")
      .set("Host", new URL(origins[0]).host)
      .set("X-Forwarded-Proto", "https")
      .set("Origin", origins[0])
      .type("form")
      .send(body);
    expect(r.status).toBe(400);
    expect(state.docs.size).toBe(0);
  },
);
it("rejects cross-origin disclosure submissions", async () => {
  const disclosure = await request(app)
    .get("/auth/google")
    .set("Host", new URL(origins[0]).host)
    .set("X-Forwarded-Proto", "https");
  const token = disclosure.text.match(
    /name="consentToken" value="([a-f0-9]+)"/,
  )?.[1];
  const r = await request(app)
    .post("/auth/google")
    .set("Host", new URL(origins[0]).host)
    .set("X-Forwarded-Proto", "https")
    .set("Origin", "https://untrusted.example")
    .set("Cookie", disclosure.headers["set-cookie"][0].split(";")[0])
    .type("form")
    .send({ consentToken: token, dataSharingConsent: "yes" });
  expect(r.status).toBe(400);
  expect(state.docs.size).toBe(0);
});
