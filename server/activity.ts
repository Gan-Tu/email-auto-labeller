import type { Decision } from "./types.js";

export const ACTIVITY_LIMIT = 500;
export const HISTORY_RETENTION_DAYS = 30;

export function latestActivity(groups: Decision[][]): Decision[] {
  return groups
    .flat()
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.email.localeCompare(b.email) ||
        (b.executionId ?? b.messageId).localeCompare(
          a.executionId ?? a.messageId,
        ),
    )
    .slice(0, ACTIVITY_LIMIT);
}
