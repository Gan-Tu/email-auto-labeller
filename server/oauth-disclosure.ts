import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { requestOrigin } from "./origins.js";
import { publicPage, escapeHtml } from "./public-pages.js";

export const DATA_CONSENT_VERSION = "2026-10-21";
const cookieName = "email_data_consent";
const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/auth/google",
  maxAge: 10 * 60 * 1000,
});

export function showOAuthDisclosure(req: Request, res: Response) {
  const origin = requestOrigin(req);
  if (!origin) {
    res.status(400).send("Unsupported app URL");
    return;
  }
  // Chrome sends Origin: null on a form POST from a no-referrer document.
  // Preserve same-origin CSRF validation without sending referrers to Google.
  res.set("Referrer-Policy", "same-origin");
  const token = randomBytes(32).toString("hex");
  res.cookie(cookieName, token, cookieOptions(origin.startsWith("https:")));
  res.type("html").send(
    publicPage(
      "Connect Gmail",
      `
    <p class="eyebrow">Before you connect</p>
    <h1>How your Gmail data is used</h1>
    <p>Email Auto Labeller reads incoming emails and their conversations to run the match actions you choose for each rule choice.</p>
    <section class="card"><h2>What is shared with OpenAI</h2>
      <p>Your mailbox email address, message and conversation identifiers, email headers (including senders, recipients and subject), and email text are sent to the OpenAI API with your rule prompts and choice descriptions for classification. This includes relevant conversation context and may include text from textual MIME parts. Only connect mailboxes you are authorized to use.</p>
      <p>The app does not use Google user data to train general-purpose AI models. OpenAI API data is not used for training by default. OpenAI may retain abuse-monitoring data for up to 30 days, with exceptions described in its <a href="https://developers.openai.com/api/docs/guides/your-data">data controls</a>.</p>
    </section>
    <section class="card"><h2>What the app can do</h2>
      <p>Google asks for permission to read and modify Gmail because the app needs to read messages, follow new-message notifications and apply labels. Each choice can add one or more labels, create a reply draft using your text, mark messages read, or forward to your configured email address. All actions default off; at least one must be selected before saving a choice. Drafts remain unsent. Forwarding sends a readable summary and the original email with its attachments as original.eml. The app does not delete Gmail messages.</p>
      <p>Account settings, encrypted access credentials, rule versions and activity metadata are stored on Google Cloud. Full email bodies are processed in memory rather than saved in the app database. Completed processing and activity records expire after 30 days; pending work and rule settings remain until resolved or deleted. Draft and forwarding reservations remain until deleted to prevent duplicate actions.</p>
      <p>You can pause processing or disconnect in Mailbox settings. Authorized mailbox holders and workspace owners can view the rules and decision history for mailboxes they manage. For data deletion and revoking Google access, see <a href="/support">Support</a>. Read the <a href="/privacy">Privacy notice</a> and <a href="/terms">Terms</a>.</p>
    </section>
    <form action="/auth/google" method="post" class="consent-form">
      <input type="hidden" name="consentToken" value="${escapeHtml(token)}">
      <label class="consent-check"><input type="checkbox" name="dataSharingConsent" value="yes" required>
      <span>I agree to share the Gmail data described above with OpenAI to classify my emails and apply my configured rules.</span></label>
      <button class="button" type="submit">Continue with Google</button>
      <a href="/">Cancel</a>
    </form>
    <p class="muted">Access is currently limited to configured accounts. Google will show the permissions and ask you to authorize access next.</p>
  `,
      "/auth/google",
    ),
  );
}

export function hasOAuthDisclosureConsent(req: Request): boolean {
  const origin = requestOrigin(req);
  const token = req.body?.consentToken;
  const cookie = req.cookies?.[cookieName];
  if (
    !origin ||
    req.get("origin") !== origin ||
    req.body?.dataSharingConsent !== "yes" ||
    typeof token !== "string" ||
    typeof cookie !== "string" ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !/^[a-f0-9]{64}$/.test(cookie)
  )
    return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(cookie));
}
export function clearOAuthDisclosure(res: Response) {
  res.clearCookie(cookieName, { path: "/auth/google" });
}
