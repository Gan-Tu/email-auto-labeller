import { createApp } from "./app.js";
import { config, requireEnv } from "./config.js";
for (const name of [
  "OPENAI_API_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
])
  requireEnv(name);
createApp().listen(config.port, "0.0.0.0", () =>
  console.log(JSON.stringify({ event: "listening", port: config.port })),
);
