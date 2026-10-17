import { useEffect, useRef, useState } from "react";
import {
  FlaskConical,
  ArrowRight,
  Check,
  AlertCircle,
  Trash2,
} from "lucide-react";
import {
  api,
  post,
  mailboxPath,
  rulePath,
  type Account,
  type GmailLabel,
  type Rule,
  type RuleInput,
  type TestResponse,
  type User,
} from "./api";
import { Dialog } from "./Dialog";
import { ChoiceEditor } from "./ChoiceEditor";
import { cleanRule, newChoice, validateRule } from "./rules";
import { sortLabels } from "./labels";
const recruitingDescription =
  "Genuine, personally directed outreach or follow-up about recruiting the mailbox owner for an employment opportunity.";
export function RuleEditor({
  rule,
  accounts,
  defaultPrompt,
  user,
  onClose,
  onSaved,
}: {
  rule?: Rule;
  accounts: Account[];
  defaultPrompt: string;
  user: User;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [email, setEmail] = useState(rule?.email ?? accounts[0]?.email ?? "");
  const [form, setForm] = useState<RuleInput>(() =>
    rule
      ? cleanRule(rule)
      : {
          name: "",
          prompt: "",
          enabled: true,
          threshold: 0.8,
          scope: "message",
          choices: [newChoice()],
        },
  );
  const [labels, setLabels] = useState<GmailLabel[]>([]),
    [labelsLoading, setLabelsLoading] = useState(true),
    [labelError, setLabelError] = useState(""),
    [labelReload, setLabelReload] = useState(0);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [testMode, setTestMode] = useState<"text" | "message">("text"),
    [testInput, setTestInput] = useState(""),
    [testBusy, setTestBusy] = useState(false),
    [testResult, setTestResult] = useState<TestResponse>(),
    [testError, setTestError] = useState("");
  const testRevision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setLabelsLoading(true);
    setLabelError("");
    setLabels([]);
    api<{ labels: GmailLabel[] }>(`${mailboxPath(email)}/labels`, {
      signal: controller.signal,
    })
      .then((r) => setLabels(sortLabels(r.labels)))
      .catch((e) => {
        if (!controller.signal.aborted) setLabelError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLabelsLoading(false);
      });
    return () => controller.abort();
  }, [email, labelReload]);
  const change = (patch: Partial<RuleInput>) => {
    testRevision.current += 1;
    setForm((f) => ({
      ...f,
      ...patch,
      ...(patch.choices &&
      (patch.choices.length !== 1 || patch.choices[0].id !== "recruiting")
        ? { draftReplies: false }
        : {}),
    }));
    setTestResult(undefined);
  };
  function validation() {
    return (
      validateRule(form) ||
      (form.choices.some((c) => !labels.some((l) => l.id === c.labelId))
        ? "Select an available Gmail label for every choice."
        : "")
    );
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const problem = validation();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        rule ? rulePath(rule) : `${mailboxPath(email)}/rules`,
        post(user, rule ? "PATCH" : "POST", {
          ...cleanRule(form),
          ...(rule ? { expectedVersion: rule.version } : {}),
        }),
      );
      onSaved(
        rule
          ? "Rule updated. New emails will use the new version."
          : "Rule created. It will process new emails.",
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!rule) return;
    setBusy(true);
    setError("");
    try {
      await api(
        rulePath(rule),
        post(user, "DELETE", { expectedVersion: rule.version }),
      );
      onSaved("Rule deleted. Labels already applied are unchanged.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function test() {
    const problem = validation();
    if (problem) {
      setTestError(problem);
      return;
    }
    if (!testInput.trim()) {
      setTestError(
        testMode === "text"
          ? "Paste an email to test."
          : "Enter a Gmail message ID.",
      );
      return;
    }
    const revision = ++testRevision.current;
    setTestBusy(true);
    setTestError("");
    setTestResult(undefined);
    try {
      const result = await api<TestResponse>(
        `${mailboxPath(email)}/rules/test`,
        post(user, "POST", {
          rule: cleanRule(form),
          ...(testMode === "text"
            ? { text: testInput.trim() }
            : { messageId: testInput.trim() }),
        }),
      );
      if (revision === testRevision.current) setTestResult(result);
    } catch (e) {
      if (revision === testRevision.current) setTestError((e as Error).message);
    } finally {
      setTestBusy(false);
    }
  }
  const probability = testResult?.result.probability;
  const uncertain = probability != null && probability < form.threshold;
  const noMatch = testResult?.result.choiceId === "no_match";
  return (
    <Dialog
      title={rule ? "Edit rule" : "Create rule"}
      subtitle="Describe the decision, then connect each answer to a Gmail label."
      onClose={onClose}
      wide
      busy={busy || testBusy}
    >
      <form onSubmit={save}>
        {rule?.lastError ? (
          <div className="error notice" role="alert">
            This rule needs attention: {rule.lastError}. Check the label
            mappings below and save to resume.
          </div>
        ) : null}
        <div className="editor-grid">
          <div className="editor-main">
            <div className="field-grid">
              <label className="field">
                Rule name
                <input
                  autoFocus
                  required
                  maxLength={100}
                  placeholder="e.g. Recruiting emails"
                  value={form.name}
                  disabled={busy}
                  onChange={(e) => change({ name: e.target.value })}
                />
              </label>
              <label className="field">
                Mailbox
                <select
                  value={email}
                  disabled={!!rule || busy}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    change({
                      choices: form.choices.map((c) => ({
                        ...c,
                        labelId: "",
                        labelName: "",
                      })),
                    });
                  }}
                >
                  {accounts.map((a) => (
                    <option key={a.email} value={a.email}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!rule ? (
              <div className="template-line">
                <span>Start with a template</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    change({
                      name: "Recruiting emails",
                      prompt: defaultPrompt,
                      choices: [
                        {
                          ...newChoice(),
                          id: "recruiting",
                          name: "Recruiting",
                          description: recruitingDescription,
                        },
                      ],
                    })
                  }
                >
                  Recruiting <ArrowRight size={14} />
                </button>
              </div>
            ) : null}
            <div className="prompt-editor">
              <div className="prompt-heading">
                <label htmlFor="rule-prompt">Classification prompt</label>
                <span>{form.prompt.length.toLocaleString()} / 6,000</span>
              </div>
              <textarea
                id="rule-prompt"
                required
                minLength={20}
                maxLength={6000}
                rows={7}
                value={form.prompt}
                placeholder="Explain what this rule should decide. Include the intent, context, and exclusions."
                disabled={busy}
                onChange={(e) => change({ prompt: e.target.value })}
              />
              <small>
                The prompt sets the overall task. Each choice below defines a
                possible answer.
              </small>
            </div>
            {labelError ? (
              <div className="error" role="alert">
                Could not load Gmail labels. {labelError}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setLabelReload((k) => k + 1)}
                >
                  Retry
                </button>
              </div>
            ) : null}
            <ChoiceEditor
              choices={form.choices}
              onChange={(choices) => change({ choices })}
              labels={labels}
              labelsLoading={labelsLoading}
              disabled={busy}
            />
            {rule?.draftReplies &&
            !form.draftReplies &&
            (form.choices.length !== 1 ||
              form.choices[0]?.id !== "recruiting") ? (
              <p className="hint">
                Recruiting decline drafts will be turned off when you save these
                choices.
              </p>
            ) : null}
            <div className="rule-behavior">
              <h3>Behavior</h3>
              <div className="field-grid">
                <label className="field">
                  Minimum match probability
                  <div className="input-unit">
                    <input
                      type="number"
                      min="50"
                      max="99.9"
                      step="0.1"
                      required
                      value={Math.round(form.threshold * 1000) / 10}
                      onChange={(e) =>
                        change({ threshold: Number(e.target.value) / 100 })
                      }
                    />
                    <span>%</span>
                  </div>
                  <small>
                    Lower scores are recorded as uncertain; no label is added.
                  </small>
                </label>
                <label className="field">
                  Apply to
                  <select
                    value={form.scope}
                    onChange={(e) =>
                      change({ scope: e.target.value as RuleInput["scope"] })
                    }
                  >
                    <option value="message">New message</option>
                    <option value="thread">
                      Incoming messages in conversation
                    </option>
                  </select>
                  <small>
                    Both use conversation context for classification.
                  </small>
                </label>
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => change({ enabled: e.target.checked })}
                />
                <span>
                  <strong>Rule enabled</strong>
                  <small>Runs on new emails when the mailbox is active.</small>
                </span>
              </label>
              {rule?.preserveJobSearch ||
              rule?.draftReplies ||
              form.choices.some((c) => c.id === "recruiting") ? (
                <details className="advanced-settings">
                  <summary>Recruiting behavior</summary>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={!!form.preserveJobSearch}
                      onChange={(e) =>
                        change({ preserveJobSearch: e.target.checked })
                      }
                    />
                    <span>
                      Preserve existing Job Search labels
                      <small>
                        Skip conversations already filed in the Job Search label
                        group.
                      </small>
                    </span>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={!!form.draftReplies}
                      disabled={
                        form.choices.length !== 1 ||
                        form.choices[0].id !== "recruiting"
                      }
                      onChange={(e) =>
                        change({ draftReplies: e.target.checked })
                      }
                    />
                    <span>
                      Prepare a polite decline draft
                      <small>
                        Available for a single recruiting choice. Drafts are
                        never sent.
                      </small>
                    </span>
                  </label>
                </details>
              ) : null}
            </div>
          </div>
          <aside className="test-panel">
            <div className="test-title">
              <FlaskConical size={19} />
              <h3>Test this rule</h3>
            </div>
            <p className="hint">
              Uses your unsaved changes. No labels will be applied.
            </p>
            <div className="segmented" aria-label="Test input type">
              <button
                type="button"
                className={testMode === "text" ? "active" : ""}
                onClick={() => {
                  testRevision.current += 1;
                  setTestMode("text");
                  setTestInput("");
                  setTestResult(undefined);
                }}
              >
                Paste email
              </button>
              <button
                type="button"
                className={testMode === "message" ? "active" : ""}
                onClick={() => {
                  testRevision.current += 1;
                  setTestMode("message");
                  setTestInput("");
                  setTestResult(undefined);
                }}
              >
                Message ID
              </button>
            </div>
            <label className="field">
              {testMode === "text" ? "Email content" : "Gmail message ID"}
              {testMode === "text" ? (
                <textarea
                  rows={9}
                  value={testInput}
                  maxLength={60000}
                  placeholder="From: recruiter@example.com\nSubject: An opportunity for you\n\nHi…"
                  onChange={(e) => {
                    testRevision.current += 1;
                    setTestInput(e.target.value);
                    setTestResult(undefined);
                  }}
                />
              ) : (
                <input
                  value={testInput}
                  placeholder="e.g. 19a25b4d603f19cc"
                  onChange={(e) => {
                    testRevision.current += 1;
                    setTestInput(e.target.value);
                    setTestResult(undefined);
                  }}
                />
              )}
            </label>
            <button
              type="button"
              className="secondary full-width"
              disabled={busy || testBusy || labelsLoading || !!labelError}
              onClick={() => void test()}
            >
              <FlaskConical size={16} />
              {testBusy ? "Classifying…" : "Run test"}
            </button>
            {testError ? (
              <p className="error" role="alert">
                {testError}
              </p>
            ) : null}
            {testResult ? (
              <div className="test-result" role="status">
                <div className="result-heading">
                  {uncertain || testResult.result.refused ? (
                    <AlertCircle size={19} />
                  ) : (
                    <Check size={19} />
                  )}
                  <strong>
                    {testResult.result.refused
                      ? "Could not classify"
                      : testResult.result.choiceName ||
                        (noMatch ? "No match" : testResult.result.choiceId)}
                  </strong>
                </div>
                {probability != null ? (
                  <>
                    <div className="result-score">
                      <span>Match probability</span>
                      <strong>{(probability * 100).toFixed(1)}%</strong>
                    </div>
                    <div
                      className={`probability-bar ${uncertain ? "uncertain" : ""}`}
                    >
                      <span style={{ width: `${probability * 100}%` }} />
                      <i
                        style={{ left: `${form.threshold * 100}%` }}
                        title={`Threshold ${(form.threshold * 100).toFixed(1)}%`}
                      />
                    </div>
                  </>
                ) : null}
                <p>
                  {testResult.result.refused ? (
                    "No label would be applied."
                  ) : noMatch ? (
                    "No label would be applied."
                  ) : uncertain ? (
                    `Below the ${Math.round(form.threshold * 1000) / 10}% threshold. No label would be applied.`
                  ) : testResult.label ? (
                    <>
                      Would apply <strong>{testResult.label.name}</strong>.
                    </>
                  ) : (
                    "No label would be applied."
                  )}
                </p>
                <small>Test only · Gmail unchanged</small>
              </div>
            ) : null}
          </aside>
        </div>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmDelete ? (
          <div className="disconnect-confirm">
            <p>
              Delete “{rule?.name}”? Its future classifications will stop.
              Existing Gmail labels will stay in place.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Keep rule
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete rule
              </button>
            </div>
          </div>
        ) : null}
        <div className="dialog-actions sticky-actions">
          <div>
            {rule ? (
              <button
                type="button"
                className="text-button danger"
                disabled={busy || testBusy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} /> Delete rule
              </button>
            ) : (
              <span className="hint">Applies to new emails after saving.</span>
            )}
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || testBusy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || testBusy || labelsLoading || !!labelError}
            >
              {busy ? "Saving…" : rule ? "Save rule" : "Create rule"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
