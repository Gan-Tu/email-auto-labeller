/** Legacy account metadata only; new mailboxes start with no classification rules. */
export const defaultLabel = () => "Recruiting";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const setting = (name: string, localDefault: string) => {
    const value = env[name]?.trim();
    if (value) return value;
    if (production) throw new Error(`Missing configuration: ${name}`);
    return localDefault;
  };
  const owner = setting("OWNER_EMAIL", "owner@example.com").toLowerCase();
  const allowed = [
    ...new Set(
      setting("ALLOWED_EMAILS", owner)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    !emailPattern.test(owner) ||
    !allowed.length ||
    allowed.some((email) => !emailPattern.test(email))
  )
    throw new Error(
      "OWNER_EMAIL and ALLOWED_EMAILS must contain valid email addresses",
    );
  if (!allowed.includes(owner))
    throw new Error("ALLOWED_EMAILS must include OWNER_EMAIL");
  const origin = (value: string) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (production && url.protocol !== "https:")
    )
      throw new Error("Application origins must use HTTPS in production");
    return url.origin;
  };
  const baseUrl = origin(setting("BASE_URL", "http://localhost:8080"));
  const topic = setting("GMAIL_TOPIC", "");
  if (topic && !/^projects\/[^/]+\/topics\/[^/]+$/.test(topic))
    throw new Error(
      "GMAIL_TOPIC must be a full projects/PROJECT/topics/TOPIC resource name",
    );
  const pushEmail = setting("PUSH_SERVICE_ACCOUNT", "");
  const schedulerEmail = setting("SCHEDULER_SERVICE_ACCOUNT", "");
  for (const email of [pushEmail, schedulerEmail])
    if (email && !emailPattern.test(email))
      throw new Error("Service account identities must be email addresses");
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  return {
    project: setting("GOOGLE_CLOUD_PROJECT", "local-email-labeller"),
    database: setting("FIRESTORE_DATABASE", "(default)"),
    baseUrl,
    appOrigins: [
      ...new Set([
        baseUrl,
        ...(env.APP_ORIGINS ?? "").split("|").filter(Boolean).map(origin),
      ]),
    ],
    topic,
    pushEmail,
    schedulerEmail,
    owner,
    allowed,
    model: env.DECISIONS_MODEL?.trim() || "gpt-6-luna",
    declineReplyText:
      env.DECLINE_REPLY_TEXT?.trim() ||
      "Hi, thanks for reaching out.\nI'm not exploring new opportunities right now.\nBest of luck with your search.",
    processingEnabled: env.PROCESSING_ENABLED === "true",
    port,
  };
}
export const config = loadConfig();
export const requireEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
};
