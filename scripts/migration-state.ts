import type { Account } from "../server/types.js";
/** Source remains authoritative for configuration/cursor; staged reconnect credentials remain valid. */
export function mergeMigrationAccount(
  source: Account,
  destination: Account | undefined,
  sourceIdentity: { project: string; database: string },
  now = Date.now(),
) {
  if (
    destination &&
    destination.email.toLowerCase() !== source.email.toLowerCase()
  )
    throw new Error("Destination mailbox identity mismatch");
  const credentials = destination?.refreshToken ? destination : source;
  if (
    !credentials.refreshToken ||
    !["legacy", "web"].includes(credentials.clientType)
  )
    throw new Error("Migration credential unavailable");
  const { oauthClientId: _sourceClientId, ...sourceMetadata } = source;
  return {
    ...sourceMetadata,
    ...(credentials.oauthClientId === undefined
      ? {}
      : { oauthClientId: credentials.oauthClientId }),
    refreshToken: credentials.refreshToken,
    clientType: credentials.clientType,
    rulesMigratedAt: now,
    rulesRevision: (destination?.rulesRevision ?? 0) + 1,
    migratedFrom: `${sourceIdentity.project}/${sourceIdentity.database}`,
  };
}
export function assertMailboxIdentity(actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase())
    throw new Error("Credential identity mismatch");
}
