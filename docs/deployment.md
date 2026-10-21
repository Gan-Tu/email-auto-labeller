# Cloud Run deployment

The app uses Cloud Run, a named Firestore database, Secret Manager, Pub/Sub, and Cloud Scheduler. Configure your own project, domain, identities, and mailbox allowlist; no deployment-specific credentials or account state belong in this repository.

## Provision Google Cloud

1. Enable the Cloud Run, Cloud Build, Artifact Registry, Firestore, Secret Manager, Pub/Sub, Cloud Scheduler, and Gmail APIs needed by your installation.
2. Create the Firestore database. Give the runtime service account access to that database and only the application's Secret Manager entries.
3. Store the OAuth client secret, Decisions API key, and token encryption key in Secret Manager. Imported mailbox grants may also need the original OAuth client credentials. See [setup](setup.md) and [`.env.example`](../.env.example) for runtime configuration.
4. Configure `BASE_URL`, the exact `APP_ORIGINS` allowlist, and each OAuth callback. Set up your custom domain and valid TLS certificate before making it the primary origin.
5. Create a Gmail notification topic in the OAuth client's project. Grant Gmail's publishing identity access to it. Create an authenticated push subscription targeting `https://your-app.example.com/hooks/gmail`.
6. Set `PUSH_SERVICE_ACCOUNT` and `SCHEDULER_SERVICE_ACCOUNT` to the exact service-account emails used in Google OIDC tokens. Configure the token audience to match an allowed application origin. Use separate identities for runtime access and machine callers.

Gmail requires a watch topic in the project associated with the OAuth client making the request. If you move the application to a different project while preserving existing authorizations, retain the original OAuth client and topic, then deliver its subscription to the new service. Moving the runtime does not require deleting the original notification infrastructure.

Configure Firestore TTL policies for activity and authentication records: decision documents use `expiresAt`; session and OAuth transaction documents use `ttl`. TTL deletion is asynchronous. Check any additional retention requirements for durable jobs, executions, and rule versions before creating your own cleanup policy.

## Manual deployment

Provision and configure the initial Cloud Run service before using the deployment helper. Set its runtime service account, application environment, Secret Manager bindings, and allowed callers using the configuration above. The helper updates application code; it does not replace the initial resource setup.

[`scripts/deploy.sh`](../scripts/deploy.sh) requires `PROJECT_ID`. `SERVICE_NAME` defaults to `email-auto-labeller`, and `REGION` defaults to `us-central1`. Existing runtime configuration, secrets, and processing state are preserved. Exporting `PROCESSING_ENABLED` does not change the service through this helper. The script requires a clean, committed checkout so `RELEASE_SHA` identifies the deployed source.

```sh
npm ci
npm run check
npm test
npm run build
PROJECT_ID=your-google-project scripts/deploy.sh
```

Configure staging with processing disabled directly on Cloud Run. After checking the staged application, enable it explicitly:

```sh
gcloud run services update email-auto-labeller \
  --project=your-google-project --region=us-central1 \
  --update-env-vars=PROCESSING_ENABLED=true
```

Use the same command with `PROCESSING_ENABLED=false` to disable background processing.

Disabled processing pauses background classification and renewal; rule edits and deliberate dry-run tests still work.

## Automatic deployment from GitHub

Connect your repository through the Google Cloud Build GitHub app and create a push trigger for branch `^main$`, using [`cloudbuild.yaml`](../cloudbuild.yaml).

Configure these trigger substitutions:

| Substitution           | Example / default         |
| ---------------------- | ------------------------- |
| `_SERVICE_NAME`        | `email-auto-labeller`     |
| `_REGION`              | `us-central1`             |
| `_ARTIFACT_REPOSITORY` | `cloud-run-source-deploy` |

Cloud Build supplies `PROJECT_ID` and `COMMIT_SHA`. Create the target Artifact Registry repository and configure the trigger's build identity to write images, deploy the intended Cloud Run service, and act as its runtime identity. Keep API/OAuth credentials in Secret Manager; the build does not need a GitHub secret containing a Google service-account key.

The pipeline installs dependencies, runs type checks, tests, and the application build, then builds and pushes a Docker image. It deploys that image and its `RELEASE_SHA` to Cloud Run. Deployment updates the image and release identifier only: runtime environment, secret bindings, and processing state stay as configured on the service.

The separate [GitHub CI workflow](../.github/workflows/ci.yml) runs checks on pull requests and pushes to `main`; it does not deploy.

Verify the repository connection, branch filter, trigger configuration, and a completed build before relying on automatic deployment. Read back the serving revision and `/health` release identifier after a push. Keep deployment permissions limited to maintainers who should be able to change the running app.

## Schedule recovery and renewal

Create authenticated HTTP Cloud Scheduler jobs:

| Route           | Recommended schedule | Purpose                                          |
| --------------- | -------------------- | ------------------------------------------------ |
| `/jobs/catchup` | Every five minutes   | Read missed Gmail history and retry pending jobs |
| `/jobs/renew`   | Daily                | Renew watches for enabled mailboxes              |

Use the configured scheduler service account and audience. Pub/Sub retries and the catch-up job complement one another; a healthy HTTP endpoint alone does not prove that Gmail delivery is working.

## Verify the installation

Before relying on automatic match actions:

- Confirm the expected release at `/health`, a valid domain certificate, and successful browser sign-in.
- Confirm unauthorized API, push, and scheduler requests are rejected.
- Read back each connected Gmail identity and confirm its labels and rule mappings.
- Use dry-run tests to verify multiple-choice output, no match, and threshold behavior with the configured Decisions model.
- Observe real Gmail push delivery to the deployed service. Verify a controlled positive message's actual Gmail label, an unchanged negative message, and preserved unread state unless mark-as-read is explicitly enabled. Compare them with their rule execution and activity records.
- Exercise several rules on one message and several choices within a rule. Verify batch edits preserve unselected fields and mailbox-specific mappings.
- Verify catch-up and watch renewal at the mailbox level, and confirm transient failures recover without repeated classification or duplicate drafts or forwards.

The API smoke verifier requires exactly two `VERIFY_EMAILS` addresses. The live delivery verifier checks all configured allowed accounts by default; `--email` explicitly narrows that scope. The generalized rule verifier requires `--email` or `VERIFY_EMAIL`. Evidence defaults to ignored `.local/` paths. Inspect each script’s arguments before use. Some live checks insert disposable messages directly into test mailboxes and clean them up afterward; they do not send email. Keep test evidence and local operator notes outside tracked source.

## Migrate a recruiting-only installation

Migration preserves encrypted account authorizations, ownership, cursors, prompts, thresholds, enabled states, label IDs, recruiting draft preferences, prior decisions, and draft intents. It creates one versioned rule per source mailbox, initially with Recruiting plus automatic No match.

Configure the destination environment and these source variables:

| Variable                            | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `SOURCE_PROJECT`, `SOURCE_DATABASE` | Source Firestore project and database                    |
| `SOURCE_SERVICE`, `SOURCE_REGION`   | Original service and region                              |
| `SOURCE_PUSH_SUBSCRIPTION`          | Subscription whose old delivery must stop before cutover |
| `SOURCE_SCHEDULER_PREFIX`           | Prefix identifying the original scheduler jobs           |

Use the original token encryption key and relevant OAuth client credentials. With automatic destination processing disabled:

```sh
node --env-file=.env.local --import tsx scripts/migrate-recruiting.ts inspect
node --env-file=.env.local --import tsx scripts/migrate-recruiting.ts stage
node --env-file=.env.local --import tsx scripts/migrate-recruiting.ts verify
```

Inspect validates source mailbox identity and label availability. Stage copies state for preview, and verify compares it with the source. The original service can continue processing during staging, so a final snapshot is still necessary.

For cutover:

1. Pause the original scheduler jobs and disable the old subscription's delivery, retaining the backlog. Wait for in-flight workers to finish.
2. Run `scripts/migrate-recruiting.ts cutover`, then `verify`, using the same protected environment. Cutover checks old delivery and worker leases before copying final state.
3. Enable destination processing explicitly with `gcloud run services update ... --update-env-vars=PROCESSING_ENABLED=true`, direct authenticated push delivery and scheduler jobs to the new service, and verify live labeling.
4. Remove the original compute service only after destination delivery and Gmail readback pass. Retain OAuth/topic dependencies still needed by imported authorizations.

Stage/cutover refuse to overwrite a destination that already contains processed message jobs. Do not rerun them after destination processing begins. Once rules or account state intentionally change, source-parity verification is no longer a meaningful completion check; inspect the current destination directly.

## Recovery

Inspect mailbox errors, rule errors, pending jobs, and saved predictions before changing state. Reconnect an expired authorization; repair a deleted label mapping in its rule. Do not reset cursors or delete jobs merely to clear an error.

Before rollback, stop destination processing and delivery. Reconcile completed executions, cursors, and draft/forward intents before reactivating an older worker. Running both workers against unreconciled checkpoints risks repeating actions.

## Per-choice action compatibility

Choices support one or more of: multiple Gmail labels, a reply draft, mark-as-read, and forwarding to a custom email address. New choices start with all actions off and require at least one before saving. Drafts remain unsent; forwarding explicitly sends a readable summary and the untouched original message as `original.eml`, including its attachments. Forward only the matched incoming message even for conversation scope. No new OAuth scope is required beyond the existing `gmail.modify` grant.

Old single-label mappings and selected-choice reply templates are normalized on read; editing saves per-choice actions. Preserve immutable rule-version snapshots, queued jobs, existing draft intents, and legacy execution checkpoints. Mark-as-read and forwarding remain disabled on existing rules. Explicit new actions must not fall back to old label/draft settings.

Action results are checkpointed independently. `forwardIntents` account subcollections reserve each message/destination across rules, versions, and retries. Pending or unknown delivery is never automatically resent. Keep both `draftIntents` and `forwardIntents` outside completion-based TTL cleanup; include them in manual account-data deletion and rollback reconciliation. Deleting reservations while old jobs can replay can duplicate external actions.

Validate draft-only, read-only, multi-label, and forwarding combinations with mocked Gmail writes. Live forwarding verification sends real email and must use an explicitly authorized controlled destination. Dry-run previews do not execute any action.

## Retire migration OAuth credentials

After reconnecting every mailbox, verify that every account (including paused accounts) has `clientType: web` and an explicit `oauthClientId` matching the current `GOOGLE_CLIENT_ID`. Check other services and jobs for shared dependencies before retiring credentials.

Remove the `PREVIOUS_WEB_GOOGLE_CLIENT_ID`, `PREVIOUS_WEB_GOOGLE_CLIENT_SECRET`, `LEGACY_GOOGLE_CLIENT_ID`, and `LEGACY_GOOGLE_CLIENT_SECRET` secret bindings from Cloud Run, plus `PREVIOUS_WEB_GMAIL_TOPIC` and `LEGACY_GMAIL_TOPIC`. Keep the current OAuth pair and `GMAIL_TOPIC`. The application already supports this configuration; subsequent source deployments preserve it.

Verify the new revision and authenticated mailbox reads before deleting the old secrets. Historical revisions retain their old references and cannot safely be restarted after deletion; roll back code by deploying the older image with the current configuration instead. Retiring Secret Manager entries does not delete OAuth clients or Pub/Sub infrastructure.
