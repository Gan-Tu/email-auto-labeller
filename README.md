# Email Auto Labeller

Classify incoming Gmail messages with your own prompts and run the actions you choose automatically.

Each mailbox has independent rules. A rule combines a classification prompt with multiple-choice answers, and each answer has its own match actions. For example:

| Choice     | When to select it                                            | Gmail label       |
| ---------- | ------------------------------------------------------------ | ----------------- |
| Recruiting | Personally directed outreach about an employment opportunity | `Work/Recruiting` |
| Consulting | An offer for paid consulting or contract work                | `Work/Consulting` |
| No match   | None of the choices applies, or the intent is unclear        | No label          |

## Features

- **Mailbox-specific rules:** up to 20 rules per mailbox and 12 choices per rule. No match is always included.
- **Structured editor:** write a prompt, describe each answer, and choose one or more actions: add Gmail labels, create a reply draft, mark as read, or forward to an email address. Labels are stored by ID, so renaming a label preserves its mapping.
- **Batch editing:** update prompts, choices, thresholds, or enabled states across selected rules and inboxes. Keep/Replace controls preserve unselected fields; per-mailbox label mapping and a review step precede an atomic update.
- **Rule behavior:** protect conversations by existing labels, including optional nested labels, and prepare editable reply drafts for selected choices.
- **Dry-run tests:** classify pasted email text or an existing Gmail message using unsaved settings, without changing Gmail.
- **Activity history:** inspect each rule's answer, selected probability, each action’s result, uncertainty, and errors.
- **Reliable processing:** durable message jobs, versioned rule snapshots, saved predictions, and retryable Gmail actions.

Each enabled rule independently selects at most one choice. A choice can add multiple labels and combine any of the four actions. All actions start off: no labels, no draft, no forwarding, and unchanged read status. Saving requires at least one action per choice; the automatic No match choice has no actions. No match, refusal, and low-probability results leave Gmail unchanged. Drafts stay unsent; an explicitly configured forwarding action sends an email to its destination.

## Quick start

Requires Node **22.12+**, npm, a Google Cloud project with Gmail/OAuth, Firestore and Pub/Sub configured, and an OpenAI API key with Decisions API access.

```sh
npm ci
cp .env.example .env.local
```

Fill in `.env.local` using [the setup guide](docs/setup.md). It is ignored by Git. Then run:

```sh
npm run check
npm test
npm run build
node --env-file=.env.local dist/server/index.js
```

For frontend development, run the API and Vite in separate terminals:

```sh
node --env-file=.env.local --import tsx server/index.ts
```

```sh
npm run dev
```

Use `BASE_URL=http://localhost:5173` for the Vite frontend and register the matching OAuth callback. Vite proxies `/api` and `/auth` to port 8080.

## How it works

```text
Gmail notification → authenticated Pub/Sub push → Gmail history
  → durable message jobs → Decisions API choice questions
  → saved predictions → configured match actions → per-rule activity
```

Each enabled rule becomes an independent named `choice` question in the OpenAI Decisions API. Rules share the conversation context in one request. The selected choice's **probability** is compared with the rule's threshold; the API's separate **confidence** value is recorded separately. A refusal runs no actions.

New rules default to incoming-message scope, with the conversation used as context. Conversation scope can label or mark read eligible incoming messages in the thread. Forwarding sends only the matched incoming message, regardless of context scope. Sent mail, drafts, spam, and trash are excluded; automatically archived incoming messages remain eligible. Email content is treated as data, never as instructions to the classifier.

Jobs are stored before the Gmail history cursor advances. Rule versions are captured when work is queued, and predictions are stored before Gmail writes. Duplicate notifications reuse existing work; transient failures retry. Deleted labels surface as rule errors instead of silently choosing another label.

Mailbox pause stops all its rules. Resuming skips messages received during the pause while retaining work queued beforehand. A five-minute catch-up job and daily watch renewal provide recovery from missed notifications and expiring watches.

## Privacy and access

This is a self-hosted, allowlisted workspace. Configure `OWNER_EMAIL` and `ALLOWED_EMAILS` for your deployment. Browser changes require an authenticated session, allowed origin, and CSRF token. Webhook and scheduler requests verify the Google OIDC audience and caller identity.

Refresh tokens are encrypted with AES-256-GCM. Email bodies are processed in memory and sent to OpenAI for classification. Activity stores subjects and decision metadata with expiration timestamps; configure Firestore TTL policies as described in the deployment guide. The UI displays the latest 500 records in pages of 25.

Every rule can protect up to 50 existing labels, optionally including nested labels. If any selected label is present, the entire conversation is skipped. Each choice can optionally create a reply draft with editable plain text of up to 6,000 characters. Drafts are prepared only for selected matches at or above the threshold; replied conversations, existing drafts, and automated messages are skipped. Drafts are never sent.

Forwarding sends a readable plain-text summary with an untouched `original.eml` attachment containing the original message and attachments. Self-directed, original-sender, and previously forwarded messages are skipped to prevent loops. A durable reservation for each mailbox/message/destination prevents duplicate forwards across rules and retries; uncertain delivery is reported and never resent automatically. Each action has a separate result and checkpoint so failures do not hide other actions’ successes.

Existing single-label choices and rule-level draft settings are normalized into per-choice actions when read and saved in the new format when edited. Existing mark-read and forwarding settings remain off. Historical versions and queued snapshots remain immutable and retain their legacy execution behavior. Explicit new action settings override legacy values. Batch edits preserve actions unless choices are replaced, with separate label mapping for each mailbox. `DECLINE_REPLY_TEXT` remains the fallback only for older recruiting draft settings.

See [OAuth verification readiness](docs/oauth-verification.md) for public disclosure pages, consent-screen configuration, and the verification process.

## Deployment

The included container runs on Cloud Run. The [deployment guide](docs/deployment.md) covers Google Cloud configuration, GitHub push deployment, staging, live delivery checks, and migration from a recruiting-only installation. Keep credentials in Secret Manager. A Cloud Build trigger connected to GitHub validates and deploys pushes to `main`, preserving the service’s configured environment and secrets.

`PROCESSING_ENABLED=false` disables automatic classification and watch renewal during staging. Editing rules still persists changes, and an explicit dry-run test still calls the Decisions API.

## Code layout

- `web/src/` — React and TypeScript UI.
- `server/rules.ts` — validation, mailbox label checks, versioning, and atomic updates.
- `server/classifier.ts` — Decisions questions and response parsing.
- `server/store.ts`, `server/worker.ts` — durable ingestion, retries, Gmail actions, and activity.
- `scripts/` — deployment, migration, and verification tools.
- `docs/` — [setup](docs/setup.md), [deployment](docs/deployment.md), [OAuth verification](docs/oauth-verification.md), and [UI design decisions](docs/ui-decisions.md).

## References

- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Pub/Sub with Cloud Run](https://docs.cloud.google.com/run/docs/tutorials/pubsub)
- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)

## License

No license has been selected. Package metadata is `UNLICENSED`.
