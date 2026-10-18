import { useEffect, useRef, useState } from "react";
import { Mail, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { api, type Account, type ActivityResponse, type Decision } from "./api";
import { decisionKey } from "./rules";
import {
  filteredHistory,
  historyPage,
  mergeHistory,
  isExcludedMail,
  type OutcomeFilter,
} from "./history";

const relative = (time: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(time).toLocaleDateString();
};

export function DecisionHistory({ accounts }: { accounts: Account[] }) {
  const [inbox, setInbox] = useState(""),
    [filter, setFilter] = useState<OutcomeFilter>("all"),
    [showExcluded, setShowExcluded] = useState(false),
    [page, setPage] = useState(1);
  const [decisions, setDecisions] = useState<Decision[]>([]),
    [limit, setLimit] = useState(500),
    [retention, setRetention] = useState(30),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refreshKey, setRefreshKey] = useState(0);
  const pageRef = useRef(page);
  const sectionRef = useRef<HTMLElement>(null);
  const goToPage = (next: number) => {
    setPage(next);
    sectionRef.current?.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  useEffect(() => {
    let active = true,
      inFlight = false,
      asOf: number | undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDecisions([]);
    async function load(full: boolean) {
      if (inFlight) return;
      inFlight = true;
      try {
        const query = new URLSearchParams();
        if (inbox) query.set("inbox", inbox);
        if (!full && asOf !== undefined)
          query.set("after", String(Math.max(0, asOf - 60000)));
        const result = await api<ActivityResponse>(
          `/api/activity${query.size ? "?" + query : ""}`,
          { signal: controller.signal },
        );
        if (!active || (!full && pageRef.current !== 1)) return;
        setDecisions((previous) =>
          mergeHistory(full ? [] : previous, result.decisions, result.limit),
        );
        setLimit(result.limit);
        setRetention(result.retentionDays);
        asOf = result.asOf;
        setError("");
      } catch (e) {
        if (active && !controller.signal.aborted)
          setError((e as Error).message);
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    }
    void load(true);
    const timer = setInterval(() => {
      if (pageRef.current === 1 && !document.hidden)
        void load(asOf === undefined);
    }, 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [inbox, refreshKey]);
  const filtered = filteredHistory(decisions, filter, showExcluded);
  const current = historyPage(filtered, page);
  return (
    <section
      ref={sectionRef}
      className="activity-section"
      aria-labelledby="history-heading"
    >
      <div className="section-title">
        <h2 id="history-heading">Decision log</h2>
        <button
          type="button"
          className="icon-button"
          disabled={loading}
          aria-label="Refresh history"
          onClick={() => {
            setPage(1);
            setRefreshKey((k) => k + 1);
          }}
        >
          <RefreshCw size={17} className={loading ? "spinning" : ""} />
        </button>
      </div>
      <div className="history-toolbar">
        <label>
          Inbox
          <select
            aria-label="Filter by inbox"
            value={inbox}
            onChange={(e) => {
              setInbox(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All inboxes</option>
            {accounts.map((a) => (
              <option key={a.email} value={a.email}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label result
          <select
            aria-label="Filter by label result"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as OutcomeFilter);
              setPage(1);
            }}
          >
            <option value="all">All results</option>
            <option value="applied">Label applied</option>
            <option value="not_applied">No label applied</option>
            <option value="no_match">No match</option>
            <option value="uncertain">Uncertain</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <span className="history-update">
          {page === 1
            ? "Latest page updates automatically"
            : "Updates paused while browsing"}
        </span>
      </div>
      <label className="history-excluded-toggle">
        <input
          type="checkbox"
          checked={showExcluded}
          onChange={(e) => {
            setShowExcluded(e.target.checked);
            setPage(1);
          }}
        />
        Show excluded mail (sent, drafts, spam, trash)
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="empty" role="status">
          Loading classification history…
        </div>
      ) : current.rows.length ? (
        <div className="table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Rule / selected choice</th>
                <th>Label status</th>
                <th>Mailbox</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {current.rows.map((d) => (
                <tr key={decisionKey(d)}>
                  <td>
                    <a
                      className="subject"
                      href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(d.email)}#all/${d.threadId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {d.subject || "(No subject)"}
                    </a>
                    {d.draft === "created" && (
                      <small>Reply draft prepared</small>
                    )}
                    {d.reason && (
                      <small>
                        {d.reason === "Not incoming mail"
                          ? "Sent, draft, spam, or trash — original category was not recorded"
                          : d.reason}
                      </small>
                    )}
                    {d.contextTruncated && (
                      <small>Thread context shortened</small>
                    )}
                  </td>
                  <td>
                    <strong className="activity-rule">
                      {d.ruleName || "Recruiting (legacy)"}
                    </strong>
                    <small>
                      {d.choiceName ||
                        (d.outcome === "not_recruiting" ||
                        d.outcome === "no_match"
                          ? "No match"
                          : "—")}
                      {d.probability !== undefined
                        ? ` · ${(d.probability * 100).toFixed(1)}%`
                        : ""}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`decision ${d.outcome}`}
                      title={
                        d.probability !== undefined
                          ? `Model score: ${(d.probability * 100).toFixed(1)}%`
                          : undefined
                      }
                    >
                      {d.outcome === "labeled"
                        ? `Applied ${d.label || "label"}`
                        : d.outcome === "uncertain"
                          ? "Uncertain"
                          : d.outcome === "skipped"
                            ? isExcludedMail(d)
                              ? "Excluded"
                              : "Skipped"
                            : d.outcome === "failed"
                              ? "Failed"
                              : d.outcome === "no_match" ||
                                  d.outcome === "not_recruiting"
                                ? "No match"
                                : d.outcome === "decided"
                                  ? "Label pending"
                                  : d.outcome === "processing"
                                    ? "Processing"
                                    : "No label"}
                    </span>
                  </td>
                  <td className="muted">{d.email}</td>
                  <td
                    className="subtle nowrap"
                    title={new Date(d.createdAt).toLocaleString()}
                  >
                    {relative(d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty activity-empty">
          <Mail size={25} />
          <p>
            {decisions.length
              ? "No classifications match these filters."
              : "Ready for the next conversation."}
          </p>
          <span>
            {decisions.length
              ? "Choose another inbox or label result."
              : "Decisions appear here as new emails arrive."}
          </span>
        </div>
      )}
      <nav
        className="history-pagination"
        aria-label="Classification history pages"
      >
        <span role="status" aria-live="polite">
          {loading
            ? "Loading…"
            : `${current.start}–${current.end} of ${current.total} ${filter === "all" ? "classifications" : "matching classifications"}`}
        </span>
        <div className="page-controls">
          <button
            type="button"
            className="page-button"
            aria-label="Previous history page"
            disabled={loading || current.page === 1}
            onClick={() => goToPage(current.page - 1)}
          >
            <ChevronLeft size={16} />
            Previous
          </button>
          <label className="page-select">
            Page
            <select
              aria-label="History page"
              disabled={loading || current.pageCount === 1}
              value={current.page}
              onChange={(e) => goToPage(Number(e.target.value))}
            >
              {Array.from({ length: current.pageCount }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
            <span>of {current.pageCount}</span>
          </label>
          <button
            type="button"
            className="page-button"
            aria-label="Next history page"
            disabled={loading || current.page === current.pageCount}
            onClick={() => goToPage(current.page + 1)}
          >
            Next
            <ChevronRight size={16} />
          </button>
        </div>
      </nav>
      <p className="footnote history-note">
        Latest {limit} classifications{" "}
        {inbox ? "for this inbox" : "across your inboxes"} · {retention}-day
        retention. Each row records one rule’s decision.
      </p>
    </section>
  );
}
