# Google OAuth production preparation

This document is an operator checklist, not evidence that Google has approved the app. Publishing a privacy page does not complete brand verification, restricted-scope verification, or a security assessment.

## Public application information

Set `BASE_URL` to the HTTPS application origin. The app exposes these pages without requiring sign-in:

| URL                   | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `${BASE_URL}/about`   | Public product homepage describing rules, classification, labels, drafts, and data flow |
| `${BASE_URL}/privacy` | Data access, storage, sharing, retention, Limited Use, and deletion requests            |
| `${BASE_URL}/terms`   | Operational terms, authorization, and user review responsibilities                      |
| `${BASE_URL}/support` | Connection help, private security reporting, and manual deletion requests               |

Use `/about` as the OAuth application homepage. Google requires a description of the app; a login-only page is insufficient. The homepage and OAuth consent screen must link to the same privacy URL on the app's domain. Keep these links visible inside the app as well. [Google verification requirements](https://support.google.com/cloud/answer/13464321)

`SUPPORT_EMAIL` defaults to the operator-approved public contact `dev@tugan.io`; `OPERATOR_NAME` defaults to `Gan Tu`. A self-hosted deployment must replace these values and review its policy before inviting users. The app operator's contact must match the applicable OAuth branding and support information. Do not copy another operator's policy without matching its statements to your deployment.

Before release, check public pages over HTTPS, including CSS and logo; their canonical URLs derive from `BASE_URL`. The Google connection flow should prominently explain the OpenAI transfer and obtain an affirmative agreement before redirecting to Google. Record the accepted disclosure version and time. Do not treat OAuth scope consent alone as an undisclosed AI-data-sharing notice.

## Choose the correct OAuth project

Google branding and verification are project-level concerns shared by that project's OAuth clients. A new client in an existing, differently branded project does not by itself create a separately branded application. For a distinct production app, use a dedicated production OAuth project with the correct app name, homepage, privacy policy, logo, support email, developer contacts, and intended scopes. Google recommends separate development/test and production projects. [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [verification exceptions](https://support.google.com/cloud/answer/13464323)

Do not delete shared clients or revoke shared grants during preparation. Existing refresh tokens are bound to their issuing OAuth clients. Moving to a new client requires a deliberate reconnection plan. Gmail's notification topic must be in the OAuth caller's developer project, even when Cloud Run is hosted in another project; route its authenticated Pub/Sub subscription to the application. [Gmail watch reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)

During a transition, preserve per-inbox credential routing: each stored refresh token must continue using its issuing OAuth client and the Gmail topic for that client's project until that mailbox explicitly reconnects. Keep old client secrets and notification routing available while any mailbox still depends on them. New authorizations can use the new production client without silently reassigning old tokens. Configure the supported per-inbox credential/topic environment mapping documented by the deployment, and verify a profile read and watch renewal for every client cohort before retiring a client. A shared project that already hosts other branded clients needs the same project-level branding review; simply choosing another existing client is not isolation.

The transition configuration is:

- New web authorizations use `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GMAIL_TOPIC`; the account records the issuing client in `oauthClientId`.
- Previous web credentials use the paired `PREVIOUS_WEB_GOOGLE_CLIENT_ID` and `PREVIOUS_WEB_GOOGLE_CLIENT_SECRET`, with `PREVIOUS_WEB_GMAIL_TOPIC`. Production requires the previous-web topic when that client pair is configured. Older web accounts without a recorded client ID use this previous client when configured, so enabling it must match the actual origin of those tokens.
- Imported legacy accounts use `LEGACY_GOOGLE_CLIENT_ID`, `LEGACY_GOOGLE_CLIENT_SECRET`, and `LEGACY_GMAIL_TOPIC`. The legacy topic falls back to the previous-web topic and then `GMAIL_TOPIC`; set it explicitly when projects differ.
- `ADDITIONAL_PUSH_SERVICE_ACCOUNTS` is an optional comma-separated allowlist of additional verified delivery identities alongside `PUSH_SERVICE_ACCOUNT`. Use it only for the old/new Pub/Sub delivery identities required during the transition. An explicit unknown stored OAuth client ID fails closed rather than silently using another client.

After every mailbox reconnects and readback confirms its new issuing client and watch, the operator can deliberately retire old credential/topic routing. Configuration alone does not migrate a refresh token or authorize revoking a shared grant.

Verify ownership of the registrable authorized domain through Google Search Console using an account associated with the OAuth project. Register the exact callback `${BASE_URL}/auth/google/callback`; include only additional origins and callbacks that are actually used. Match the name and logo on the website, consent screen, and demonstration video. Publish verified branding before requesting Data Access verification. [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)

## Scope justification

The application requests `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.modify`.

| Scope                        | Implemented purpose                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`, `email`, `profile` | Confirm the account identity and display its signed-in name and email.                                                                                           |
| `gmail.modify`               | Read incoming mail and conversation context, watch changes, inspect mailbox labels, apply labels to messages, and prepare optional user-configured reply drafts. |

`gmail.modify` is a **restricted** scope. `gmail.readonly` cannot apply labels or create drafts; `gmail.labels` manages label definitions but does not provide message-body access or authorize assigning labels to messages. `gmail.send` alone cannot support the classification and labeling workflow. The app does not request full `https://mail.google.com/` access, does not permanently delete mail, and has no automatic send action. The consent screen may describe capabilities broader than the subset the app implements; explain this truthfully. [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)

Declare the scopes actually requested by every client in the submission. If the shared legacy project serves other applications or scopes, resolve that scope and branding mismatch before presenting this app as the entire project. Do not add speculative permissions.

## Data-handling facts to preserve

- Google Cloud hosts the app; Firestore stores connection metadata, encrypted refresh tokens, rule configuration and version snapshots, pending work, message subjects/identifiers, classification results, and action outcomes.
- Full email bodies are processed in memory rather than stored in the app database. The OpenAI Decisions API receives mailbox identity, message identifiers, conversation headers/text, classification prompts, and choice descriptions.
- Refresh tokens use AES-256-GCM with a per-write random nonce and mailbox identity as authenticated context. Protect the encryption key and retain it through credential migration.
- Completed activity, jobs, and executions are scheduled to expire after 30 days. Enable the appropriate Firestore TTL policies and remember deletion is asynchronous. Pending work has no completion-based TTL. Account settings, rules/version snapshots, consent records, and draft-intent reservations need an explicit deletion process.
- Sessions expire after seven days and OAuth transactions after ten minutes. Configure their database expiry policies. Confirm Cloud Logging and backup retention separately; do not claim these match application-record TTLs.
- Disconnect pauses the mailbox and erases its stored refresh credential. It does not erase every app record, revoke the Google grant, or remove Gmail labels or drafts. The public support address provides the current manual deletion-request channel.

OpenAI documents no API model training by default. For Decisions, default abuse-monitoring retention is up to 30 days, with documented exceptions; encrypted prompt caching can persist for up to 24 hours. Confirm the actual API organization/project settings, keep Google-data training and data-sharing opt-ins disabled, and do not claim Zero Data Retention without an approved and verified configuration. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

The published Limited Use commitment must match operations: no selling Google user data, advertising uses, credit decisions, or general-purpose AI training; provider transfers must serve the consented, visible email-productivity features. Human access requires an allowed purpose. Provider and operator practices must honor these restrictions. [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), [Google Workspace policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

## Deletion-request operating procedure

1. Verify that the requester controls the mailbox or is authorized to request workspace deletion. Never request their password or OAuth token.
2. Pause the affected mailbox, prevent new work, and wait for in-flight processing to finish under the existing mailbox lock.
3. Identify all applicable account subcollections, rule versions, jobs, executions, activity, draft-intent records, sessions, and pending OAuth transactions. Check retained migration copies and backups too. Removing an account document alone does not delete Firestore subcollections.
4. Remove the agreed app records and stored credentials through a reviewed operator procedure; confirm completion and explain any specific retention exception. Do not claim this step is automated in the current UI.
5. Explain separate Google grant revocation and Gmail cleanup. Revoking a shared OAuth application can affect other integrations. Do not revoke shared authorizations or alter Gmail contents without the user's instruction.

Test and document this procedure before a broad public launch. Support requests should not solicit raw email contents. Never put private request evidence into the public repository.

## Submission walkthrough and external dependencies

Use a dedicated review mailbox with synthetic data. The app currently uses an allowlist, so arrange explicit reviewer access without exposing production mailboxes or disabling authorization. A public GitHub repository does not make the hosted app open to every account.

Record an unlisted demonstration video showing:

1. The public homepage, privacy/support links, and pre-connection OpenAI disclosure.
2. The complete Google authorization flow in English, correct app identity, client ID, and requested scopes.
3. Creating a prompt with multiple choices and mapping choices to existing Gmail labels.
4. Testing a rule, enabling it, receiving a synthetic message, and checking the applied label and activity entry.
5. Independent rules, batch editing, protected labels, and an explicitly enabled draft action; show that drafts remain unsent.
6. Pausing, disconnecting, and finding the deletion-request instructions.

Google may require additional information and an annual independent CASA security assessment because this server-based app accesses and transfers restricted-scope data. Personal-use and internal-use exceptions have specific conditions; the operator must confirm which applies. Do not claim an exception, completed assessment, or verified status solely because the app has a privacy notice. [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

An external OAuth app left in Testing normally receives refresh tokens that expire after seven days when Gmail scopes are requested. Production publishing and successful verification are separate states; publishing alone is not evidence of approval. [OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [production and testing projects](https://support.google.com/cloud/answer/13464323)

Outstanding console/provider work must be verified independently: production audience, published branding, authorized domains/callbacks, current support contacts, declared scopes, reviewer access, OpenAI data controls, actual retention policies, demonstration video, and any assessment requested by Google. These source files do not configure or complete that work.
