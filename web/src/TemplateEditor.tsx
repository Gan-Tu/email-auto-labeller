import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, post, type RuleInput, type RuleTemplate, type User } from "./api";
import { ChoiceEditor } from "./ChoiceEditor";
import { Dialog } from "./Dialog";
import { PromptAssistant } from "./PromptAssistant";
import { cleanRule, newRuleInput, validateRule } from "./rules";

export function TemplateEditor({
  template,
  initial,
  user,
  onClose,
  onSaved,
}: {
  template?: RuleTemplate;
  initial?: RuleInput;
  user: User;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<RuleInput>(() =>
    template
      ? cleanRule(template)
      : initial
        ? cleanRule(initial)
        : newRuleInput(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (patch: Partial<RuleInput>) =>
    setForm((current) => ({ ...current, ...patch }));
  const protectedLabels = form.protectedLabels ?? [];
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = validateRule(form, { template: true });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        template
          ? `/api/rule-templates/${encodeURIComponent(template.id)}`
          : "/api/rule-templates",
        post(user, template ? "PATCH" : "POST", {
          ...cleanRule(form),
          ...(template ? { expectedVersion: template.version } : {}),
        }),
      );
      onSaved(
        template
          ? "Template updated. Existing rules are unchanged."
          : "Template created. Use it whenever you create a rule.",
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
      title={template ? "Edit template" : "Create template"}
      subtitle="Save a reusable starting point for any mailbox. Existing rules keep their own settings."
      onClose={onClose}
      wide
      busy={busy}
    >
      <form onSubmit={save} className="template-editor">
        <label className="field">
          Template name
          <input
            autoFocus
            required
            maxLength={100}
            placeholder="e.g. Work opportunities"
            value={form.name}
            disabled={busy}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <div className="prompt-editor">
          <div className="prompt-heading">
            <label htmlFor="template-prompt">Classification prompt</label>
            <span>{form.prompt.length.toLocaleString()} / 6,000</span>
          </div>
          <textarea
            id="template-prompt"
            required
            minLength={20}
            maxLength={6000}
            rows={6}
            value={form.prompt}
            disabled={busy}
            onChange={(e) => change({ prompt: e.target.value })}
            placeholder="Describe what this template should classify."
          />
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
          disabled={busy}
        />
        <ChoiceEditor
          choices={form.choices}
          onChange={(choices) => change({ choices })}
          template
          disabled={busy}
        />
        <p className="hint template-label-hint">
          Label names are matched to existing Gmail labels when you create a
          rule. Missing labels can be mapped then.
        </p>
        <section
          className="template-behavior"
          aria-label="Default rule behavior"
        >
          <h3>Default rule behavior</h3>
          <div className="field-grid">
            <label className="field">
              Minimum match probability (%)
              <input
                required
                type="number"
                min={50}
                max={99.9}
                step={0.1}
                value={Math.round(form.threshold * 1000) / 10}
                disabled={busy}
                onChange={(e) =>
                  change({ threshold: Number(e.target.value) / 100 })
                }
              />
            </label>
            <label className="field">
              Apply to
              <select
                value={form.scope}
                disabled={busy}
                onChange={(e) =>
                  change({ scope: e.target.value as RuleInput["scope"] })
                }
              >
                <option value="message">New message</option>
                <option value="thread">
                  Incoming messages in conversation
                </option>
              </select>
            </label>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            <span>
              Enable new rules by default
              <small>Templates themselves never process emails.</small>
            </span>
          </label>
          <h3>Skip conversations with these labels</h3>
          {protectedLabels.map((label, index) => (
            <div className="template-protection" key={index}>
              <label className="field">
                Protected label name {index + 1}
                <input
                  required
                  maxLength={200}
                  value={label.labelName}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      protectedLabels: protectedLabels.map((item, i) =>
                        i === index
                          ? { ...item, labelId: "", labelName: e.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={label.includeChildren}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      protectedLabels: protectedLabels.map((item, i) =>
                        i === index
                          ? { ...item, includeChildren: e.target.checked }
                          : item,
                      ),
                    })
                  }
                />
                Include nested labels
              </label>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Remove protected label ${index + 1}`}
                disabled={busy}
                onClick={() =>
                  change({
                    protectedLabels: protectedLabels.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy || protectedLabels.length >= 50}
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
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions sticky-actions create-rule-actions">
          <span className="hint">Private to your signed-in account.</span>
          <div className="inline-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : template ? "Save changes" : "Create template"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
