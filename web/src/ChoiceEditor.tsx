import { Plus, Tag, Trash2, CornerDownRight } from "lucide-react";
import type { GmailLabel, RuleChoice } from "./api";
import { newChoice } from "./rules";
export function ChoiceEditor({
  choices,
  onChange,
  labels,
  labelsLoading = false,
  showLabels = true,
  disabled = false,
}: {
  choices: RuleChoice[];
  onChange: (choices: RuleChoice[]) => void;
  labels?: GmailLabel[];
  labelsLoading?: boolean;
  showLabels?: boolean;
  disabled?: boolean;
}) {
  const update = (id: string, change: Partial<RuleChoice>) =>
    onChange(choices.map((c) => (c.id === id ? { ...c, ...change } : c)));
  return (
    <div className="choices-editor">
      <div className="section-title compact">
        <div>
          <h3>Multiple-choice outputs</h3>
          <p className="hint">
            One choice is selected per email. Each choice applies one label.
          </p>
        </div>
      </div>
      {choices.map((choice, index) => (
        <div className="choice-row" key={choice.id}>
          <div className="choice-number" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </div>
          <div className="choice-fields">
            <div className="choice-topline">
              <label className="field">
                Choice name
                <input
                  required
                  maxLength={100}
                  value={choice.name}
                  placeholder="e.g. Recruiting"
                  disabled={disabled}
                  onChange={(e) => update(choice.id, { name: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Remove choice ${choice.name || index + 1}`}
                disabled={disabled}
                onClick={() =>
                  onChange(choices.filter((c) => c.id !== choice.id))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
            <label className="field">
              When to select this choice
              <textarea
                required
                rows={2}
                maxLength={1000}
                value={choice.description}
                placeholder="Describe the intent and boundaries of this category."
                disabled={disabled}
                onChange={(e) =>
                  update(choice.id, { description: e.target.value })
                }
              />
            </label>
            {showLabels ? (
              <label className="field label-field">
                <span>
                  <CornerDownRight size={14} /> Apply Gmail label
                </span>
                <select
                  required
                  value={choice.labelId}
                  disabled={disabled || labelsLoading}
                  onChange={(e) =>
                    update(choice.id, {
                      labelId: e.target.value,
                      labelName:
                        labels?.find((l) => l.id === e.target.value)?.name ??
                        "",
                    })
                  }
                >
                  <option value="">
                    {labelsLoading
                      ? "Loading labels…"
                      : "Select an existing label"}
                  </option>
                  {choice.labelId &&
                  !labels?.some((l) => l.id === choice.labelId) ? (
                    <option value={choice.labelId} disabled>
                      {choice.labelName || choice.labelId} (unavailable)
                    </option>
                  ) : null}
                  {labels?.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="secondary add-choice"
        disabled={disabled || choices.length >= 12}
        onClick={() => onChange([...choices, newChoice()])}
      >
        <Plus size={16} /> Add choice
      </button>
      <div className="no-match">
        <Tag size={17} />
        <div>
          <strong>
            No match <span>Always included</span>
          </strong>
          <p>
            None of the choices applies, or intent is unclear. No label is
            added.
          </p>
        </div>
      </div>
    </div>
  );
}
