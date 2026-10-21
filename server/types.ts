export interface Account {
  email: string;
  owner: string;
  refreshToken: string;
  clientType: "legacy" | "web";
  /** Identifies the OAuth client that issued the encrypted refresh token. */
  oauthClientId?: string;
  /** Legacy settings retained only to migrate the existing recruiting configuration. */
  label: string;
  enabled: boolean;
  draftReplies: boolean;
  threshold: number;
  classificationPrompt?: string | null;
  historyId: string;
  watchExpires: number;
  connectedAt: number;
  lastSync: number;
  lastPush?: number;
  lastError?: string | null;
  rulesRevision?: number;
  rulesMigratedAt?: number;
  dataConsentVersion?: string;
  dataConsentAt?: number;
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
  actions?: ChoiceActions;
  /** Legacy snapshots and clients. Explicit actions take precedence. */
  labelId?: string;
  labelName?: string;
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
export interface Rule {
  id: string;
  email: string;
  name: string;
  prompt: string;
  enabled: boolean;
  threshold: number;
  scope: "message" | "thread";
  choices: RuleChoice[];
  protectedLabels?: ProtectedLabel[];
  replyDraft?: ReplyDraft | null;
  /** Legacy inputs and immutable historical snapshots only. New writes use generic behavior fields. */
  draftReplies?: boolean;
  preserveJobSearch?: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  lastError?: string | null;
}
export interface Classification {
  choiceId: string | null;
  choiceName: string | null;
  probability: number | null;
  confidence: number | null;
  refused: boolean;
  probabilities: { value: string; probability: number }[];
}
export interface MessageJob {
  messageId: string;
  email: string;
  rules: { id: string; version: number }[];
  status: "pending" | "complete";
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string | null;
}
export interface ActionResult {
  type: "label" | "draft" | "markRead" | "forward";
  status: "completed" | "skipped" | "unknown" | "failed";
  labelId?: string;
  labelName?: string;
  to?: string;
  reason?: string;
}
export interface RuleExecution {
  id: string;
  email: string;
  messageId: string;
  threadId: string;
  subject: string;
  rule: Rule;
  status: "pending" | "decided" | "complete";
  completedAt?: number;
  prediction?: Classification;
  targetMessageIds?: string[];
  labelActionStarted?: boolean;
  actionResults?: Record<string, ActionResult>;
  /** Labels reserved before writes, so retries can distinguish their own protections. */
  startedLabelIds?: string[];
  decision?: Decision;
  attempts: number;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface Message {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: GmailPart;
}
export interface Thread {
  id: string;
  messages: Message[];
}
export interface Label {
  id: string;
  name: string;
  type?: string;
}
export interface Decision {
  executionId?: string;
  messageId: string;
  threadId: string;
  email: string;
  subject: string;
  ruleId?: string;
  ruleName?: string;
  ruleVersion?: number;
  choiceId?: string;
  choiceName?: string;
  outcome:
    | "labeled"
    | "matched"
    | "no_match"
    | "not_recruiting"
    | "uncertain"
    | "skipped"
    | "failed";
  probability?: number;
  confidence?: number;
  contextTruncated?: boolean;
  label?: string;
  labelId?: string;
  reason?: string;
  excludedLabels?: string[];
  actions?: ActionResult[];
  draft?: "created" | "skipped" | "unknown";
  createdAt: number;
  completedAt?: number;
}
