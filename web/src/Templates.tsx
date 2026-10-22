import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { api, post, type RuleInput, type RuleTemplate, type User } from "./api";
import { Dialog } from "./Dialog";
import { recruitingTemplate } from "./rules";

export function Templates({
  user,
  defaultPrompt,
  refreshKey,
  canCreateRule,
  onCreate,
  onEdit,
  onCustomize,
  onUse,
  onSaved,
}: {
  user: User;
  defaultPrompt: string;
  refreshKey: number;
  canCreateRule: boolean;
  onCreate: () => void;
  onEdit: (template: RuleTemplate) => void;
  onCustomize: (input: RuleInput) => void;
  onUse: (input: RuleInput) => void;
  onSaved: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<RuleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [deleting, setDeleting] = useState<RuleTemplate>();
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ templates: RuleTemplate[] }>("/api/rule-templates", {
      signal: controller.signal,
    })
      .then(({ templates }) => {
        if (!controller.signal.aborted) setTemplates(templates);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey, reload]);
  const query = search.trim().toLowerCase();
  const visible = templates.filter((template) =>
    `${template.name} ${template.prompt} ${template.choices.map((choice) => choice.name).join(" ")}`
      .toLowerCase()
      .includes(query),
  );
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      await api(
        `/api/rule-templates/${encodeURIComponent(deleting.id)}`,
        post(user, "DELETE", { expectedVersion: deleting.version }),
      );
      setTemplates((current) =>
        current.filter((template) => template.id !== deleting.id),
      );
      setDeleting(undefined);
      onSaved("Template deleted. Existing rules are unchanged.");
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Rule templates" className="templates-section">
      <div className="rules-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search templates"
            placeholder="Search templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="icon-button"
          aria-label="Refresh templates"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>
      {error ? (
        <div className="error notice" role="alert">
          {error}{" "}
          <button
            className="text-button"
            onClick={() => setReload((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {!query || "recruiting emails".includes(query) ? (
        <article className="template-card builtin-template">
          <div className="template-card-content">
            <div className="template-card-heading">
              <h3>Recruiting</h3>
              <span className="template-badge">Built-in</span>
            </div>
            <p>Personally directed outreach about an employment opportunity.</p>
          </div>
          <div className="template-card-actions">
            <button
              className="secondary"
              disabled={!defaultPrompt}
              onClick={() => onCustomize(recruitingTemplate(defaultPrompt))}
            >
              <Pencil size={15} /> Customize copy
            </button>
            <button
              className="text-button"
              disabled={!canCreateRule || !defaultPrompt}
              onClick={() => onUse(recruitingTemplate(defaultPrompt))}
            >
              Create rule <ArrowRight size={15} />
            </button>
          </div>
        </article>
      ) : null}
      <div className="template-list-heading">
        <h2>Your templates</h2>
        <span>{templates.length}</span>
      </div>
      {loading ? (
        <div className="empty" role="status">
          Loading templates…
        </div>
      ) : visible.length ? (
        <div className="template-list">
          {visible.map((template) => (
            <article className="template-card" key={template.id}>
              <div className="template-card-content">
                <button
                  className="template-title"
                  onClick={() => onEdit(template)}
                >
                  {template.name}
                </button>
                <p>{template.prompt}</p>
                <div className="template-details">
                  <span>
                    {template.choices.length}{" "}
                    {template.choices.length === 1 ? "choice" : "choices"}
                  </span>
                  <span>
                    {Math.round(template.threshold * 1000) / 10}% threshold
                  </span>
                  <span>
                    {template.scope === "thread"
                      ? "Conversation"
                      : "New message"}
                  </span>
                </div>
              </div>
              <div className="template-card-actions">
                <button
                  className="secondary"
                  onClick={() => onEdit(template)}
                  aria-label={`Edit template ${template.name}`}
                >
                  <Pencil size={15} /> Edit
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Delete template ${template.name}`}
                  onClick={() => {
                    setDeleteError("");
                    setDeleting(template);
                  }}
                >
                  <Trash2 size={16} />
                </button>
                <button
                  className="text-button"
                  disabled={!canCreateRule}
                  onClick={() => onUse(template)}
                >
                  Create rule <ArrowRight size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : !error ? (
        <div className="empty">
          <BookOpen size={25} />
          <h3>
            {templates.length
              ? "No templates match your search"
              : "Create your first template"}
          </h3>
          <p>
            {templates.length
              ? "Try a different name or keyword."
              : "Save prompts, choices, and actions to reuse across your mailboxes."}
          </p>
          {templates.length ? (
            <button className="secondary" onClick={() => setSearch("")}>
              Clear search
            </button>
          ) : (
            <button className="primary" onClick={onCreate}>
              <Plus size={16} /> Create template
            </button>
          )}
        </div>
      ) : null}
      <p className="footnote">
        Templates are private to your account. Editing a template affects future
        rules created from it.
        {!canCreateRule
          ? " Connect a mailbox to create a rule from a template."
          : ""}
      </p>
      {deleting ? (
        <Dialog
          title="Delete template"
          subtitle={`Delete “${deleting.name}”? Existing rules created from this template will keep working.`}
          onClose={() => setDeleting(undefined)}
          busy={busy}
        >
          {deleteError ? (
            <p className="error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Keep template
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete template"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
