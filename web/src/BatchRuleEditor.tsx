import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Layers, Tag } from "lucide-react";
import {
  api,
  post,
  mailboxPath,
  type GmailLabel,
  type ChoiceActions,
  type Rule,
  type RuleChoice,
  type User,
} from "./api";
import { Dialog } from "./Dialog";
import { sortLabels } from "./labels";
import { ActionEditor } from "./ActionEditor";
import { ChoiceEditor } from "./ChoiceEditor";
import {
  choiceActions,
  actionSummary,
  batchChoiceActions,
  newChoice,
  ruleKey,
  validateRule,
} from "./rules";
type Field = "prompt" | "choices" | "threshold" | "enabled";
export function BatchRuleEditor({
  rules,
  user,
  onClose,
  onSaved,
}: {
  rules: Rule[];
  user: User;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [step, setStep] = useState(0),
    [fields, setFields] = useState<Record<Field, boolean>>({
      prompt: false,
      choices: false,
      threshold: false,
      enabled: false,
    });
  const [prompt, setPrompt] = useState(""),
    [choices, setChoices] = useState<RuleChoice[]>([newChoice()]),
    [threshold, setThreshold] = useState(0.8),
    [enabled, setEnabled] = useState(true);
  const [source, setSource] = useState(""),
    [labels, setLabels] = useState<Record<string, GmailLabel[]>>({}),
    [mappings, setMappings] = useState<
      Record<string, Record<string, ChoiceActions>>
    >({});
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [overwritePrompts, setOverwritePrompts] = useState(false),
    [replaceActions, setReplaceActions] = useState(false),
    [labelReload, setLabelReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const emails = [...new Set(rules.map((r) => r.email))];
  const promptVariants = new Set(rules.map((r) => r.prompt)).size;
  useEffect(() => {
    if (step > 0) heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (!fields.choices) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all(
      emails.map(async (email) => {
        const result = await api<{ labels: GmailLabel[] }>(
          `${mailboxPath(email)}/labels`,
          { signal: controller.signal },
        );
        return [email, sortLabels(result.labels)] as const;
      }),
    )
      .then((values) => setLabels(Object.fromEntries(values)))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(`Could not load mailbox labels. ${e.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fields.choices, labelReload]);
  function seedSource(key: string) {
    setSource(key);
    const rule = rules.find((r) => ruleKey(r) === key);
    if (!rule) return;
    setPrompt(rule.prompt);
    setChoices(
      rule.choices.map((c) => ({
        ...c,
        actions: choiceActions(c, rule.replyDraft),
      })),
    );
    setThreshold(rule.threshold);
    setEnabled(rule.enabled);
    setMappings({});
  }
  function assigned(rule: Rule, choice: RuleChoice): ChoiceActions {
    return (
      mappings[ruleKey(rule)]?.[choice.id] ??
      batchChoiceActions(rule, choice, labels[rule.email] ?? [], replaceActions)
    );
  }

  function targetChoices(rule: Rule) {
    return choices.map((c) => ({
      id: c.id,
      name: c.name.trim(),
      description: c.description.trim(),
      actions: assigned(rule, c),
    }));
  }
  const missingLabels = fields.choices
    ? rules.reduce(
        (sum, rule) =>
          sum +
          choices.reduce(
            (count, choice) =>
              count +
              assigned(rule, choice).labels.filter(
                (label) =>
                  !labels[rule.email]?.some((l) => l.id === label.labelId),
              ).length,
            0,
          ),
        0,
      )
    : 0;
  function validateFields() {
    if (!Object.values(fields).some(Boolean))
      return "Choose at least one field to replace.";
    if (fields.prompt && (prompt.trim().length < 20 || prompt.length > 6000))
      return "Use between 20 and 6,000 characters for the new prompt.";
    if (fields.prompt && promptVariants > 1 && !overwritePrompts)
      return "Confirm that the different prompts will be replaced.";
    if (fields.threshold && (threshold < 0.5 || threshold > 0.999))
      return "Choose a threshold between 50 and 99.9%.";
    if (fields.choices) {
      if (!choices.length || choices.length > 12)
        return "Add between 1 and 12 choices.";
      if (choices.some((c) => !c.name.trim() || !c.description.trim()))
        return "Give every choice a name and description.";
      const names = choices.map((c) => c.name.trim().toLowerCase());
      if (new Set(names).size !== names.length || names.includes("no match"))
        return "Choice names must be unique. No match is already included.";
    }
    return "";
  }
  function next() {
    let problem = validateFields();
    if (step === 1 && fields.choices) {
      if (loading) problem = "Wait for mailbox labels to finish loading.";
      else if (missingLabels)
        problem = `Choose the ${missingLabels} remaining Gmail labels.`;
      else
        for (const rule of rules) {
          const failure = validateRule({
            ...rule,
            replyDraft: null,
            choices: targetChoices(rule),
          });
          if (failure) {
            problem = `${rule.name} (${rule.email}): ${failure}`;
            break;
          }
        }
    }
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setStep(step === 0 && !fields.choices ? 2 : step + 1);
  }
  async function apply() {
    setBusy(true);
    setError("");
    const changes = {
      ...(fields.prompt ? { prompt: prompt.trim() } : {}),
      ...(fields.threshold ? { threshold } : {}),
      ...(fields.enabled ? { enabled } : {}),
      ...(fields.choices ? { replyDraft: null } : {}),
    };
    const targets = rules.map((rule) => ({
      email: rule.email,
      ruleId: rule.id,
      expectedVersion: rule.version,
      ...(fields.choices ? { choices: targetChoices(rule) } : {}),
    }));
    try {
      await api("/api/rules/batch", post(user, "POST", { targets, changes }));
      onSaved(
        `Updated ${rules.length} ${rules.length === 1 ? "rule" : "rules"} across ${emails.length} ${emails.length === 1 ? "mailbox" : "mailboxes"}.`,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Batch edit rules"
      subtitle={`${rules.length} selected ${rules.length === 1 ? "rule" : "rules"} in ${emails.length} ${emails.length === 1 ? "mailbox" : "mailboxes"}`}
      onClose={onClose}
      wide
      busy={busy}
    >
      <nav className="batch-steps" aria-label="Batch edit steps">
        {["Choose changes", "Review actions", "Review"].map((label, i) => (
          <span
            key={label}
            className={step === i ? "current" : step > i ? "done" : ""}
            aria-current={step === i ? "step" : undefined}
          >
            <b>{step > i ? <Check size={13} /> : i + 1}</b>
            {label}
          </span>
        ))}
      </nav>
      <h3 ref={heading} tabIndex={-1} className="step-heading">
        {step === 0
          ? "Replace only the fields you choose"
          : step === 1
            ? "Review actions for each mailbox"
            : "Review your changes"}
      </h3>
      {step === 0 ? (
        <div className="batch-fields">
          <p className="hint">
            All other settings stay as they are. Updates apply to new emails.
          </p>
          <label className="field source-select">
            Start from an existing rule (optional)
            <select value={source} onChange={(e) => seedSource(e.target.value)}>
              <option value="">Write new values</option>
              {rules.map((r) => (
                <option key={ruleKey(r)} value={ruleKey(r)}>
                  {r.name} · {r.email}
                </option>
              ))}
            </select>
            <small>
              Copies values into this editor. Only fields set to Replace will be
              saved.
            </small>
          </label>
          <fieldset className="batch-field">
            <legend>Classification prompt</legend>
            <div className="keep-replace">
              <label>
                <input
                  type="radio"
                  name="prompt-mode"
                  checked={!fields.prompt}
                  onChange={() => setFields({ ...fields, prompt: false })}
                />{" "}
                Keep current
              </label>
              <label>
                <input
                  type="radio"
                  name="prompt-mode"
                  checked={fields.prompt}
                  onChange={() => setFields({ ...fields, prompt: true })}
                />{" "}
                Replace
              </label>
            </div>
            {fields.prompt ? (
              <>
                <label className="field">
                  New prompt
                  <textarea
                    rows={6}
                    minLength={20}
                    maxLength={6000}
                    value={prompt}
                    placeholder="Enter the prompt to apply to every selected rule."
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>
                {promptVariants > 1 ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={overwritePrompts}
                      onChange={(e) => setOverwritePrompts(e.target.checked)}
                    />
                    <span>
                      Replace all {promptVariants} different prompts with this
                      prompt.
                    </span>
                  </label>
                ) : null}
              </>
            ) : (
              <p className="hint">
                {promptVariants} existing{" "}
                {promptVariants === 1 ? "prompt is" : "prompts are"} preserved.
              </p>
            )}
          </fieldset>
          <fieldset className="batch-field">
            <legend>Multiple-choice outputs</legend>
            <div className="keep-replace">
              <label>
                <input
                  type="radio"
                  name="choices-mode"
                  checked={!fields.choices}
                  onChange={() => setFields({ ...fields, choices: false })}
                />{" "}
                Keep current
              </label>
              <label>
                <input
                  type="radio"
                  name="choices-mode"
                  checked={fields.choices}
                  onChange={() => setFields({ ...fields, choices: true })}
                />{" "}
                Replace all choices
              </label>
            </div>
            {fields.choices ? (
              <>
                <p className="hint">
                  Replaces each selected rule’s choice list. You’ll assign Gmail
                  labels in the next step.
                </p>
                <ChoiceEditor
                  choices={choices}
                  onChange={(value) => {
                    setChoices(value);
                    setMappings({});
                  }}
                  showLabels={false}
                />
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={replaceActions}
                    onChange={(e) => {
                      setReplaceActions(e.target.checked);
                      setMappings({});
                    }}
                  />
                  <span>
                    Replace existing actions with the actions above
                    <small>
                      By default, preserve each matching choice’s actions by ID
                      or name. New choices use the actions above. Review every
                      mailbox next.
                    </small>
                  </span>
                </label>
              </>
            ) : (
              <p className="hint">
                Choice names, descriptions, and all actions are preserved.
              </p>
            )}
          </fieldset>
          <div className="field-grid">
            <fieldset className="batch-field">
              <legend>Match threshold</legend>
              <div className="keep-replace">
                <label>
                  <input
                    type="radio"
                    name="threshold-mode"
                    checked={!fields.threshold}
                    onChange={() => setFields({ ...fields, threshold: false })}
                  />{" "}
                  Keep
                </label>
                <label>
                  <input
                    type="radio"
                    name="threshold-mode"
                    checked={fields.threshold}
                    onChange={() => setFields({ ...fields, threshold: true })}
                  />{" "}
                  Replace
                </label>
              </div>
              {fields.threshold ? (
                <label className="field">
                  Minimum probability (%)
                  <input
                    type="number"
                    min="50"
                    max="99.9"
                    step="0.1"
                    value={Math.round(threshold * 1000) / 10}
                    onChange={(e) => setThreshold(Number(e.target.value) / 100)}
                  />
                </label>
              ) : null}
            </fieldset>
            <fieldset className="batch-field">
              <legend>Rule status</legend>
              <div className="keep-replace">
                <label>
                  <input
                    type="radio"
                    name="enabled-mode"
                    checked={!fields.enabled}
                    onChange={() => setFields({ ...fields, enabled: false })}
                  />{" "}
                  Keep
                </label>
                <label>
                  <input
                    type="radio"
                    name="enabled-mode"
                    checked={fields.enabled}
                    onChange={() => setFields({ ...fields, enabled: true })}
                  />{" "}
                  Replace
                </label>
              </div>
              {fields.enabled ? (
                <label className="field">
                  Set status
                  <select
                    value={String(enabled)}
                    onChange={(e) => setEnabled(e.target.value === "true")}
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Paused</option>
                  </select>
                </label>
              ) : null}
            </fieldset>
          </div>
        </div>
      ) : step === 1 ? (
        <div className="batch-mappings">
          <p className="hint">
            Review each choice’s actions before saving. Label options belong to
            that mailbox only. Existing actions are preserved unless you replace
            them.
          </p>
          {loading ? (
            <p role="status">Loading Gmail labels…</p>
          ) : (
            rules.map((rule) => (
              <section key={ruleKey(rule)} className="mapping-rule">
                <div>
                  <strong>{rule.name}</strong>
                  <span>{rule.email}</span>
                </div>
                {choices.map((choice) => (
                  <section key={choice.id}>
                    <h4>{choice.name}</h4>
                    <ActionEditor
                      actions={assigned(rule, choice)}
                      labels={labels[rule.email]}
                      onChange={(actions) =>
                        setMappings((prev) => ({
                          ...prev,
                          [ruleKey(rule)]: {
                            ...prev[ruleKey(rule)],
                            [choice.id]: actions,
                          },
                        }))
                      }
                    />
                  </section>
                ))}
              </section>
            ))
          )}
          <p
            className={missingLabels ? "mapping-remaining" : "mapping-complete"}
            role="status"
          >
            {missingLabels
              ? `${missingLabels} label ${missingLabels === 1 ? "mapping" : "mappings"} remaining`
              : "All label mappings assigned"}
          </p>
        </div>
      ) : (
        <div className="batch-review">
          <div className="review-summary">
            <Layers size={20} />
            <div>
              <strong>
                {rules.length} rules · {emails.length} mailboxes
              </strong>
              <p>
                {Object.entries(fields)
                  .filter(([, active]) => active)
                  .map(
                    ([key]) =>
                      ({
                        prompt: "Prompt",
                        choices: "Choices and actions",
                        threshold: "Threshold",
                        enabled: "Status",
                      })[key as Field],
                  )
                  .join(", ")}{" "}
                will be replaced.
                {fields.choices
                  ? " Actions are configured per choice and mailbox."
                  : " Existing actions are preserved."}{" "}
                Protected labels are preserved.
              </p>
            </div>
          </div>
          {rules.map((rule) => (
            <section className="review-rule" key={ruleKey(rule)}>
              <div className="review-rule-heading">
                <strong>{rule.name}</strong>
                <span>{rule.email}</span>
              </div>
              {fields.prompt ? (
                <details>
                  <summary>
                    Prompt{" "}
                    {rule.prompt.trim() === prompt.trim()
                      ? "(unchanged)"
                      : "will be replaced"}
                  </summary>
                  <div className="prompt-diff">
                    <div>
                      <span>Before</span>
                      <p>{rule.prompt}</p>
                    </div>
                    <div>
                      <span>After</span>
                      <p>{prompt}</p>
                    </div>
                  </div>
                </details>
              ) : null}
              {fields.choices ? (
                <>
                  <p className="hint">
                    {rule.choices.length} current{" "}
                    {rule.choices.length === 1 ? "choice" : "choices"} →{" "}
                    {choices.length} new{" "}
                    {choices.length === 1 ? "choice" : "choices"}
                  </p>
                  {targetChoices(rule).map((choice) => (
                    <div className="review-choice" key={choice.id}>
                      <span>{choice.name}</span>
                      <ArrowRight size={13} />
                      <span className="label-chip">
                        <Tag size={12} />
                        {actionSummary(choice)}
                      </span>
                    </div>
                  ))}
                  <small>No match → no actions, always included</small>
                </>
              ) : null}
              {fields.threshold ? (
                <p>
                  Threshold: {(rule.threshold * 100).toFixed(1)}% →{" "}
                  {(threshold * 100).toFixed(1)}%
                </p>
              ) : null}
              {fields.enabled ? (
                <p>
                  Status: {rule.enabled ? "Enabled" : "Paused"} →{" "}
                  {enabled ? "Enabled" : "Paused"}
                </p>
              ) : null}
            </section>
          ))}
          <p className="hint">
            All selected rules update together. If a rule changed since you
            opened this editor, nothing is saved; refresh and review again.
          </p>
        </div>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
          {error.startsWith("Could not load mailbox labels") ? (
            <button
              type="button"
              className="text-button"
              onClick={() => setLabelReload((k) => k + 1)}
            >
              Retry labels
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="dialog-actions sticky-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            step === 0
              ? onClose()
              : (setError(""),
                setStep(step === 2 && !fields.choices ? 0 : step - 1))
          }
        >
          {step === 0 ? (
            "Cancel"
          ) : (
            <>
              <ArrowLeft size={15} /> Back
            </>
          )}
        </button>
        {step < 2 ? (
          <button
            type="button"
            className="primary"
            disabled={loading}
            onClick={next}
          >
            {step === 0 && fields.choices ? "Review actions" : "Review changes"}
            <ArrowRight size={15} />
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            {busy
              ? "Applying…"
              : `Apply to ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`}
          </button>
        )}
      </div>
    </Dialog>
  );
}
