import { useState } from "react";
import { api, post, mailboxPath, type Account, type User } from "./api";
import { Dialog } from "./Dialog";
export function AccountSettings({
  account,
  user,
  onClose,
  onSaved,
}: {
  account: Account;
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(account.enabled),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDisconnect, setConfirmDisconnect] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(mailboxPath(account.email), post(user, "PATCH", { enabled }));
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api(`${mailboxPath(account.email)}/disconnect`, post(user, "POST"));
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Mailbox settings"
      subtitle={account.email}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={save}>
        <label className="check-field">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            <strong>Process new emails</strong>
            <small>
              Pausing stops all rules. On resume, earlier queued work continues;
              emails received during the pause are skipped.
            </small>
          </span>
        </label>
        {account.lastError ? (
          <div className="error" role="alert">
            {account.lastError}
            <a href="/auth/google" className="text-button">
              Reconnect Gmail
            </a>
          </div>
        ) : null}
        <dl className="mailbox-details">
          <div>
            <dt>Last sync</dt>
            <dd>
              {account.lastSync
                ? new Date(account.lastSync).toLocaleString()
                : "No sync yet"}
            </dd>
          </div>
          <div>
            <dt>Gmail watch</dt>
            <dd>
              {account.watchExpires
                ? `Expires ${new Date(account.watchExpires).toLocaleString()}`
                : "Not active"}
            </dd>
          </div>
        </dl>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmDisconnect ? (
          <div className="disconnect-confirm">
            <p>
              Disconnect {account.email}? Classification will stop and Gmail
              access will be removed from this app.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirmDisconnect(false)}
                disabled={busy}
              >
                Keep connected
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                {busy ? "Disconnecting…" : "Disconnect mailbox"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="text-button danger"
            disabled={busy}
            onClick={() => setConfirmDisconnect(true)}
          >
            Disconnect
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
