import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, post, type User } from "./api";
import {
  promptContext,
  promptOptionsDefaults,
  supportedEffort,
  type PromptContext,
  type PromptOptions,
} from "./prompt-assistant";

export function PromptAssistant({
  user,
  context,
  onUse,
  disabled = false,
}: {
  user: User;
  context: PromptContext;
  onUse: (prompt: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PromptOptions>();
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState<"normal" | "fast">("fast");
  const [draft, setDraft] = useState("");
  const [draftSignature, setDraftSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const signature = JSON.stringify({
    ...promptContext(context),
    instructions,
    model,
    effort,
    speed,
  });
  const latestSignature = useRef(signature);
  latestSignature.current = signature;
  const stale = !!draft && draftSignature !== signature;

  useEffect(() => {
    if (!open || options) return;
    const controller = new AbortController();
    setOptionsLoading(true);
    setError("");
    api<PromptOptions>("/api/prompt-assistant/options", {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const defaults = promptOptionsDefaults(result);
        setOptions(result);
        setModel(defaults.model);
        setEffort(defaults.effort);
        setSpeed(defaults.speed);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOptionsLoading(false);
      });
    return () => controller.abort();
  }, [open, options, reload]);
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }, [signature]);

  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }
  async function generate() {
    if (!instructions.trim()) {
      setError("Describe what you want the rule to classify.");
      return;
    }
    const selected = options?.models.find((item) => item.id === model);
    if (!selected || !selected.efforts.includes(effort)) {
      setError("Choose a supported model and effort.");
      return;
    }
    cancel();
    const controller = new AbortController();
    pending.current = controller;
    const requestedSignature = signature;
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        prompt: string;
        model: string;
        effort: string;
        speed: "normal" | "fast";
      }>("/api/prompt-assistant/draft", {
        ...post(user, "POST", {
          ...promptContext(context),
          instructions: instructions.trim(),
          model,
          effort,
          speed,
        }),
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        latestSignature.current !== requestedSignature
      )
        return;
      if (
        typeof result.prompt !== "string" ||
        result.prompt.trim().length < 20 ||
        result.prompt.length > 6000
      )
        throw new Error(
          "The generated prompt must contain between 20 and 6,000 characters. Try again.",
        );
      setDraft(result.prompt);
      setDraftSignature(requestedSignature);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="prompt-assistant" aria-label="AI prompt assistant">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) cancel();
          setOpen(!open);
        }}
      >
        <Sparkles size={15} />
        {open ? "Hide prompt assistant" : "Draft prompt with AI"}
      </button>
      {open && (
        <div className="prompt-assistant-body">
          <p className="hint">
            Describe your goal. Review the draft before using it as your
            classification prompt.
          </p>
          <label className="field">
            What should this rule classify?
            <textarea
              rows={3}
              maxLength={6000}
              value={instructions}
              disabled={disabled}
              placeholder="For example, identify personal recruiting outreach and exclude newsletters or automated job alerts."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          {optionsLoading ? (
            <p className="hint" role="status">
              Loading available models…
            </p>
          ) : (
            options && (
              <div className="prompt-assistant-settings">
                <label className="field">
                  Model
                  <select
                    value={model}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = options.models.find(
                        (item) => item.id === event.target.value,
                      )!;
                      setModel(next.id);
                      setEffort(supportedEffort(next, effort));
                    }}
                  >
                    {options.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Reasoning effort
                  <select
                    value={effort}
                    disabled={disabled}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {options.models
                      .find((item) => item.id === model)
                      ?.efforts.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  Speed
                  <select
                    value={speed}
                    disabled={disabled}
                    onChange={(event) =>
                      setSpeed(event.target.value as "normal" | "fast")
                    }
                  >
                    <option value="fast">Fast</option>
                    <option value="normal">Normal</option>
                  </select>
                </label>
              </div>
            )
          )}
          <p className="hint">
            Fast uses priority processing and may cost more.
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled || busy || optionsLoading || !options}
              onClick={() => void generate()}
            >
              {busy ? "Drafting…" : draft ? "Generate again" : "Generate draft"}
            </button>
            {busy && (
              <button type="button" className="text-button" onClick={cancel}>
                Cancel generation
              </button>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
              {!options && !optionsLoading && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Retry models
                </button>
              )}
            </p>
          )}
          {draft && (
            <div className="prompt-assistant-review">
              <label className="field">
                Review generated prompt
                <textarea
                  rows={7}
                  maxLength={6000}
                  value={draft}
                  disabled={disabled || busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <small>
                  {draft.length.toLocaleString()} / 6,000 characters
                </small>
              </label>
              {stale && (
                <p className="hint" role="status">
                  The rule or assistant settings changed. Generate again to use
                  an up-to-date draft.
                </p>
              )}
              <button
                type="button"
                className="secondary"
                disabled={
                  disabled ||
                  busy ||
                  stale ||
                  draft.trim().length < 20 ||
                  draft.length > 6000
                }
                onClick={() => {
                  if (latestSignature.current !== draftSignature) return;
                  onUse(draft.trim());
                  setDraft("");
                  setDraftSignature("");
                }}
              >
                Use draft
              </button>
              <small className="hint">
                {" "}
                Replaces the prompt in this editor. Save the rule separately.
              </small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
