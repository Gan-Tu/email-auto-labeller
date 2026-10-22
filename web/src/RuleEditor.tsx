import { useEffect, useRef, useState } from "react";
import {
  FlaskConical,
  ArrowRight,
  Check,
  AlertCircle,
  Trash2,
  Plus,
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
  type RuleTemplate,
  type TestResponse,
  type User,
} from "./api";
import { Dialog } from "./Dialog";
import { PromptAssistant } from "./PromptAssistant";
import { ChoiceEditor } from "./ChoiceEditor";
import {
  cleanRule,
  applyRuleTemplate,
  actionSummary,
  choiceActions,
  newChoice,
  validateRule,
} from "./rules";
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
          protectedLabels: [],
          replyDraft: null,
        },
  );
  const [labels, setLabels] = useState<GmailLabel[]>([]),
    [labelsLoading, setLabelsLoading] = useState(true),
    [labelError, setLabelError] = useState(""),
    [labelReload, setLabelReload] = useState(0);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [templates, setTemplates] = useState<RuleTemplate[]>([]),
    [templatesLoading, setTemplatesLoading] = useState(!rule),
    [templatesError, setTemplatesError] = useState(""),
    [templatesReload, setTemplatesReload] = useState(0),
    [templateBusy, setTemplateBusy] = useState(false),
    [savedTemplate, setSavedTemplate] = useState(""),
    [templateNotice, setTemplateNotice] = useState("");
  const [testMode, setTestMode] = useState<"text" | "message">("text"),
    [testInput, setTestInput] = useState(""),
    [testBusy, setTestBusy] = useState(false),
    [testResult, setTestResult] = useState<TestResponse>(),
    [testError, setTestError] = useState("");
  const testRevision = useRef(0);
  const protectedLabels = form.protectedLabels ?? [];
  useEffect(() => {
    if (rule) return;
    const controller = new AbortController();
    setTemplatesLoading(true);
    setTemplatesError("");
    api<{ templates: RuleTemplate[] }>("/api/rule-templates", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setTemplates(result.templates);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTemplatesError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTemplatesLoading(false);
      });
    return () => controller.abort();
  }, [rule, templatesReload]);
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
    setForm((f) => ({ ...f, ...patch }));
    setTestResult(undefined);
    setTemplateNotice("");
  };
  function validation() {
    return (
      validateRule(form) ||
      (form.choices.some((c) =>
        choiceActions(c).labels.some(
          (label) => !labels.some((l) => l.id === label.labelId),
        ),
      )
        ? "Remap or remove unavailable Gmail labels."
        : "") ||
      (protectedLabels.some(
        (label) => !labels.some((existing) => existing.id === label.labelId),
      )
        ? "Remap or remove unavailable protected Gmail labels."
        : "")
    );
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || testBusy) return;
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
  async function saveTemplate() {
    if (busy || testBusy) return;
    const problem = validateRule(form, { template: true });
    if (problem) {
      setError(problem);
      return;
    }
    const input = cleanRule(form);
    setBusy(true);
    setTemplateBusy(true);
    setError("");
    setTemplateNotice("");
    try {
      const { template } = await api<{ template: RuleTemplate }>(
        "/api/rule-templates",
        post(user, "POST", input),
      );
      setTemplates((current) => [
        template,
        ...current.filter((item) => item.id !== template.id),
      ]);
      setSavedTemplate(JSON.stringify(input));
      setTemplateNotice(
        `“${template.name}” saved as a template. Create the rule now or use it later.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTemplateBusy(false);
    }
  }
  function useTemplate(template: RuleTemplate) {
    const input = applyRuleTemplate(template, labels);
    change(input);
    setError("");
    if (
      input.choices.some((choice) =>
        choiceActions(choice).labels.some((label) => !label.labelId),
      ) ||
      input.protectedLabels?.some((label) => !label.labelId)
    ) {
      setTemplateNotice(
        "Template applied. Select this mailbox’s labels for the missing mappings before creating the rule.",
      );
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
      subtitle="Describe the decision, then choose what happens for each match."
      onClose={onClose}
      wide
      busy={busy || testBusy}
    >
      <form onSubmit={save}>
        {rule?.lastError ? (
          <div className="error notice" role="alert">
            This rule needs attention: {rule.lastError}. Check the actions and
            label mappings below and save to resume.
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
                      protectedLabels: protectedLabels.map((label) => ({
                        ...label,
                        labelId: "",
                        labelName: "",
                      })),
                      choices: form.choices.map((c) => ({
                        ...c,
                        actions: {
                          ...choiceActions(c),
                          labels: choiceActions(c).labels.map(() => ({
                            labelId: "",
                            labelName: "",
                          })),
                        },
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
                  disabled={busy || testBusy}
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
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="text-button"
                    disabled={busy || testBusy || labelsLoading || !!labelError}
                    onClick={() => useTemplate(template)}
                  >
                    {template.name} <ArrowRight size={14} />
                  </button>
                ))}
                {templatesLoading ? (
                  <span>Loading saved templates…</span>
                ) : null}
                {templatesError ? (
                  <span className="template-error" role="alert">
                    Could not load saved templates. {templatesError}{" "}
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || testBusy}
                      onClick={() => setTemplatesReload((value) => value + 1)}
                    >
                      Retry
                    </button>
                  </span>
                ) : null}
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
            <PromptAssistant
              user={user}
              context={{
                currentPrompt: form.prompt,
                name: form.name,
                scope: form.scope,
                choices: form.choices,
              }}
              onUse={(prompt) => change({ prompt })}
              disabled={busy || testBusy}
            />
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
            <div className="rule-behavior">
              <h3>Rule behavior</h3>
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
                    Lower scores are recorded as uncertain; no actions run.
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
              <section
                className="behavior-section"
                aria-labelledby="protected-labels-title"
              >
                <h4 id="protected-labels-title">
                  Skip conversations with these labels
                </h4>
                <p className="hint">
                  Skip the entire conversation if any selected label is already
                  present. Include nested labels to protect its sublabels too.
                </p>
                {protectedLabels.map((protection, index) => (
                  <div className="protected-label-row" key={index}>
                    <div className="protected-label-heading">
                      <label className="field">
                        Protected Gmail label
                        <select
                          required
                          value={protection.labelId}
                          disabled={busy || labelsLoading}
                          onChange={(event) =>
                            change({
                              protectedLabels: protectedLabels.map(
                                (item, itemIndex) =>
                                  itemIndex === index
                                    ? {
                                        ...item,
                                        labelId: event.target.value,
                                        labelName:
                                          labels.find(
                                            (label) =>
                                              label.id === event.target.value,
                                          )?.name ?? "",
                                      }
                                    : item,
                              ),
                            })
                          }
                        >
                          <option value="">
                            {labelsLoading
                              ? "Loading labels…"
                              : !protection.labelId && protection.labelName
                                ? `Select a label for ${protection.labelName}`
                                : "Select an existing label"}
                          </option>
                          {protection.labelId &&
                          !labels.some(
                            (label) => label.id === protection.labelId,
                          ) ? (
                            <option value={protection.labelId} disabled>
                              {protection.labelName || "Protected label"}{" "}
                              (unavailable)
                            </option>
                          ) : null}
                          {labels.map((label) => (
                            <option
                              key={label.id}
                              value={label.id}
                              disabled={protectedLabels.some(
                                (item, itemIndex) =>
                                  itemIndex !== index &&
                                  item.labelId === label.id,
                              )}
                            >
                              {label.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="icon-button danger"
                        disabled={busy}
                        aria-label={`Remove protected label ${protection.labelName || index + 1}`}
                        onClick={() =>
                          change({
                            protectedLabels: protectedLabels.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={protection.includeChildren}
                        disabled={busy}
                        onChange={(event) =>
                          change({
                            protectedLabels: protectedLabels.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      includeChildren: event.target.checked,
                                    }
                                  : item,
                            ),
                          })
                        }
                      />
                      <span>Include nested labels</span>
                    </label>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    busy ||
                    labelsLoading ||
                    !!labelError ||
                    protectedLabels.length >= 50
                  }
                  onClick={() =>
                    change({
                      protectedLabels: [
                        ...protectedLabels,
                        { labelId: "", labelName: "", includeChildren: false },
                      ],
                    })
                  }
                >
                  <Plus size={15} /> Add protected label
                </button>
              </section>
            </div>
          </div>
          <aside className="test-panel">
            <div className="test-title">
              <FlaskConical size={19} />
              <h3>Test this rule</h3>
            </div>
            <p className="hint">
              Uses your unsaved changes. No actions run; Gmail stays unchanged.
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
                    "No actions would run."
                  ) : noMatch ? (
                    "No actions would run."
                  ) : uncertain ? (
                    `Below the ${Math.round(form.threshold * 1000) / 10}% threshold. No actions would run.`
                  ) : (
                    <>
                      Would run:{" "}
                      <strong>
                        {actionSummary({
                          ...(form.choices.find(
                            (c) => c.id === testResult.result.choiceId,
                          ) ?? newChoice()),
                          ...(testResult.actions
                            ? { actions: testResult.actions }
                            : {}),
                        })}
                      </strong>
                      .
                    </>
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
        {templateNotice ? (
          <div className="notice" role="status">
            {templateNotice}
          </div>
        ) : null}
        <div
          className={`dialog-actions sticky-actions${rule ? "" : " create-rule-actions"}`}
        >
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
              <span className="hint">
                Only created rules process new emails.
              </span>
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
            {!rule ? (
              <button
                type="button"
                className="secondary template-save"
                disabled={
                  busy ||
                  testBusy ||
                  templatesLoading ||
                  savedTemplate === JSON.stringify(cleanRule(form))
                }
                onClick={() => void saveTemplate()}
              >
                {templateBusy ? "Saving template…" : "Save as Template"}
              </button>
            ) : null}
            <button
              className="primary"
              disabled={busy || testBusy || labelsLoading || !!labelError}
            >
              {busy && !templateBusy
                ? "Saving…"
                : rule
                  ? "Save rule"
                  : "Create rule"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
