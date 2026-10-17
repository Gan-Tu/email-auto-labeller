import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mail,
  Plus,
  ArrowRight,
  RefreshCw,
  SlidersHorizontal,
  Activity,
  Inbox,
  LogOut,
  Search,
  Layers,
  Tag,
  Check,
  AlertCircle,
  Pause,
  ChevronRight,
} from "lucide-react";
import { api, post, type Account, type Rule, type User } from "./api";
import { AccountSettings } from "./AccountSettings";
import { DecisionHistory } from "./DecisionHistory";
import { RuleEditor } from "./RuleEditor";
import { BatchRuleEditor } from "./BatchRuleEditor";
import { ruleKey } from "./rules";
type Tab = "rules" | "activity" | "mailboxes";
const tabs = [
  { id: "rules" as const, label: "Rules", icon: SlidersHorizontal },
  { id: "activity" as const, label: "Activity", icon: Activity },
  { id: "mailboxes" as const, label: "Mailboxes", icon: Inbox },
];
function readTab(): Tab {
  const value = location.hash.slice(1);
  return value === "activity" || value === "mailboxes" ? value : "rules";
}
export function AccountStatus({ account }: { account: Account }) {
  const state = !account.enabled
    ? "Paused"
    : account.lastError
      ? "Needs attention"
      : account.watchExpires < Date.now()
        ? "Watch expired"
        : "Listening";
  return (
    <span
      className={`status ${state === "Listening" ? "live" : state === "Paused" ? "paused" : "issue"}`}
    >
      {state === "Listening" ? (
        <span className="status-dot" />
      ) : state === "Paused" ? (
        <Pause size={13} />
      ) : (
        <AlertCircle size={13} />
      )}{" "}
      {state}
    </span>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(),
    [accounts, setAccounts] = useState<Account[]>([]),
    [rules, setRules] = useState<Rule[]>([]);
  const [tab, setTab] = useState<Tab>(readTab),
    [selectedAccount, setSelectedAccount] = useState<Account>(),
    [editor, setEditor] = useState<Rule | "new">(),
    [batchRules, setBatchRules] = useState<Rule[]>();
  const [selected, setSelected] = useState<string[]>([]),
    [inbox, setInbox] = useState(""),
    [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState("all");
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [loaded, setLoaded] = useState(false),
    [defaultPrompt, setDefaultPrompt] = useState("");
  const selectAll = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [a, r] = await Promise.all([
        api<{ accounts: Account[]; prompt: string }>("/api/accounts"),
        api<{ rules: Rule[]; defaultPrompt: string }>("/api/rules"),
      ]);
      setAccounts(a.accounts);
      setRules(r.rules);
      setDefaultPrompt(r.defaultPrompt || a.prompt || "");
      setError("");
      setLoaded(true);
      setSelected((previous) =>
        previous.filter((key) => r.rules.some((rule) => ruleKey(rule) === key)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    api<{ user: User | null }>("/api/session")
      .then((r) => setUser(r.user))
      .catch((e) => {
        setUser(null);
        setError(e.message);
      });
    const query = new URLSearchParams(location.search);
    if (query.has("error"))
      setError(
        query.get("error") === "account_not_allowed"
          ? "This app is available only to its configured Gmail accounts."
          : "The Gmail connection could not be completed. Please try again.",
      );
    if (query.size)
      history.replaceState(null, "", location.pathname + location.hash);
    const handle = () => setTab(readTab());
    addEventListener("hashchange", handle);
    return () => removeEventListener("hashchange", handle);
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  const visibleRules = rules.filter(
    (rule) =>
      (!inbox || rule.email === inbox) &&
      (statusFilter === "all" ||
        rule.enabled === (statusFilter === "enabled")) &&
      `${rule.name} ${rule.email} ${rule.choices.map((c) => c.name + " " + c.labelName).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visibleSelected = visibleRules.filter((rule) =>
    selected.includes(ruleKey(rule)),
  ).length;
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        visibleSelected > 0 && visibleSelected < visibleRules.length;
  }, [visibleSelected, visibleRules.length]);
  const activeRules = rules.filter(
    (rule) =>
      rule.enabled && accounts.some((a) => a.email === rule.email && a.enabled),
  ).length;
  const attention = accounts.filter(
    (a) => a.enabled && (a.lastError || a.watchExpires < Date.now()),
  );
  function saved(message: string) {
    setNotice(message);
    setSelected([]);
    void refresh();
  }
  async function signOut() {
    if (!user) return;
    try {
      await api("/api/logout", post(user, "POST"));
      setUser(null);
      setAccounts([]);
      setRules([]);
      setLoaded(false);
      setSelected([]);
      setEditor(undefined);
      setBatchRules(undefined);
      setSelectedAccount(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={user ? "app-shell" : "signed-out-shell"}>
      <header className="app-sidebar">
        <a className="brand" href="#rules">
          <span className="brand-icon">
            <img src="/logo.png" alt="" width="40" height="40" />
          </span>
          <span>
            Email Auto
            <br className="brand-break" /> Labeller
          </span>
        </a>
        {user ? (
          <>
            <nav className="app-nav" aria-label="Main navigation">
              {tabs.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className={tab === id ? "active" : ""}
                  aria-current={tab === id ? "page" : undefined}
                >
                  <Icon size={18} />
                  {label}
                  {id === "rules" && loaded ? (
                    <span>{rules.length}</span>
                  ) : null}
                </a>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="profile">
                <span className="avatar">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{user.name || "Your workspace"}</strong>
                  <span title={user.email}>{user.email}</span>
                </div>
              </div>
              <button className="sign-out" onClick={() => void signOut()}>
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </>
        ) : null}
      </header>
      <main className="app-main">
        {user ? (
          <>
            <div className="workspace-topline">
              <span>Gmail workspace</span>
              <span className="connection-summary">
                <span className="status-dot" />
                {
                  accounts.filter(
                    (a) =>
                      a.enabled && !a.lastError && a.watchExpires > Date.now(),
                  ).length
                }{" "}
                listening
              </span>
            </div>
            <div className="page-heading">
              <div>
                <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
                <p>
                  {tab === "rules"
                    ? "Turn incoming emails into the right Gmail labels."
                    : tab === "mailboxes"
                      ? "Manage connections and processing for each inbox."
                      : "See what each rule decided and what happened next."}
                </p>
              </div>
              <div className="inline-actions">
                {tab === "rules" ? (
                  <>
                    <button
                      className="secondary"
                      disabled={!rules.length}
                      onClick={() =>
                        setBatchRules(
                          selected.length
                            ? rules.filter((r) => selected.includes(ruleKey(r)))
                            : rules,
                        )
                      }
                    >
                      <Layers size={16} /> Batch edit
                    </button>
                    <button
                      className="primary"
                      disabled={!accounts.length}
                      onClick={() => setEditor("new")}
                    >
                      <Plus size={17} /> Create rule
                    </button>
                  </>
                ) : tab === "mailboxes" ? (
                  <a className="primary" href="/auth/google">
                    <Plus size={17} /> Connect Gmail
                  </a>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
        {error ? (
          <div className="error notice" role="alert">
            {error}
            <button
              type="button"
              className="text-button"
              onClick={() => (user ? void refresh() : location.reload())}
            >
              Try again
            </button>
          </div>
        ) : null}
        {notice && user ? (
          <div className="success notice" role="status">
            <Check size={17} />
            <span>{notice}</span>
            <button className="text-button" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </div>
        ) : null}
        {user === undefined ? (
          <div className="empty" role="status">
            <RefreshCw size={22} className="spinning" />
            <p>Loading your workspace…</p>
          </div>
        ) : !user ? (
          <section className="welcome">
            <div className="welcome-mark">
              <img src="/logo.png" alt="" width="64" height="64" />
            </div>
            <h1>Your inbox, your rules.</h1>
            <p>
              Classify new emails with your own prompts.
              <br />
              Connect every answer to the right Gmail label.
            </p>
            <a className="primary" href="/auth/google">
              Continue with Google
              <ArrowRight size={17} />
            </a>
            <div className="welcome-flow">
              <span>Describe a rule</span>
              <ChevronRight size={14} />
              <span>Choose labels</span>
              <ChevronRight size={14} />
              <span>Stay organized</span>
            </div>
            <small>
              Email content is sent to OpenAI for classification.
              <br />
              Your read status stays unchanged. This app never sends email.
            </small>
          </section>
        ) : !loaded ? (
          <div className="empty" role="status">
            <RefreshCw size={22} className="spinning" />
            <p>Loading mailboxes and rules…</p>
          </div>
        ) : (
          <>
            {attention.length && tab !== "mailboxes" ? (
              <div className="attention-banner">
                <AlertCircle size={17} />
                <span>
                  {attention.length}{" "}
                  {attention.length === 1 ? "mailbox needs" : "mailboxes need"}{" "}
                  attention. Check connections before relying on automatic
                  labeling.
                </span>
                <a href="#mailboxes">
                  View mailboxes <ArrowRight size={14} />
                </a>
              </div>
            ) : null}
            {tab === "rules" ? (
              <section
                className="rules-section"
                aria-label="Classification rules"
              >
                <div className="rules-toolbar">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search rules"
                      placeholder="Search rules or labels…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Filter rules by mailbox"
                    value={inbox}
                    onChange={(e) => setInbox(e.target.value)}
                  >
                    <option value="">All mailboxes</option>
                    {accounts.map((a) => (
                      <option key={a.email} value={a.email}>
                        {a.email}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter rules by status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="enabled">Enabled</option>
                    <option value="paused">Paused</option>
                  </select>
                  <button
                    className="icon-button"
                    aria-label="Refresh rules and mailboxes"
                    disabled={refreshing}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw
                      size={16}
                      className={refreshing ? "spinning" : ""}
                    />
                  </button>
                </div>
                {selected.length ? (
                  <div className="selection-bar">
                    <span role="status">
                      {selected.length}{" "}
                      {selected.length === 1 ? "rule" : "rules"} selected
                      {selected.length > visibleSelected
                        ? ` · ${selected.length - visibleSelected} outside this filter`
                        : ""}
                    </span>
                    <button
                      className="text-button"
                      onClick={() => setSelected([])}
                    >
                      Clear
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        setBatchRules(
                          rules.filter((r) => selected.includes(ruleKey(r))),
                        )
                      }
                    >
                      <Layers size={15} /> Edit selected
                    </button>
                  </div>
                ) : null}
                {visibleRules.length ? (
                  <div className="table-wrap">
                    <table className="rules-table">
                      <thead>
                        <tr>
                          <th className="selection-cell">
                            <input
                              ref={selectAll}
                              type="checkbox"
                              aria-label="Select all visible rules"
                              checked={visibleSelected === visibleRules.length}
                              onChange={(e) =>
                                setSelected((previous) =>
                                  e.target.checked
                                    ? [
                                        ...new Set([
                                          ...previous,
                                          ...visibleRules.map(ruleKey),
                                        ]),
                                      ]
                                    : previous.filter(
                                        (key) =>
                                          !visibleRules.some(
                                            (r) => ruleKey(r) === key,
                                          ),
                                      ),
                                )
                              }
                            />
                          </th>
                          <th>Rule / mailbox</th>
                          <th>Choices → Gmail labels</th>
                          <th>Status</th>
                          <th>Threshold</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRules.map((rule) => {
                          const checked = selected.includes(ruleKey(rule));
                          const accountPaused = !accounts.find(
                            (a) => a.email === rule.email,
                          )?.enabled;
                          return (
                            <tr
                              key={ruleKey(rule)}
                              className={checked ? "selected-row" : ""}
                            >
                              <td className="selection-cell">
                                <input
                                  type="checkbox"
                                  aria-label={`Select rule ${rule.name} (${rule.email})`}
                                  checked={checked}
                                  onChange={(e) =>
                                    setSelected((previous) =>
                                      e.target.checked
                                        ? [...previous, ruleKey(rule)]
                                        : previous.filter(
                                            (key) => key !== ruleKey(rule),
                                          ),
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  className="rule-name"
                                  onClick={() => setEditor(rule)}
                                >
                                  {rule.name}
                                </button>
                                <small>{rule.email}</small>
                                {rule.lastError ? (
                                  <small className="account-error">
                                    {rule.lastError}
                                  </small>
                                ) : null}
                              </td>
                              <td>
                                <div className="rule-choice-list">
                                  {rule.choices.map((c) => (
                                    <span className="rule-choice" key={c.id}>
                                      <span>{c.name}</span>
                                      <ArrowRight size={12} />
                                      <span className="label-chip">
                                        <Tag size={11} />
                                        {c.labelName}
                                      </span>
                                    </span>
                                  ))}
                                  <small>+ No match · no label</small>
                                </div>
                              </td>
                              <td>
                                <span
                                  className={`status ${rule.lastError ? "issue" : rule.enabled && !accountPaused ? "live" : "paused"}`}
                                >
                                  {rule.lastError ? (
                                    <AlertCircle size={12} />
                                  ) : rule.enabled && !accountPaused ? (
                                    <span className="status-dot" />
                                  ) : (
                                    <Pause size={12} />
                                  )}{" "}
                                  {rule.lastError
                                    ? "Needs attention"
                                    : rule.enabled
                                      ? accountPaused
                                        ? "Mailbox paused"
                                        : "Enabled"
                                      : "Paused"}
                                </span>
                              </td>
                              <td className="numeric">
                                {Math.round(rule.threshold * 1000) / 10}%
                              </td>
                              <td>
                                <button
                                  className="text-button"
                                  aria-label={`Edit ${rule.name} for ${rule.email}`}
                                  onClick={() => setEditor(rule)}
                                >
                                  Edit <ChevronRight size={14} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty">
                    <SlidersHorizontal size={25} />
                    <h3>
                      {rules.length
                        ? "No rules match these filters"
                        : "Create your first classification rule"}
                    </h3>
                    <p>
                      {rules.length
                        ? "Try another mailbox, status, or search term."
                        : "Start with Recruiting, or describe a different category of email."}
                    </p>
                    {!rules.length ? (
                      accounts.length ? (
                        <button
                          className="primary"
                          onClick={() => setEditor("new")}
                        >
                          <Plus size={16} /> Create rule
                        </button>
                      ) : (
                        <a className="primary" href="/auth/google">
                          Connect Gmail
                          <ArrowRight size={16} />
                        </a>
                      )
                    ) : (
                      <button
                        className="secondary"
                        onClick={() => {
                          setSearch("");
                          setInbox("");
                          setStatusFilter("all");
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
                <div className="list-footnote">
                  <span>
                    {rules.length} {rules.length === 1 ? "rule" : "rules"}{" "}
                    across {accounts.length}{" "}
                    {accounts.length === 1 ? "mailbox" : "mailboxes"} ·{" "}
                    {activeRules} enabled with an active mailbox
                  </span>
                  <span>Each rule selects one choice</span>
                </div>
                <div className="rules-explainer">
                  <SlidersHorizontal size={18} />
                  <div>
                    <strong>Independent rules. Specific labels.</strong>
                    <p>
                      Each incoming email runs through its mailbox’s enabled
                      rules. Different rules can add different labels. No match
                      and uncertain results leave labels unchanged.
                    </p>
                  </div>
                </div>
              </section>
            ) : tab === "activity" ? (
              <DecisionHistory accounts={accounts} />
            ) : (
              <section
                className="mailboxes-section"
                aria-label="Connected mailboxes"
              >
                {accounts.length ? (
                  <div className="mailbox-list">
                    {accounts.map((account) => (
                      <article className="mailbox-item" key={account.email}>
                        <div className="mailbox-icon">
                          <Mail size={20} />
                        </div>
                        <div className="mailbox-info">
                          <h3>{account.email}</h3>
                          <p>
                            {
                              rules.filter((r) => r.email === account.email)
                                .length
                            }{" "}
                            rules · Last sync{" "}
                            {account.lastSync
                              ? new Date(account.lastSync).toLocaleString()
                              : "not yet"}
                          </p>
                          {account.lastError ? (
                            <small className="account-error">
                              {account.lastError}
                            </small>
                          ) : null}
                        </div>
                        <AccountStatus account={account} />
                        <button
                          className="secondary"
                          onClick={() => setSelectedAccount(account)}
                        >
                          Settings
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <Inbox size={25} />
                    <h3>Connect a Gmail mailbox</h3>
                    <p>
                      Add an inbox to create rules and start classifying new
                      emails.
                    </p>
                    <a className="primary" href="/auth/google">
                      <Plus size={16} /> Connect Gmail
                    </a>
                  </div>
                )}
                <p className="footnote">
                  Mailbox pauses affect every rule in that inbox. Rules and
                  labels are configured separately.
                </p>
              </section>
            )}
          </>
        )}
        <footer>
          <span>Email Auto Labeller</span>
          <span>Prompts → choices → Gmail labels</span>
        </footer>
      </main>
      {selectedAccount && user ? (
        <AccountSettings
          account={selectedAccount}
          user={user}
          onClose={() => setSelectedAccount(undefined)}
          onSaved={() => saved("Mailbox settings updated.")}
        />
      ) : null}
      {editor && user ? (
        <RuleEditor
          rule={editor === "new" ? undefined : editor}
          accounts={accounts}
          defaultPrompt={defaultPrompt}
          user={user}
          onClose={() => setEditor(undefined)}
          onSaved={saved}
        />
      ) : null}
      {batchRules && user ? (
        <BatchRuleEditor
          rules={batchRules}
          user={user}
          onClose={() => setBatchRules(undefined)}
          onSaved={saved}
        />
      ) : null}
    </div>
  );
}
