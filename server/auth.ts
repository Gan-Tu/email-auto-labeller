import { OAuth2Client } from "google-auth-library";
import { randomBytes, createHash } from "node:crypto";
import { Timestamp } from "@google-cloud/firestore";
import type { Request, Response, NextFunction } from "express";
import { config, defaultLabel, requireEnv } from "./config.js";
import { hash, encrypt } from "./crypto.js";
import { db, accountRef, getAccount, withAccountLock } from "./store.js";
import { Gmail } from "./gmail.js";
import type { Account } from "./types.js";
import { requestOrigin } from "./origins.js";
import {
  hasOAuthDisclosureConsent,
  clearOAuthDisclosure,
  DATA_CONSENT_VERSION,
} from "./oauth-disclosure.js";
const random = () => randomBytes(32).toString("base64url");
const secure = () => config.baseUrl.startsWith("https:");
const cookie = (maxAge: number) => ({
  httpOnly: true,
  secure: secure(),
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});
export interface Session {
  email: string;
  name: string;
  csrf: string;
  expiresAt: number;
}
declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}
export function oauthClient(
  redirectUri = `${config.baseUrl}/auth/google/callback`,
) {
  return new OAuth2Client(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri,
  );
}
export async function loadSession(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (typeof req.cookies?.session === "string") {
      const data = (
        await db.collection("sessions").doc(hash(req.cookies.session)).get()
      ).data() as Session | undefined;
      if (data && data.expiresAt > Date.now()) req.session = data;
    }
    next();
  } catch {
    next(new Error("Session unavailable"));
  }
}
export const requireSession = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.session) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  next();
};
export const csrf = (req: Request, res: Response, next: NextFunction) => {
  const origin = requestOrigin(req);
  if (
    !origin ||
    req.get("origin") !== origin ||
    !req.session ||
    req.get("x-csrf-token") !== req.session.csrf
  ) {
    res.status(403).json({ error: "Request could not be verified" });
    return;
  }
  next();
};
export async function startOAuth(req: Request, res: Response) {
  if (!hasOAuthDisclosureConsent(req)) {
    res
      .status(400)
      .send(
        "Review the Gmail data disclosure and confirm before continuing. Return to /auth/google to try again.",
      );
    return;
  }
  clearOAuthDisclosure(res);
  const origin = requestOrigin(req);
  if (!origin) {
    res.status(400).json({ error: "Unsupported app URL" });
    return;
  }
  const redirectUri = `${origin}/auth/google/callback`;
  const state = random(),
    browser = random(),
    verifier = random(),
    nonce = random();
  await db
    .collection("oauth")
    .doc(hash(state))
    .create({
      browser: hash(browser),
      verifier,
      nonce,
      redirectUri,
      owner: req.session?.email ?? null,
      dataConsentVersion: DATA_CONSENT_VERSION,
      dataConsentAt: Date.now(),
      expiresAt: Date.now() + 600000,
      ttl: Timestamp.fromMillis(Date.now() + 600000),
    });
  res.cookie("oauth", browser, cookie(600000));
  const url = oauthClient(redirectUri).generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256" as any,
    include_granted_scopes: false,
  });
  const parsed = new URL(url);
  parsed.searchParams.set("nonce", nonce);
  res.redirect(parsed.toString());
}
export async function finishOAuth(req: Request, res: Response) {
  res.clearCookie("oauth", { path: "/" });
  try {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state || typeof req.cookies.oauth !== "string")
      throw new Error("state");
    const ref = db.collection("oauth").doc(hash(state));
    const transaction = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.delete(ref);
      return snap.data();
    });
    if (
      !transaction ||
      transaction.expiresAt < Date.now() ||
      transaction.browser !== hash(req.cookies.oauth) ||
      !requestOrigin(req) ||
      transaction.redirectUri !==
        `${requestOrigin(req)}/auth/google/callback` ||
      req.query.error ||
      typeof req.query.code !== "string"
    )
      throw new Error("state");
    const client = oauthClient(transaction.redirectUri);
    const { tokens } = await client.getToken({
      code: req.query.code,
      codeVerifier: transaction.verifier,
    });
    if (
      !tokens.id_token ||
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/gmail.modify")
    )
      throw new Error("scope");
    const identity = (
      await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: requireEnv("GOOGLE_CLIENT_ID"),
      })
    ).getPayload();
    if (
      !identity?.email_verified ||
      !identity.email ||
      (identity as any).nonce !== transaction.nonce
    )
      throw new Error("identity");
    const email = identity.email.toLowerCase();
    if (!config.allowed.includes(email)) {
      res.redirect("/?error=account_not_allowed");
      return;
    }
    const owner = transaction.owner ?? email;
    if (owner !== email && owner !== config.owner) throw new Error("owner");
    await withAccountLock(email, async () => {
      const previous = await getAccount(email);
      const refresh = tokens.refresh_token;
      const currentClientId = requireEnv("GOOGLE_CLIENT_ID");
      const previousUsesCurrentClient =
        previous?.clientType === "web" &&
        (previous.oauthClientId === currentClientId ||
          (!previous.oauthClientId &&
            !process.env.PREVIOUS_WEB_GOOGLE_CLIENT_ID));
      if (!refresh && !previousUsesCurrentClient) throw new Error("refresh");
      const account: Account = {
        ...previous,
        email,
        owner: previous?.owner ?? owner,
        refreshToken: refresh
          ? encrypt(refresh, email)
          : previous!.refreshToken,
        clientType: "web",
        oauthClientId: currentClientId,
        ...(transaction.dataConsentVersion
          ? {
              dataConsentVersion: transaction.dataConsentVersion,
              dataConsentAt: transaction.dataConsentAt,
            }
          : {}),
        label: previous?.label ?? defaultLabel(),
        enabled: previous?.enabled ?? true,
        draftReplies: previous?.draftReplies ?? false,
        threshold: previous?.threshold ?? 0.9,
        classificationPrompt: previous?.classificationPrompt ?? null,
        historyId: previous?.historyId ?? "",
        watchExpires: previous?.watchExpires ?? 0,
        connectedAt: previous?.connectedAt ?? Date.now(),
        lastSync: previous?.lastSync ?? Date.now(),
        lastError: null,
      };
      const gmail = new Gmail(account);
      const profile = await gmail.profile();
      if (profile.emailAddress.toLowerCase() !== email)
        throw new Error("mailbox");
      // Persist the initial cursor before watch: Google's immediate notification can race the callback.
      account.historyId ||= profile.historyId;
      await accountRef(email).set(account);
      if (account.enabled) {
        const watch = await gmail.watch();
        await accountRef(email).update({
          watchExpires: Number(watch.expiration),
        });
      }
    });
    const sessionId = random();
    const session: Session = {
      email: owner,
      name: owner === email ? (identity.name ?? email) : owner,
      csrf: random(),
      expiresAt: Date.now() + 7 * 86400000,
    };
    await db
      .collection("sessions")
      .doc(hash(sessionId))
      .create({ ...session, ttl: Timestamp.fromMillis(session.expiresAt) });
    if (req.cookies.session)
      await db.collection("sessions").doc(hash(req.cookies.session)).delete();
    res
      .cookie("session", sessionId, cookie(7 * 86400000))
      .redirect("/?connected=1");
  } catch {
    res.redirect("/?error=connection_failed");
  }
}
export async function logout(req: Request, res: Response) {
  if (req.cookies.session)
    await db.collection("sessions").doc(hash(req.cookies.session)).delete();
  res.clearCookie("session", { path: "/" }).json({ ok: true });
}
export async function verifyService(req: Request, email: string | string[]) {
  const allowed = typeof email === "string" ? [email] : email;
  const bearer = req.get("authorization");
  if (!bearer?.startsWith("Bearer ") || !allowed.length) return false;
  try {
    const p = (
      await new OAuth2Client().verifyIdToken({
        idToken: bearer.slice(7),
        audience: config.appOrigins,
      })
    ).getPayload();
    return !!p?.email && allowed.includes(p.email) && p.email_verified === true;
  } catch {
    return false;
  }
}
