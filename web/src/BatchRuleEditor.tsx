import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Layers, Tag } from "lucide-react";
import {
  api,
  post,
  mailboxPath,
  type GmailLabel,
  type Rule,
  type RuleChoice,
  type User,
} from "./api";
import { Dialog } from "./Dialog";
import { ChoiceEditor } from "./ChoiceEditor";
import { matchingLabel, newChoice, ruleKey, validateRule } from "./rules";
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
    [mappings, setMappings] = useState<Record<string, Record<string, string>>>(
      {},
    );
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [overwritePrompts, setOverwritePrompts] = useState(false),
    [disableDrafts, setDisableDrafts] = useState(false),
    [labelReload, setLabelReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const emails = [...new Set(rules.map((r) => r.email))];
  const incompatibleDrafts =
    fields.choices &&
    rules.some((r) => r.draftReplies) &&
    (choices.length !== 1 || choices[0].id !== "recruiting");
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
        return [email, result.labels] as const;
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
    setChoices(rule.choices.map((c) => ({ ...c })));
    setThreshold(rule.threshold);
    setEnabled(rule.enabled);
    setMappings(
      Object.fromEntries(
        rules.map((target) => [
          ruleKey(target),
          Object.fromEntries(
            rule.choices.map((choice) => [
              choice.id,
              matchingLabel(target, choice),
            ]),
          ),
        ]),
      ),
    );
  }
  function assigned(rule: Rule, choice: RuleChoice) {
    return mappings[ruleKey(rule)]?.[choice.id] ?? matchingLabel(rule, choice);
  }
  function targetChoices(rule: Rule) {
    return choices.map((c) => {
      const labelId = assigned(rule, c);
      const label = labels[rule.email]?.find((l) => l.id === labelId);
      return {
        ...c,
        name: c.name.trim(),
        description: c.description.trim(),
        labelId,
        labelName: label?.name ?? "",
      };
    });
  }
  const missingLabels = fields.choices
    ? rules.reduce(
        (sum, rule) =>
          sum +
          choices.filter(
            (c) => !labels[rule.email]?.some((l) => l.id === assigned(rule, c)),
          ).length,
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
    if (incompatibleDrafts && !disableDrafts)
      return "Turn off recruiting decline drafts to use these replacement choices.";
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
            ...(incompatibleDrafts && disableDrafts
              ? { draftReplies: false }
              : {}),
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
      ...(incompatibleDrafts && disableDrafts ? { draftReplies: false } : {}),
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
        {["Choose changes", "Map labels", "Review"].map((label, i) => (
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
            ? "Map each choice to a label in each inbox"
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
                  onChange={setChoices}
                  showLabels={false}
                />
                {incompatibleDrafts ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={disableDrafts}
                      onChange={(e) => setDisableDrafts(e.target.checked)}
                    />
                    <span>
                      Turn off recruiting decline drafts for selected rules.
                      <small>
                        The new choices are not compatible with the existing
                        recruiting draft action.
                      </small>
                    </span>
                  </label>
                ) : null}
              </>
            ) : (
              <p className="hint">
                Choice names, descriptions, and mailbox label mappings are
                preserved.
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
            Every dropdown contains labels from that mailbox only. Existing
            choice mappings are preselected when available.
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
                  <label key={choice.id} className="mapping-row">
                    <span>
                      <Tag size={14} />
                      {choice.name}
                    </span>
                    <select
                      aria-label={`${choice.name} label for ${rule.name} (${rule.email})`}
                      value={assigned(rule, choice)}
                      onChange={(e) =>
                        setMappings((prev) => ({
                          ...prev,
                          [ruleKey(rule)]: {
                            ...prev[ruleKey(rule)],
                            [choice.id]: e.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">Select a Gmail label</option>
                      {labels[rule.email]?.map((label) => (
                        <option value={label.id} key={label.id}>
                          {label.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {rule.draftReplies && incompatibleDrafts && !disableDrafts ? (
                  <p className="error">
                    This rule prepares recruiting decline drafts. Disable drafts
                    in the individual rule before replacing it with multiple
                    choices.
                  </p>
                ) : null}
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
                        choices: "Choices and labels",
                        threshold: "Threshold",
                        enabled: "Status",
                      })[key as Field],
                  )
                  .join(", ")}{" "}
                will be replaced. Other fields are preserved.
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
                    {rule.choices.length} current labeled{" "}
                    {rule.choices.length === 1 ? "choice" : "choices"} →{" "}
                    {choices.length} new labeled{" "}
                    {choices.length === 1 ? "choice" : "choices"}
                  </p>
                  {targetChoices(rule).map((choice) => (
                    <div className="review-choice" key={choice.id}>
                      <span>{choice.name}</span>
                      <ArrowRight size={13} />
                      <span className="label-chip">
                        <Tag size={12} />
                        {choice.labelName}
                      </span>
                    </div>
                  ))}
                  <small>No match → no label, always included</small>
                </>
              ) : null}
              {fields.threshold ? (
                <p>
                  Threshold: {(rule.threshold * 100).toFixed(1)}% →{" "}
                  {(threshold * 100).toFixed(1)}%
                </p>
              ) : null}
              {incompatibleDrafts && disableDrafts && rule.draftReplies ? (
                <p>Recruiting decline drafts: enabled → disabled</p>
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
            {step === 0 && fields.choices ? "Map labels" : "Review changes"}
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
