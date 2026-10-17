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
