import {
  draftClassificationPrompt,
  promptAssistantOptions,
  promptAssistantSchema,
  PromptAssistantError,
} from "./prompt-assistant.js";
import express from "express";
import { mountPublicPages } from "./public-pages.js";
import { showOAuthDisclosure } from "./oauth-disclosure.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { z } from "zod";
import path from "node:path";
import { config } from "./config.js";
import {
  csrf,
  loadSession,
  requireSession,
  startOAuth,
  finishOAuth,
  logout,
  verifyService,
} from "./auth.js";
import {
  accountRef,
  getAccount,
  listAccounts,
  recentDecisions,
  withAccountLock,
  BusyError,
} from "./store.js";
import { Gmail } from "./gmail.js";
import { normalizeChoiceActions } from "./rule-behavior.js";
import {
  listRuleTemplates,
  ruleTemplateSchema,
  saveRuleTemplate,
} from "./rule-templates.js";
import { syncAccount, renewAccount } from "./worker.js";
import { RECRUITING_PROMPT, classifyRules } from "./classifier.js";
import type { Account, Message, Rule } from "./types.js";
import { parseNotification } from "./notification.js";
import {
  createRule,
  updateRules,
  deleteRule,
  RuleError,
  editableRuleSchema,
  patchRuleSchema,
  batchRuleSchema,
  validateRule,
  listRulesForAccount,
} from "./rules.js";
import {
  ACTIVITY_LIMIT,
  HISTORY_RETENTION_DAYS,
  latestActivity,
} from "./activity.js";
const canAccess = (email: string, a: Account) =>
  a.email === email || a.owner === email;
const safeAccount = ({
  refreshToken,
  historyId,
  clientType,
  ...safe
}: Account) => safe;
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", "https://accounts.google.com"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "128kb" }), cookieParser());
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      service: "email-auto-labeller",
      version: process.env.RELEASE_SHA ?? "local",
    }),
  );
  app.post("/hooks/gmail", async (req, res) => {
    if (!(await verifyService(req, config.pushEmails ?? config.pushEmail))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = req.body?.message?.data;
    if (typeof data !== "string") {
      res.status(400).json({ error: "Invalid notification" });
      return;
    }
    let payload;
    try {
      payload = parseNotification(data);
    } catch {
      res.status(400).json({ error: "Invalid notification" });
      return;
    }
    const result = await syncAccount(
      payload.emailAddress.toLowerCase(),
      "push",
    );
    res.json({ ok: true, ...result });
  });
  app.post("/jobs/:job", async (req, res) => {
    if (!(await verifyService(req, config.schedulerEmail))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!["renew", "catchup"].includes(String(req.params.job))) {
      res.sendStatus(404);
      return;
    }
    const accounts = (await listAccounts()).filter((a) => a.enabled);
    const results = await Promise.allSettled(
      accounts.map((a) =>
        req.params.job === "renew"
          ? renewAccount(a.email)
          : syncAccount(a.email),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    res.status(failed ? 503 : 200).json({ checked: accounts.length, failed });
  });
  app.use(
    ["/api", "/auth"],
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
    loadSession,
  );
  mountPublicPages(app);
  app.get("/auth/google", showOAuthDisclosure);
  app.post(
    "/auth/google",
    express.urlencoded({ extended: false, limit: "4kb" }),
    startOAuth,
  );
  app.get("/auth/google/callback", finishOAuth);
  app.get("/api/session", (req, res) =>
    res.json({
      user: req.session
        ? {
            email: req.session.email,
            name: req.session.name,
            csrf: req.session.csrf,
          }
        : null,
    }),
  );
  app.use("/api", requireSession);
  app.post("/api/logout", csrf, logout);
  app.get("/api/rule-templates", async (req, res) => {
    res.json({ templates: await listRuleTemplates(req.session!.email) });
  });
  app.post("/api/rule-templates", csrf, async (req, res) => {
    const template = await saveRuleTemplate(
      req.session!.email,
      ruleTemplateSchema.parse(req.body),
    );
    res.status(201).json({ template });
  });
  app.get("/api/prompt-assistant/options", (_req, res) =>
    res.json(promptAssistantOptions),
  );
  app.post("/api/prompt-assistant/draft", csrf, async (req, res) => {
    res.json(
      await draftClassificationPrompt(promptAssistantSchema.parse(req.body)),
    );
  });
  app.get("/api/accounts", async (req, res) =>
    res.json({
      accounts: (await listAccounts())
        .filter((a) => canAccess(req.session!.email, a))
        .map(safeAccount),
      prompt: RECRUITING_PROMPT,
    }),
  );
  app.get("/api/rules", async (req, res) => {
    const accounts = (await listAccounts()).filter((a) =>
      canAccess(req.session!.email, a),
    );
    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          return { rules: await listRulesForAccount(account), errors: [] };
        } catch (error) {
          // Keep unresolved legacy protections intact; never normalize with
          // missing labels or let one Gmail outage hide every other mailbox.
          if (!(error instanceof RuleError) || error.status !== 503)
            throw error;
          return {
            rules: [],
            errors: [{ email: account.email, message: error.message }],
          };
        }
      }),
    );
    res.json({
      rules: results.flatMap((result) => result.rules),
      errors: results.flatMap((result) => result.errors),
      defaultPrompt: RECRUITING_PROMPT,
    });
  });
  app.post("/api/rules/batch", csrf, async (req, res) => {
    const input = batchRuleSchema.parse(req.body);
    res.json({ rules: await updateRules(req.session!.email, input) });
  });
  app.get("/api/activity", async (req, res) => {
    const query = z
      .object({
        inbox: z.email().optional(),
        after: z.coerce.number().int().nonnegative().optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid history filters" });
      return;
    }
    const accounts = (await listAccounts()).filter((a) =>
      canAccess(req.session!.email, a),
    );
    if (
      query.data.inbox &&
      !accounts.some((a) => a.email === query.data.inbox)
    ) {
      res.status(404).json({ error: "Mailbox not found" });
      return;
    }
    const selected = query.data.inbox
      ? accounts.filter((a) => a.email === query.data.inbox)
      : accounts;
    const asOf = Date.now();
    const decisions = latestActivity(
      await Promise.all(
        selected.map((a) =>
          recentDecisions(a.email, {
            limit: ACTIVITY_LIMIT,
            completedAfter: query.data.after,
          }),
        ),
      ),
    );
    res.json({
      decisions,
      limit: ACTIVITY_LIMIT,
      retentionDays: HISTORY_RETENTION_DAYS,
      asOf,
    });
  });
  app.use("/api/accounts/:email", async (req, res, next) => {
    const account = await getAccount(String(req.params.email));
    if (!account || !canAccess(req.session!.email, account)) {
      res.status(404).json({ error: "Mailbox not found" });
      return;
    }
    next();
  });
  app.get("/api/accounts/:email/labels", async (req, res) => {
    const account = (await getAccount(String(req.params.email)))!;
    res.json({
      labels: (await new Gmail(account).labels()).filter(
        (l) => l.type === "user",
      ),
    });
  });
  app.post("/api/accounts/:email/rules", csrf, async (req, res) => {
    const rule = await createRule(
      req.session!.email,
      String(req.params.email),
      editableRuleSchema.parse(req.body),
    );
    res.status(201).json({ rule });
  });
  app.post("/api/accounts/:email/rules/test", csrf, async (req, res) => {
    const input = z
      .object({
        rule: editableRuleSchema,
        text: z.string().trim().min(1).max(100000).optional(),
        messageId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .max(200)
          .optional(),
      })
      .strict()
      .refine(
        (v) => !!v.text !== !!v.messageId,
        "Choose email text or one message",
      )
      .parse(req.body);
    const email = String(req.params.email),
      account = (await getAccount(email))!;
    const gmail = new Gmail(account);
    const rule: Rule = validateRule(
      {
        ...input.rule,
        id: "preview",
        email,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      await gmail.labels(),
    );
    let messages: unknown[] = [{ id: "preview", bodies: [input.text] }];
    if (input.messageId) {
      const message = await gmail.request<Message>(
        `messages/${encodeURIComponent(input.messageId)}?format=metadata`,
      );
      messages = await gmail.fullContext(
        await gmail.thread(message.threadId),
        input.messageId,
      );
    }
    const result = (
      await classifyRules(email, messages, [rule], input.messageId ?? "preview")
    ).get(rule.id);
    if (!result || result instanceof Error)
      throw result ?? new Error("Missing preview result");
    const choice = rule.choices.find((c) => c.id === result.choiceId);
    const actions =
      choice &&
      !result.refused &&
      result.probability !== null &&
      result.probability >= rule.threshold
        ? normalizeChoiceActions(rule, choice)
        : null;
    const firstLabel = actions?.labels[0];
    res.json({
      result,
      actions,
      // Preserve the original preview field for older clients.
      label: firstLabel
        ? { id: firstLabel.labelId, name: firstLabel.labelName }
        : undefined,
      applied: false,
    });
  });
  app.patch("/api/accounts/:email/rules/:id", csrf, async (req, res) => {
    const { expectedVersion, choices, protectedLabels, ...changes } =
      patchRuleSchema.parse(req.body);
    const batch = batchRuleSchema.parse({
      targets: [
        {
          email: String(req.params.email),
          ruleId: String(req.params.id),
          expectedVersion,
          ...(choices !== undefined ? { choices } : {}),
          ...(protectedLabels !== undefined ? { protectedLabels } : {}),
        },
      ],
      changes,
    });
    const [rule] = await updateRules(req.session!.email, batch);
    res.json({ rule });
  });
  app.delete("/api/accounts/:email/rules/:id", csrf, async (req, res) => {
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().positive() })
      .strict()
      .parse(req.body);
    await deleteRule(
      req.session!.email,
      String(req.params.email),
      String(req.params.id),
      expectedVersion,
    );
    res.json({ ok: true });
  });
  app.patch("/api/accounts/:email", csrf, async (req, res) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body),
      email = String(req.params.email);
    await withAccountLock(email, async () => {
      const before = (await getAccount(email))!;
      if (input.enabled && !before.enabled) {
        const gmail = new Gmail(before),
          profile = await gmail.profile();
        // Resuming starts from the current mailbox, with no historical backfill.
        await accountRef(email).update({
          enabled: true,
          historyId: profile.historyId,
          lastSync: Date.now(),
          lastError: null,
        });
        const watch = await gmail.watch();
        await accountRef(email).update({
          watchExpires: Number(watch.expiration),
        });
      } else await accountRef(email).update(input);
    });
    res.json({ account: safeAccount((await getAccount(email))!) });
  });
  app.post("/api/accounts/:email/disconnect", csrf, async (req, res) => {
    const email = String(req.params.email);
    await withAccountLock(email, async () => {
      // Deleting this app's credential does not revoke the user's other Gmail integrations.
      await accountRef(email).update({
        enabled: false,
        refreshToken: "",
        lastError: "Disconnected — reconnect Gmail",
      });
    });
    res.json({ ok: true });
  });
  app.use(express.static(path.resolve("dist/web"), { index: false }));
  app.get("/", (_req, res) =>
    res.sendFile(path.resolve("dist/web/index.html")),
  );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof RuleError || error instanceof PromptAssistantError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: error.issues[0]?.message ?? "Invalid settings" });
        return;
      }
      console.error(
        JSON.stringify({
          event: "request_failed",
          kind:
            error instanceof BusyError
              ? "busy"
              : error instanceof Error
                ? error.constructor.name
                : "Error",
        }),
      );
      res.status(error instanceof BusyError ? 409 : 503).json({
        error:
          error instanceof BusyError
            ? "Mailbox is processing a message. Please try again shortly."
            : "Temporarily unavailable. Please try again.",
      });
    },
  );
  return app;
}
