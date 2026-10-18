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
  const previousWebTopic = env.PREVIOUS_WEB_GMAIL_TOPIC?.trim() || "";
  const configuredLegacyTopic = env.LEGACY_GMAIL_TOPIC?.trim() || "";
  for (const [name, value] of [
    ["GMAIL_TOPIC", topic],
    ["PREVIOUS_WEB_GMAIL_TOPIC", previousWebTopic],
    ["LEGACY_GMAIL_TOPIC", configuredLegacyTopic],
  ]) {
    if (value && !/^projects\/[^/]+\/topics\/[^/]+$/.test(value))
      throw new Error(
        `${name} must be a full projects/PROJECT/topics/TOPIC resource name`,
      );
  }
  if (production) {
    for (const prefix of ["PREVIOUS_WEB_GOOGLE", "LEGACY_GOOGLE"]) {
      const id = env[`${prefix}_CLIENT_ID`]?.trim(),
        secret = env[`${prefix}_CLIENT_SECRET`]?.trim();
      if (!!id !== !!secret)
        throw new Error(
          `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be configured together`,
        );
    }
    if (env.PREVIOUS_WEB_GOOGLE_CLIENT_ID?.trim() && !previousWebTopic)
      throw new Error(
        "PREVIOUS_WEB_GMAIL_TOPIC is required when previous web OAuth credentials are configured",
      );
  }
  const legacyTopic = configuredLegacyTopic || previousWebTopic || topic;
  const pushEmail = setting("PUSH_SERVICE_ACCOUNT", "").toLowerCase();
  const pushEmails = [
    ...new Set(
      [
        pushEmail,
        ...(env.ADDITIONAL_PUSH_SERVICE_ACCOUNTS ?? "")
          .split(",")
          .map((email) => email.trim().toLowerCase()),
      ].filter(Boolean),
    ),
  ];
  const schedulerEmail = setting("SCHEDULER_SERVICE_ACCOUNT", "");
  for (const email of [...pushEmails, schedulerEmail])
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
    previousWebTopic,
    legacyTopic,
    pushEmail,
    pushEmails,
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
