import type { Decision } from "./api";
import { decisionKey } from "./rules";
export type OutcomeFilter =
  | "all"
  | "applied"
  | "not_applied"
  | "no_match"
  | "uncertain"
  | "failed"
  | "skipped";
export const HISTORY_PAGE_SIZE = 25;
export function mergeHistory(
  previous: Decision[],
  incoming: Decision[],
  limit: number,
) {
  const byMessage = new Map(previous.map((d) => [decisionKey(d), d]));
  for (const d of incoming) byMessage.set(decisionKey(d), d);
  return [...byMessage.values()]
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.email.localeCompare(b.email) ||
        b.messageId.localeCompare(a.messageId),
    )
    .slice(0, limit);
}
export function isExcludedMail(decision: Decision) {
  return (
    decision.outcome === "skipped" &&
    (!!decision.excludedLabels?.length ||
      decision.reason === "Not incoming mail")
  );
}
export function filteredHistory(
  decisions: Decision[],
  filter: OutcomeFilter,
  showExcluded = false,
) {
  return decisions.filter(
    (d) =>
      (showExcluded || !isExcludedMail(d)) &&
      (filter === "all" ||
        (filter === "applied"
          ? d.outcome === "labeled" ||
            d.outcome === "matched" ||
            d.actions?.some((action) => action.status === "completed")
          : filter === "not_applied"
            ? !(
                d.outcome === "labeled" ||
                d.outcome === "matched" ||
                d.actions?.some((action) => action.status === "completed")
              )
            : filter === "no_match"
              ? d.outcome === "no_match" || d.outcome === "not_recruiting"
              : d.outcome === filter)),
  );
}
export function historyPage(decisions: Decision[], page: number) {
  const pageCount = Math.max(
    1,
    Math.ceil(decisions.length / HISTORY_PAGE_SIZE),
  );
  const current = Math.max(1, Math.min(page, pageCount));
  const offset = (current - 1) * HISTORY_PAGE_SIZE;
  return {
    rows: decisions.slice(offset, offset + HISTORY_PAGE_SIZE),
    page: current,
    pageCount,
    start: decisions.length ? offset + 1 : 0,
    end: Math.min(offset + HISTORY_PAGE_SIZE, decisions.length),
    total: decisions.length,
  };
}
