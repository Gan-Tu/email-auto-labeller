import { execFileSync } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { db } from "../server/store.js";
// Use the already signed-in gcloud account for operator scripts; keep tokens in memory.
export function useGcloudAuth() {
  const authClient = new OAuth2Client();
  authClient.setCredentials({
    access_token: execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    expiry_date: Date.now() + 3000000,
  });
  db.settings({ authClient, preferRest: true });
}
