import { describe, it, expect } from "vitest";
import {
  mergeMigrationAccount,
  assertMailboxIdentity,
} from "../scripts/migration-state";
import type { Account } from "../server/types";
const sourceIdentity = { project: "source-project", database: "source-inbox" };
const account = {
  email: "a@example.com",
  owner: "owner@example.com",
  refreshToken: "encrypted-source",
  clientType: "legacy",
  label: "Recruiting",
  enabled: true,
  draftReplies: true,
  threshold: 0.8,
  classificationPrompt: "Source prompt",
  historyId: "200",
  watchExpires: 999,
  connectedAt: 100,
  lastSync: 150,
} satisfies Account;
describe("Cutover state merge", () => {
  it("retains a staged reconnect credential without overwriting source cursor and settings", () => {
    const destination = {
      ...account,
      refreshToken: "encrypted-new-oauth",
      clientType: "web" as const,
      owner: "other@example.com",
      historyId: "100",
      classificationPrompt: "Staged old prompt",
      enabled: false,
      rulesRevision: 8,
    };
    const merged = mergeMigrationAccount(
      account,
      destination,
      sourceIdentity,
      1234,
    );
    expect(merged).toEqual({
      ...account,
      refreshToken: destination.refreshToken,
      clientType: "web",
      rulesMigratedAt: 1234,
      rulesRevision: 9,
      migratedFrom: "source-project/source-inbox",
    });
  });
  it("uses source credentials on first migration or when destination was disconnected", () => {
    expect(
      mergeMigrationAccount(account, undefined, sourceIdentity).refreshToken,
    ).toBe(account.refreshToken);
    expect(
      mergeMigrationAccount(
        account,
        { ...account, refreshToken: "" },
        sourceIdentity,
      ).clientType,
    ).toBe("legacy");
  });
  it("rejects identity mismatch before any write", () => {
    expect(() =>
      mergeMigrationAccount(
        account,
        {
          ...account,
          email: "other@example.com",
        },
        sourceIdentity,
      ),
    ).toThrow("identity mismatch");
    expect(() =>
      assertMailboxIdentity("other@example.com", account.email),
    ).toThrow("identity mismatch");
    expect(() =>
      assertMailboxIdentity("A@EXAMPLE.COM", account.email),
    ).not.toThrow();
  });
});

it("keeps the OAuth issuer marker paired with the selected staged refresh token", () => {
  const source = {
    ...account,
    clientType: "web" as const,
    oauthClientId: "old-web-client",
  };
  const destination = {
    ...account,
    clientType: "web" as const,
    oauthClientId: "new-web-client",
    refreshToken: "encrypted-new-token",
  };
  expect(
    mergeMigrationAccount(source, destination, sourceIdentity),
  ).toMatchObject({
    refreshToken: "encrypted-new-token",
    clientType: "web",
    oauthClientId: "new-web-client",
  });
  expect(
    mergeMigrationAccount(source, undefined, sourceIdentity),
  ).toMatchObject({
    refreshToken: source.refreshToken,
    oauthClientId: "old-web-client",
  });
});
it("does not inherit a source issuer marker when the chosen destination token is unmarked", () => {
  const source = {
    ...account,
    clientType: "web" as const,
    oauthClientId: "new-web-client",
  };
  const destination = {
    ...account,
    clientType: "web" as const,
    refreshToken: "encrypted-unmarked-previous-token",
  };
  const merged = mergeMigrationAccount(source, destination, sourceIdentity);
  expect(merged.refreshToken).toBe(destination.refreshToken);
  expect(merged).not.toHaveProperty("oauthClientId");
});
