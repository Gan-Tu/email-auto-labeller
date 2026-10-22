export interface User {
  email: string;
  name: string;
  csrf: string;
}
export interface Account {
  email: string;
  label?: string;
  enabled: boolean;
  threshold?: number;
  classificationPrompt?: string | null;
  watchExpires: number;
  lastSync: number;
  lastPush?: number;
  lastError?: string;
}
export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}
export interface ChoiceActions {
  labels: { labelId: string; labelName: string }[];
  replyDraft: { body: string } | null;
  markRead: boolean;
  forward: { to: string } | null;
}
export interface RuleChoice {
  id: string;
  name: string;
  description: string;
  labelId?: string;
  labelName?: string;
  actions?: ChoiceActions;
}
export interface ProtectedLabel {
  labelId: string;
  labelName: string;
  includeChildren: boolean;
}
export interface ReplyDraft {
  choiceIds: string[];
  body: string;
}
export interface RuleInput {
  name: string;
  prompt: string;
  enabled: boolean;
  threshold: number;
  scope: "message" | "thread";
  choices: RuleChoice[];
  protectedLabels?: ProtectedLabel[];
  replyDraft?: ReplyDraft | null;
}
export interface Rule extends RuleInput {
  id: string;
  email: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string | null;
}
export interface RuleTemplate extends RuleInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}
export interface TestResponse {
  result: {
    choiceId: string | null;
    choiceName?: string | null;
    probability?: number | null;
    confidence?: number | null;
    refused?: boolean;
  };
  label?: { id: string; name: string };
  actions?: ChoiceActions | null;
  applied: false;
}
export interface Decision {
  messageId: string;
  threadId: string;
  email: string;
  subject: string;
  outcome: string;
  ruleId?: string;
  ruleName?: string;
  ruleVersion?: number;
  choiceId?: string;
  choiceName?: string;
  probability?: number;
  confidence?: number;
  contextTruncated?: boolean;
  label?: string;
  reason?: string;
  excludedLabels?: string[];
  draft?: string;
  actions?: {
    type: "label" | "draft" | "markRead" | "forward";
    status: "completed" | "skipped" | "unknown" | "failed";
    labelId?: string;
    labelName?: string;
    to?: string;
    reason?: string;
  }[];
  createdAt: number;
  completedAt?: number;
}
export interface ActivityResponse {
  decisions: Decision[];
  limit: number;
  retentionDays: number;
  asOf: number;
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.error ?? `Request failed (${response.status}). Please try again.`,
    );
  return body;
}
export function post(user: User, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": user.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
export const mailboxPath = (email: string) =>
  `/api/accounts/${encodeURIComponent(email)}`;
export const rulePath = (rule: Rule) =>
  `${mailboxPath(rule.email)}/rules/${encodeURIComponent(rule.id)}`;
