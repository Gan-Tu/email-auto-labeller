import type { Express } from "express";
import { config } from "./config.js";

const appName = "Email Auto Labeller";
const updated = "October 17, 2026";
const googlePolicy =
  "https://developers.google.com/terms/api-services-user-data-policy";
const workspacePolicy =
  "https://developers.google.com/workspace/workspace-api-user-data-developer-policy";
const openaiData = "https://developers.openai.com/api/docs/guides/your-data";
const googleConnections = "https://myaccount.google.com/connections";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
function publicSettings() {
  const email = process.env.SUPPORT_EMAIL?.trim() || "dev@tugan.io";
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email))
    throw new Error("SUPPORT_EMAIL must be a valid email address");
  return { email, operator: process.env.OPERATOR_NAME?.trim() || "Gan Tu" };
}
const contact = (subject?: string) => {
  const { email } = publicSettings();
  return `<a href="mailto:${escapeHtml(email)}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}">${escapeHtml(email)}</a>`;
};
const external = (url: string, label: string) =>
  `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

/** bodyHtml is trusted, authored markup. Escape every interpolated user/config value. */
export function publicPage(
  title: string,
  bodyHtml: string,
  pagePath: string,
): string {
  const { operator } = publicSettings();
  const canonical = new URL(pagePath, config.baseUrl).href;
  const links = [
    ["/about", "About"],
    ["/privacy", "Privacy"],
    ["/terms", "Terms"],
    ["/support", "Support"],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f7f8f7"><meta name="description" content="Email Auto Labeller organizes Gmail with rules you control. Learn how it works, how your data is used, and how to get support."><title>${escapeHtml(title)} · ${appName}</title><link rel="canonical" href="${escapeHtml(canonical)}"><link rel="icon" href="/logo.png"><link rel="stylesheet" href="/public-pages.css"></head>
<body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/about"><img src="/logo.png" width="38" height="38" alt=""><span>${appName}</span></a><nav aria-label="Public information">${links.map(([href, label]) => `<a href="${href}"${pagePath === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}<a class="nav-app" href="/">Open app <span aria-hidden="true">↗</span></a></nav></header>
<main id="main" class="page">${bodyHtml}</main>
<footer class="site-footer"><div><strong>${appName}</strong><p>Operated by ${escapeHtml(operator)} · ${contact()}</p></div><nav aria-label="Footer"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></nav></footer></body></html>`;
}

function about() {
  return `<section class="hero"><p class="eyebrow">Your inbox, your rules</p><h1>Give every email<br>a place to go.</h1><p class="lead">Create a classification prompt, define the possible answers, and connect each answer to a Gmail label. Email Auto Labeller applies your rules as new mail arrives.</p><div class="actions"><a class="button" href="/auth/google">Connect with Google</a><a class="button button-secondary" href="/">Open your workspace</a></div><p class="small-note">This deployment is available to approved mailboxes. Connecting requires your permission.</p></section>
<section class="feature-grid" aria-label="How it works"><article class="card"><span class="step">01</span><h2>Define what matters</h2><p>Write a prompt and multiple-choice descriptions. Choose existing labels from the connected mailbox. “No match” always leaves labels unchanged.</p></article><article class="card"><span class="step">02</span><h2>Test, then enable</h2><p>Preview a rule before applying it. Run independent rules together, or update prompts and choices across several inboxes with explicit label mappings.</p></article><article class="card"><span class="step">03</span><h2>Review the result</h2><p>See which rule selected a label, pause processing, and control protected labels. Optional reply drafts use text you configure and are never sent automatically.</p></article></section>
<section class="split-section"><div><p class="eyebrow">A clear data flow</p><h2>Gmail → classification → Gmail labels</h2><p>The app reads incoming email and conversation context, sends the relevant text and your rule instructions to the OpenAI API, then applies the selected Gmail label when the result meets your threshold.</p><p>Conversation context may contain messages you sent. Processing also covers eligible incoming mail that Gmail automatically archived.</p></div><aside class="notice"><h2>Before you connect</h2><p>Google Cloud hosts this service. OpenAI processes email text, headers, metadata, and rule instructions to classify it. Review the <a href="/privacy">Privacy Policy</a> before granting access.</p><p>You can pause a mailbox or disconnect it in the app. For deletion of retained app data, <a href="/support#deletion">contact the operator</a>.</p></aside></section>
<section class="document-section"><h2>Built for email productivity</h2><p>Email Auto Labeller adds labels and, when you explicitly enable a reply action, prepares a draft for your review. It does not automatically send replies or train a general-purpose AI model on your Gmail content.</p><p>Read our <a href="/privacy#limited-use">Google API Limited Use commitment</a> and <a href="/terms">Terms of Use</a>.</p></section>`;
}
function privacy() {
  const { operator } = publicSettings();
  return `<div class="document-heading"><p class="eyebrow">Privacy &amp; control</p><h1>Privacy Policy</h1><p class="lead">What we access, why we use it, and how you can control it.</p><p class="small-note">Last updated ${updated} · Operator: ${escapeHtml(operator)} · Contact: ${contact("Privacy request")}</p></div>
<article class="document"><section><h2>1. What this service does</h2><p>${appName} is an email productivity service. It classifies incoming Gmail messages according to rules you configure, applies selected Gmail labels, and can prepare a reply draft when you enable that action. Drafts are not sent automatically.</p></section>
<section><h2>2. Information we access</h2><ul><li><strong>Google identity:</strong> your email address, name, and authorization information used to connect your account and maintain a signed-in session.</li><li><strong>Gmail information:</strong> label names and identifiers, message and thread identifiers, subjects, senders, recipients, dates, message text, and conversation context. HTML is converted to text. Textual message parts may be retrieved separately; the classifier does not upload binary attachments.</li><li><strong>Your configuration:</strong> rule prompts, choice descriptions, label mappings, protected labels, reply-draft text, thresholds, and enabled or paused settings.</li><li><strong>Service records:</strong> classification choices and scores, action outcomes, synchronization checkpoints, consent version and acceptance time, essential session cookies, and operational request/error metadata.</li></ul><p>Conversation context can include sent messages and other messages in the same thread. Sent mail, drafts, spam, and trash are excluded as labeling targets; eligible archived incoming mail can still be classified. Authorized account holders and workspace owners can view the settings and decision history for mailboxes they manage.</p></section>
<section><h2>3. How information is used and shared</h2><p>We use this information to authenticate you, execute and test your rules, synchronize new mail, apply labels, prepare enabled reply drafts, display activity, prevent duplicate actions, and maintain security and reliability.</p><p><strong>Google Cloud</strong> hosts the service and its Firestore database. Gmail remains the source of your email and the destination for label changes and drafts.</p><p><strong>OpenAI API</strong> receives the mailbox email address, message identifiers, relevant conversation headers and text, your classification prompts, and choice descriptions. It returns a classification used by the app. This transfer supports the classification feature you request.</p><p>OpenAI states that API data is not used for model training by default. We do not opt in to using Google user data for general-purpose model training. OpenAI may keep abuse-monitoring logs for up to 30 days by default, with longer retention in documented legal or security circumstances. Encrypted prompt-cache data may be retained for up to 24 hours. We do not claim Zero Data Retention for this deployment. See ${external(openaiData, "OpenAI’s API data controls")}.</p></section>
<section id="limited-use"><h2>4. Google API Limited Use</h2><p class="policy-commitment">Our use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including its Limited Use requirements.</p><p>We do not sell Google user data, use it for advertising or credit decisions, or use it to train general-purpose AI models. Human access is limited to circumstances allowed by those requirements, such as your explicit permission to examine specific data, security investigations, or legal obligations. These restrictions also apply to service providers handling the data for us.</p><p>Read the ${external(googlePolicy, "Google API Services User Data Policy")} and ${external(workspacePolicy, "Google Workspace user data and developer policy")}.</p></section>
<section><h2>5. Storage and retention</h2><p>The app does not persist full email bodies in its database. It does store subjects, message identifiers, rule settings and version snapshots, classification results, and action status. Email text is processed in memory and shared with OpenAI as described above.</p><div class="table-wrap"><table><thead><tr><th scope="col">Record</th><th scope="col">Retention</th></tr></thead><tbody><tr><th scope="row">Completed activity, message jobs, and rule executions</th><td>Scheduled for deletion 30 days after completion. Database expiry deletion is asynchronous.</td></tr><tr><th scope="row">Pending or retrying work</th><td>Kept until resolved or removed through a deletion request; it does not expire automatically after 30 days.</td></tr><tr><th scope="row">Mailbox settings, rules, version snapshots, consent records, and draft-intent records</th><td>Kept for the connected workspace and its operation until removed through the applicable deletion process.</td></tr><tr><th scope="row">Refresh credential</th><td>Kept encrypted while connected. Disconnect removes the app’s stored refresh credential.</td></tr><tr><th scope="row">Sign-in session and temporary OAuth transaction</th><td>Sessions expire after seven days; temporary OAuth transactions expire after ten minutes. Expired records are scheduled for deletion.</td></tr></tbody></table></div><p>Cloud infrastructure logs, backups, and service-provider records may follow separate retention and legal requirements. Provider-held data is subject to the provider’s controls; deleting app records does not promise immediate deletion from every provider system.</p></section>
<section><h2>6. Security</h2><p>Public connections use HTTPS. Refresh credentials are encrypted with AES-256-GCM before storage. Google Cloud provides the hosting and database security controls. Access to mailbox settings and activity requires authentication and authorization. The app uses safeguards against cross-site request forgery and verifies machine-to-machine notifications.</p><p>No system can guarantee absolute security. Report a suspected issue privately through ${contact("Security report")} without sending passwords or authorization tokens.</p></section>
<section id="deletion"><h2>7. Your controls and deletion requests</h2><p><strong>Pause:</strong> stop processing a mailbox or an individual rule from the app.</p><p><strong>Disconnect:</strong> remove the locally stored refresh credential and pause that mailbox. Disconnect does not erase retained rules or activity, revoke the Google authorization grant, or remove labels and drafts already created in Gmail.</p><p><strong>Delete retained app data:</strong> email ${contact("Delete my Email Auto Labeller data")} from the connected address and identify the mailbox or workspace you want removed. The operator will verify the request and arrange deletion of the applicable stored records. Do not include email bodies, passwords, or tokens. There is currently no self-service delete-all-data button.</p><p><strong>Revoke Google access:</strong> use ${external(googleConnections, "Google Account connections")}. If the consent screen shows a shared application name such as MyMcp, revoking that grant may also disconnect other integrations using the same Google authorization.</p><p>Labels, original messages, and drafts stored in Gmail remain under your control in Gmail. You can delete or change them there.</p></section>
<section><h2>8. Policy changes and contact</h2><p>We will update this notice when our data practices change and request renewed consent where required before using Google user data for a new purpose. For questions or requests, contact ${contact("Privacy question")}.</p></section></article>`;
}
function terms() {
  return `<div class="document-heading"><p class="eyebrow">Using the service</p><h1>Terms of Use</h1><p class="lead">A few clear expectations for a tool that acts on your inbox.</p><p class="small-note">Last updated ${updated}</p></div><article class="document"><section><h2>Access and authorization</h2><p>Use ${appName} only with mailboxes you own or are authorized to manage. This deployment is allowlisted; a Google sign-in does not guarantee access. You authorize enabled rules to classify eligible mail and apply their configured Gmail labels.</p></section><section><h2>Your rules and decisions</h2><p>You are responsible for the prompts, choices, labels, protected labels, and draft text you configure. Classification is probabilistic and may be incorrect. Test rules and review activity before relying on them for important decisions.</p><p>An enabled reply action creates a draft for review. The app does not send that draft automatically. Review recipients and content before sending through Gmail.</p></section><section><h2>Availability and changes</h2><p>The service depends on Google and OpenAI APIs. Outages, expired permissions, quotas, and classification errors can delay or prevent processing. Features may change, and the operator may pause access to investigate security or reliability issues. The service is provided without a promise of uninterrupted operation or error-free classification.</p></section><section><h2>Privacy and stopping use</h2><p>The <a href="/privacy">Privacy Policy</a> explains processing, service providers, retention, and deletion requests. You can pause rules, disconnect a mailbox, and revoke Google access. Disconnecting does not undo existing Gmail labels or drafts or automatically delete all retained app data.</p></section><section><h2>Appropriate use</h2><p>Do not use the app to access another person’s mailbox without permission, abuse Google or OpenAI services, or interfere with security controls. Contact <a href="/support">Support</a> with questions or to report a problem.</p></section></article>`;
}
function support() {
  const { operator } = publicSettings();
  return `<div class="document-heading"><p class="eyebrow">Help &amp; requests</p><h1>Support</h1><p class="lead">Contact ${escapeHtml(operator)} for connection help, privacy requests, or a security concern.</p></div><div class="support-grid"><section class="card"><h2>Get help</h2><p class="contact-address">${contact("Email Auto Labeller support")}</p><p>Include the affected mailbox, what you expected, the approximate time, and the error shown in the app. Redact sensitive information from screenshots.</p><p class="small-note">Never send your Google password, OAuth tokens, API keys, or unredacted email bodies.</p></section><section class="card"><h2>Connection or classification problem?</h2><ol><li>Check the mailbox and rule status in the app.</li><li>Review the relevant Activity entry.</li><li>Reconnect only if Gmail access has expired.</li><li>Check that the selected Gmail labels still exist.</li></ol><p>Google verification or test-user notices concern the OAuth application’s current status. These public pages do not mean Google has approved or verified the app.</p></section></div><section id="deletion" class="document-section"><h2>Request deletion of app data</h2><p>Email ${contact("Delete my Email Auto Labeller data")} from the connected email address, stating which mailbox or workspace data you want deleted. We may ask you to confirm ownership before handling the request. This is a manual operator process.</p><p>Disconnect first if you want processing to stop immediately. Disconnect removes the stored refresh credential and pauses processing, but retains configuration and history. The <a href="/privacy#deletion">Privacy Policy</a> explains what remains and how to revoke Google access separately.</p></section><section class="document-section"><h2>Revoke Google access</h2><p>Open ${external(googleConnections, "Google Account connections")} and remove the relevant app’s access. A shared OAuth application, including one named MyMcp, may also be used by your other integrations. Revoking its grant can affect those integrations.</p><p>For a suspected security issue, contact ${contact("Security report")} privately. Do not post private mailbox data in a public issue tracker.</p></section>`;
}

export function mountPublicPages(app: Express): void {
  const pages = [
    ["/about", "About", about],
    ["/privacy", "Privacy Policy", privacy],
    ["/terms", "Terms of Use", terms],
    ["/support", "Support", support],
  ] as const;
  for (const [pagePath, title, render] of pages)
    app.get(pagePath, (_req, res) => {
      res
        .set("Cache-Control", "public, max-age=300")
        .type("html")
        .send(publicPage(title, render(), pagePath));
    });
}
