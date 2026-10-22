import type { ChoiceActions, GmailLabel } from "./api";
export function ActionEditor({
  actions,
  onChange,
  labels = [],
  disabled = false,
  showLabels = true,
}: {
  actions: ChoiceActions;
  onChange: (actions: ChoiceActions) => void;
  labels?: GmailLabel[];
  disabled?: boolean;
  showLabels?: boolean;
}) {
  const update = (patch: Partial<ChoiceActions>) =>
    onChange({ ...actions, ...patch });
  return (
    <fieldset className="match-actions" disabled={disabled}>
      <legend>
        On match <small>Choose at least one action</small>
      </legend>
      <label className="check-field">
        <input
          type="checkbox"
          checked={!!actions.labels.length}
          onChange={(e) =>
            update({
              labels: e.target.checked ? [{ labelId: "", labelName: "" }] : [],
            })
          }
        />
        <span>Add Gmail labels</span>
      </label>
      {actions.labels.length > 0 &&
        (showLabels ? (
          <div className="action-labels">
            {actions.labels.map((selected, index) => (
              <div className="inline-actions" key={index}>
                <select
                  aria-label={`Gmail label ${index + 1}`}
                  required
                  value={selected.labelId}
                  onChange={(e) =>
                    update({
                      labels: actions.labels.map((item, i) =>
                        i === index
                          ? {
                              labelId: e.target.value,
                              labelName:
                                labels.find((l) => l.id === e.target.value)
                                  ?.name ?? "",
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="">
                    {!selected.labelId && selected.labelName
                      ? `Select a label for ${selected.labelName}`
                      : "Select an existing label"}
                  </option>
                  {selected.labelId &&
                    !labels.some((l) => l.id === selected.labelId) && (
                      <option value={selected.labelId}>
                        {selected.labelName} (unavailable)
                      </option>
                    )}
                  {labels.map((label) => (
                    <option
                      key={label.id}
                      value={label.id}
                      disabled={actions.labels.some(
                        (item, i) => i !== index && item.labelId === label.id,
                      )}
                    >
                      {label.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove label ${index + 1}`}
                  onClick={() =>
                    update({
                      labels: actions.labels.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                update({
                  labels: [...actions.labels, { labelId: "", labelName: "" }],
                })
              }
            >
              + Add another label
            </button>
          </div>
        ) : (
          <p className="hint">
            Select one or more labels for each mailbox in the next step.
          </p>
        ))}
      <label className="check-field">
        <input
          type="checkbox"
          checked={!!actions.replyDraft}
          onChange={(e) =>
            update({ replyDraft: e.target.checked ? { body: "" } : null })
          }
        />
        <span>Create reply draft</span>
      </label>
      {actions.replyDraft && (
        <label className="field">
          Reply text
          <textarea
            required
            rows={4}
            maxLength={6000}
            value={actions.replyDraft.body}
            onChange={(e) => update({ replyDraft: { body: e.target.value } })}
          />
          <small>
            Plain text, up to 6,000 characters. Drafts stay editable and are
            never sent. Replied conversations, existing drafts, and automated
            messages are skipped.
          </small>
        </label>
      )}
      <label className="check-field">
        <input
          type="checkbox"
          checked={actions.markRead}
          onChange={(e) => update({ markRead: e.target.checked })}
        />
        <span>
          Mark as read<small>When off, preserve the current read status.</small>
        </span>
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={!!actions.forward}
          onChange={(e) =>
            update({ forward: e.target.checked ? { to: "" } : null })
          }
        />
        <span>Automatically forward email</span>
      </label>
      {actions.forward && (
        <label className="field">
          Forward to
          <input
            required
            type="email"
            maxLength={254}
            placeholder="recipient@example.com"
            value={actions.forward.to}
            onChange={(e) => update({ forward: { to: e.target.value } })}
          />
          <small>
            Sends a readable copy of the matched message, plus the original .eml
            file containing its attachments.
          </small>
        </label>
      )}
    </fieldset>
  );
}
