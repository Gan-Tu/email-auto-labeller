import { useGcloudAuth } from "./local-auth.js";
import {
  listAccounts,
  listRules,
  recentDecisions,
  pendingJobs,
} from "../server/store.js";
useGcloudAuth();
for (const a of await listAccounts()) {
  const rules = await listRules(a.email);
  const decisions = await recentDecisions(a.email, { limit: 10 });
  const pending = await pendingJobs(a.email, 30);
  console.log(
    JSON.stringify({
      email: a.email,
      enabled: a.enabled,
      clientType: a.clientType,
      watchExpires: a.watchExpires
        ? new Date(a.watchExpires).toISOString()
        : null,
      lastPush: a.lastPush ? new Date(a.lastPush).toISOString() : null,
      lastSync: a.lastSync ? new Date(a.lastSync).toISOString() : null,
      error: a.lastError,
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        enabled: r.enabled,
        choices: r.choices.map((c) => ({
          name: c.name,
          labelId: c.labelId,
          label: c.labelName,
        })),
        lastError: r.lastError,
      })),
      pending: pending.length,
      recent: decisions.map((d) => ({
        outcome: d.outcome,
        rule: d.ruleName,
        version: d.ruleVersion,
        choice: d.choiceName,
        draft: d.draft,
        completedAt: d.completedAt,
      })),
    }),
  );
}
