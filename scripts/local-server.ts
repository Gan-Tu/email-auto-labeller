// Operator-only preview server. Never included in the production Docker image.
import { randomBytes } from "node:crypto";
import { Timestamp } from "@google-cloud/firestore";
import express from "express";
import { useGcloudAuth } from "./local-auth.js";
import { createApp } from "../server/app.js";
import { config } from "../server/config.js";
import { db } from "../server/store.js";
import { hash } from "../server/crypto.js";
useGcloudAuth();
if (config.processingEnabled || !config.baseUrl.startsWith("http://localhost:"))
  throw new Error("Preview requires localhost and disabled processing");
const app = express();
let sessionRef: FirebaseFirestore.DocumentReference | undefined;
if (process.argv.includes("--authenticated-preview")) {
  const token = randomBytes(32).toString("base64url");
  sessionRef = db.collection("sessions").doc(hash(token));
  await sessionRef.set({
    email: config.owner,
    name: process.env.OWNER_DISPLAY_NAME?.trim() || "Mailbox owner",
    csrf: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000,
    ttl: Timestamp.fromMillis(Date.now() + 3600000),
  });
  app.use((req, _res, next) => {
    req.headers.cookie = `session=${token}`;
    next();
  });
}
app.use(createApp());
const server = app.listen(config.port, "127.0.0.1", () =>
  console.log(
    `Local preview ${config.port}; processing disabled; authenticated preview=${!!sessionRef}`,
  ),
);
async function close() {
  await sessionRef?.delete();
  server.close(() => process.exit());
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
