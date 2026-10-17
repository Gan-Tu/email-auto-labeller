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
