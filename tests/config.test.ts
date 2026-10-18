import { describe, it, expect } from "vitest";
import { loadConfig } from "../server/config";
const production = {
  NODE_ENV: "production",
  OWNER_EMAIL: "owner@example.com",
  ALLOWED_EMAILS: "owner@example.com,inbox@example.com",
  BASE_URL: "https://labels.example.com",
  GOOGLE_CLOUD_PROJECT: "example-project",
  FIRESTORE_DATABASE: "email-auto-labeller",
  GMAIL_TOPIC: "projects/example-project/topics/gmail",
  PUSH_SERVICE_ACCOUNT: "push@example-project.iam.gserviceaccount.com",
  SCHEDULER_SERVICE_ACCOUNT: "jobs@example-project.iam.gserviceaccount.com",
};
describe("Explicit production configuration", () => {
  it.each([
    "OWNER_EMAIL",
    "ALLOWED_EMAILS",
    "BASE_URL",
    "GOOGLE_CLOUD_PROJECT",
    "FIRESTORE_DATABASE",
    "GMAIL_TOPIC",
    "PUSH_SERVICE_ACCOUNT",
    "SCHEDULER_SERVICE_ACCOUNT",
  ])("fails closed when %s is absent", (key) => {
    expect(() => loadConfig({ ...production, [key]: "" })).toThrow(
      `Missing configuration: ${key}`,
    );
  });
  it("normalizes explicit identities and requires the owner in the allowlist", () => {
    expect(
      loadConfig({
        ...production,
        OWNER_EMAIL: "OWNER@example.com",
        ALLOWED_EMAILS:
          " OWNER@example.com, inbox@example.com,owner@example.com ",
      }).allowed,
    ).toEqual(["owner@example.com", "inbox@example.com"]);
    expect(() =>
      loadConfig({ ...production, ALLOWED_EMAILS: "inbox@example.com" }),
    ).toThrow("must include OWNER_EMAIL");
    expect(() => loadConfig({ ...production, ALLOWED_EMAILS: "*" })).toThrow(
      "valid email",
    );
  });
  it("requires HTTPS production origins and explicit processing activation", () => {
    expect(() =>
      loadConfig({ ...production, BASE_URL: "http://labels.example.com" }),
    ).toThrow("HTTPS");
    expect(loadConfig(production).processingEnabled).toBe(false);
    expect(
      loadConfig({ ...production, PROCESSING_ENABLED: "true" })
        .processingEnabled,
    ).toBe(true);
  });
  it("uses only example identities for unconfigured local development", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.owner).toBe("owner@example.com");
    expect(config.allowed).toEqual(["owner@example.com"]);
    expect(config.topic).toBe("");
    expect(config.processingEnabled).toBe(false);
  });
});

it("uses a neutral draft by default and accepts explicitly configured wording", () => {
  expect(loadConfig({ NODE_ENV: "test" }).declineReplyText).toContain(
    "not exploring new opportunities right now",
  );
  expect(
    loadConfig({ NODE_ENV: "test", DECLINE_REPLY_TEXT: "My configured reply" })
      .declineReplyText,
  ).toBe("My configured reply");
});

it.each(["PREVIOUS_WEB_GOOGLE", "LEGACY_GOOGLE"])(
  "requires complete optional production credential pairs: %s",
  (prefix) => {
    expect(() =>
      loadConfig({ ...production, [`${prefix}_CLIENT_ID`]: "test-client" }),
    ).toThrow("configured together");
    expect(() =>
      loadConfig({ ...production, [`${prefix}_CLIENT_SECRET`]: "test-secret" }),
    ).toThrow("configured together");
  },
);
it("requires an explicit previous-client topic in production and validates optional topic paths", () => {
  const previous = {
    PREVIOUS_WEB_GOOGLE_CLIENT_ID: "previous-client",
    PREVIOUS_WEB_GOOGLE_CLIENT_SECRET: "previous-test-secret",
  };
  expect(() => loadConfig({ ...production, ...previous })).toThrow(
    "PREVIOUS_WEB_GMAIL_TOPIC is required",
  );
  expect(() =>
    loadConfig({ ...production, LEGACY_GMAIL_TOPIC: "bad-topic" }),
  ).toThrow("LEGACY_GMAIL_TOPIC must be");
  const config = loadConfig({
    ...production,
    ...previous,
    PREVIOUS_WEB_GMAIL_TOPIC: "projects/old-project/topics/gmail",
  });
  expect(config.previousWebTopic).toBe("projects/old-project/topics/gmail");
  expect(config.legacyTopic).toBe(config.previousWebTopic);
});

it("supports only explicitly configured push identities during OAuth project migration", () => {
  const config = loadConfig({
    ...production,
    ADDITIONAL_PUSH_SERVICE_ACCOUNTS:
      "new-push@oauth-project.iam.gserviceaccount.com,PUSH@example-project.iam.gserviceaccount.com",
  });
  expect(config.pushEmails).toEqual([
    "push@example-project.iam.gserviceaccount.com",
    "new-push@oauth-project.iam.gserviceaccount.com",
  ]);
  expect(() =>
    loadConfig({ ...production, ADDITIONAL_PUSH_SERVICE_ACCOUNTS: "*" }),
  ).toThrow("Service account identities must be email addresses");
  expect(loadConfig({ NODE_ENV: "test" }).pushEmails).toEqual([]);
});
