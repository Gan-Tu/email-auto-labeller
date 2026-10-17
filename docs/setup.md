# Setup

## Prerequisites

- Node 22.12 or newer and npm.
- A Google Cloud project, named Firestore database, Gmail API, OAuth web client, and Pub/Sub topic.
- An OpenAI API key with access to the Decisions API and configured model.
- The `gcloud` CLI for cloud administration and operator scripts.

The example configuration is in [`.env.example`](../.env.example). Copy it to `.env.local` for local work, keep it owner-readable, and replace every placeholder. Production values belong in Cloud Run configuration and Secret Manager.

## Google OAuth and Gmail

Create a web OAuth client and configure its consent screen. Register the callback for each exact origin you will use:

```text
http://localhost:8080/auth/google/callback
http://localhost:5173/auth/google/callback
https://your-app.example.com/auth/google/callback
```

Only register origins you operate. Set `BASE_URL` to the current primary origin; `APP_ORIGINS` is an optional pipe-separated list of additional exact origins. The OAuth flow requests identity scopes and `gmail.modify`. An OAuth app in testing may restrict users or grant duration; arrange the appropriate Google verification and publishing state for your use case.

Set `OWNER_EMAIL` to the workspace administrator and `ALLOWED_EMAILS` to a comma-separated list of Gmail/Google Workspace addresses allowed to connect, including the owner. This repository does not provide open public account registration.

Create a Pub/Sub topic in the **same Google Cloud project as the OAuth client** used to register Gmail watches. Grant `gmail-api-push@system.gserviceaccount.com` permission to publish to that topic. Set `GMAIL_TOPIC` to its full resource name:

```text
projects/your-google-project/topics/gmail-notifications
```

A local server can test OAuth, rules, and dry runs. Automatic Gmail delivery requires a reachable authenticated push endpoint; use the deployment guide to configure the production subscription and scheduler.

## Configuration

| Variable                                                 | Purpose                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`                                   | Project containing the app's Firestore data                                |
| `FIRESTORE_DATABASE`                                     | Named Firestore database                                                   |
| `BASE_URL`                                               | Primary app origin, without a path                                         |
| `APP_ORIGINS`                                            | Optional additional origins, separated by the pipe character               |
| `OWNER_EMAIL`                                            | Workspace administrator                                                    |
| `ALLOWED_EMAILS`                                         | Comma-separated mailbox allowlist                                          |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`               | Browser OAuth client                                                       |
| `LEGACY_GOOGLE_CLIENT_ID`, `LEGACY_GOOGLE_CLIENT_SECRET` | Optional original client for imported authorizations                       |
| `OPENAI_API_KEY`                                         | Decisions API credential                                                   |
| `DECISIONS_MODEL`                                        | Decisions model; defaults to `gpt-6-luna`                                  |
| `TOKEN_ENCRYPTION_KEY`                                   | 32 random bytes encoded as base64; see `.env.example`                      |
| `GMAIL_TOPIC`                                            | Full Pub/Sub topic name                                                    |
| `PUSH_SERVICE_ACCOUNT`                                   | Exact OIDC email accepted for Gmail pushes                                 |
| `SCHEDULER_SERVICE_ACCOUNT`                              | Exact OIDC email accepted for scheduled jobs                               |
| `PROCESSING_ENABLED`                                     | Set `false` while staging; set `true` for automatic processing             |
| `DECLINE_REPLY_TEXT`                                     | Optional plain-text recruiting decline draft; blank uses a neutral default |
| `OWNER_DISPLAY_NAME`                                     | Optional display name for the operator localhost preview                   |
| `PORT`                                                   | API server port; defaults to `8080`                                        |

Production requires an HTTPS `BASE_URL` and explicit project, database, owner, allowlist, topic, and caller identities. Automatic processing defaults off; enable it explicitly when the installation is ready.

Keep `TOKEN_ENCRYPTION_KEY` stable for existing encrypted accounts. When importing authorizations, use the original encryption key and original OAuth client credentials; replacing either does not migrate existing tokens.

## Local development

Authorize local access to the chosen Firestore project:

```sh
gcloud auth application-default login
npm ci
```

Run the production-style app on port 8080:

```sh
npm run build
node --env-file=.env.local dist/server/index.js
```

For development, use `BASE_URL=http://localhost:5173`. Start the API with `node --env-file=.env.local --import tsx server/index.ts` and run `npm run dev` in another terminal. The Vite proxy forwards `/api` and `/auth` to the API server.

```sh
npm run check
npm test
npm run build
```

Operator scripts that import `scripts/local-auth.ts` use the existing signed-in `gcloud` account (`gcloud auth login`). Normal application runtime uses Google Application Default Credentials locally and the Cloud Run runtime identity in production.

## Operator localhost preview

`scripts/local-server.ts --authenticated-preview` provides privileged access as the configured owner to the real selected Firestore database. Rule edits and tests operate on that database. Use it only on loopback; never expose or tunnel it. The script requires a localhost `BASE_URL` and `PROCESSING_ENABLED=false`, and is excluded from the production Docker image.

## First rule

1. Connect an allowed mailbox and confirm its identity.
2. Create a rule or adapt the Recruiting starter rule.
3. Describe the task in the prompt and the boundaries of each choice in its description.
4. Select one different existing Gmail label per labeled choice. Create missing labels in Gmail first.
5. Run a dry test, inspect the result and threshold, then save.

A rule supports 12 labeled choices plus automatic No match. Thresholds range from 50% to 99.9%. Different rules can independently add labels to the same message. Rule creation and edits apply prospectively; this UI does not initiate a historical backfill.
