# Email Auto Labeller

Classify incoming Gmail messages with your own prompts and apply the right labels automatically.

Each mailbox has independent rules. A rule combines a classification prompt with multiple-choice answers, and each answer maps to an existing Gmail label. For example:

| Choice     | When to select it                                            | Gmail label       |
| ---------- | ------------------------------------------------------------ | ----------------- |
| Recruiting | Personally directed outreach about an employment opportunity | `Work/Recruiting` |
| Consulting | An offer for paid consulting or contract work                | `Work/Consulting` |
| No match   | None of the choices applies, or the intent is unclear        | No label          |

## Features

- **Mailbox-specific rules:** up to 20 rules per mailbox and 12 labeled choices per rule. No match is always included.
- **Structured editor:** write a prompt, describe each answer, and select labels from the connected mailbox. Labels are stored by ID, so renaming a label preserves its mapping.
- **Batch editing:** update prompts, choices, thresholds, or enabled states across selected rules and inboxes. Keep/Replace controls preserve unselected fields; per-mailbox label mapping and a review step precede an atomic update.
- **Dry-run tests:** classify pasted email text or an existing Gmail message using unsaved settings, without changing Gmail.
- **Activity history:** inspect each rule's answer, selected probability, applied label, uncertainty, and errors.
- **Reliable processing:** durable message jobs, versioned rule snapshots, saved predictions, and retryable Gmail actions.

Multiple rules can add different labels to one message. Each rule selects at most one label. No match and low-probability results leave labels unchanged. The app does not mark messages read or send email.

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
  → saved predictions → Gmail labels → per-rule activity
```

Each enabled rule becomes an independent named `choice` question in the OpenAI Decisions API. Rules share the conversation context in one request. The selected choice's **probability** is compared with the rule's threshold; the API's separate **confidence** value is recorded separately. A refusal applies no label.

New rules default to labeling the incoming message, with the conversation used as context. Conversation scope can label eligible incoming messages in the thread. Sent mail, drafts, spam, and trash are excluded; automatically archived incoming messages remain eligible. Email content is treated as data, never as instructions to the classifier.

Jobs are stored before the Gmail history cursor advances. Rule versions are captured when work is queued, and predictions are stored before Gmail writes. Duplicate notifications reuse existing work; transient failures retry. Deleted labels surface as rule errors instead of silently choosing another label.

Mailbox pause stops all its rules. Resuming skips messages received during the pause while retaining work queued beforehand. A five-minute catch-up job and daily watch renewal provide recovery from missed notifications and expiring watches.

## Privacy and access

This is a self-hosted, allowlisted workspace. Configure `OWNER_EMAIL` and `ALLOWED_EMAILS` for your deployment. Browser changes require an authenticated session, allowed origin, and CSRF token. Webhook and scheduler requests verify the Google OIDC audience and caller identity.

Refresh tokens are encrypted with AES-256-GCM. Email bodies are processed in memory and sent to OpenAI for classification. Activity stores subjects and decision metadata with expiration timestamps; configure Firestore TTL policies as described in the deployment guide. The UI displays the latest 500 records in pages of 25.

An optional recruiting-specific action can prepare a decline **draft**, never send it. It requires the single Recruiting choice and checks for prior replies, LinkedIn messages, and existing drafts. Review the draft text before enabling this action; `DECLINE_REPLY_TEXT` can supply a custom reply. Multiple-choice replacement disables incompatible recruiting drafts explicitly.

## Deployment

The included container runs on Cloud Run. The [deployment guide](docs/deployment.md) covers Google Cloud configuration, GitHub push deployment, staging, live delivery checks, and migration from a recruiting-only installation. Keep credentials in Secret Manager. A Cloud Build trigger connected to GitHub validates and deploys pushes to `main`, preserving the service’s configured environment and secrets.

`PROCESSING_ENABLED=false` disables automatic classification and watch renewal during staging. Editing rules still persists changes, and an explicit dry-run test still calls the Decisions API.

## Code layout

- `web/src/` — React and TypeScript UI.
- `server/rules.ts` — validation, mailbox label checks, versioning, and atomic updates.
- `server/classifier.ts` — Decisions questions and response parsing.
- `server/store.ts`, `server/worker.ts` — durable ingestion, retries, Gmail actions, and activity.
- `scripts/` — deployment, migration, and verification tools.
- `docs/` — [setup](docs/setup.md), [deployment](docs/deployment.md), and [UI design decisions](docs/ui-decisions.md).

## References

- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Pub/Sub with Cloud Run](https://docs.cloud.google.com/run/docs/tutorials/pubsub)
- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)

## License

No license has been selected. Package metadata is `UNLICENSED`.
