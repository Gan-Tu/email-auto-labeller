export interface EmailContext {
  id?: string;
  threadId?: string;
  internalDate?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodies: string[];
  truncated?: boolean;
  omittedEarlierMessages?: number;
  omittedMessages?: number;
}

function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const keepStart = Math.floor(limit * 0.65);
  const keepEnd = limit - keepStart;
  return `${text.slice(0, keepStart)}\n[... ${text.length - limit} characters omitted ...]\n${keepEnd ? text.slice(-keepEnd) : ""}`;
}

// Bound the actual serialized input, not just body text. Keep each message's
// beginning and end, with twice as much space for the two newest messages.
export function fitThreadContext(
  messages: EmailContext[],
  maxChars = 180000,
  incomingMessageId?: string,
): EmailContext[] {
  if (incomingMessageId && !messages.some(m => m.id === incomingMessageId)) throw new Error("Incoming message context unavailable");
  if (JSON.stringify(messages).length <= maxChars) return messages;
  if (maxChars < 2000)
    throw new Error("Context budget must be at least 2000 characters");
  let selected = messages.map((message) => ({
    id: message.id,
    threadId: message.threadId,
    internalDate: message.internalDate,
    from: excerpt(message.from, Math.min(500, Math.floor(maxChars / 80))),
    to: excerpt(message.to, Math.min(500, Math.floor(maxChars / 80))),
    subject: excerpt(
      message.subject,
      Math.min(1000, Math.floor(maxChars / 40)),
    ),
    date: excerpt(message.date, Math.min(100, Math.floor(maxChars / 80))),
    text: [...new Set(message.bodies.map((body) => body.trim()))].join("\n\n"),
  }));
  let omitted = 0;
  const build = (bodyLimit: number): EmailContext[] =>
    selected.map((message, index) => {
      const { text, ...headers } = message;
      return {
        ...headers,
        bodies: [
          excerpt(text, bodyLimit * (index >= selected.length - 2 ? 2 : 1)),
        ],
        truncated: true,
        ...(omitted && index === 0 ? (incomingMessageId ? { omittedMessages: omitted } : { omittedEarlierMessages: omitted }) : {}),
      };
    });
  // Extremely long histories can exceed the limit on metadata alone. Reserve
  // most of the budget for content and explicitly note any omitted old messages.
  while (
    selected.length > 1 &&
    JSON.stringify(build(0)).length > maxChars / 3
  ) {
    const remove = selected.findIndex(message => !incomingMessageId || message.id !== incomingMessageId);
    if (remove < 0) break;
    selected.splice(remove, 1);
    omitted++;
  }
  let low = 0,
    high = maxChars;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(build(mid)).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return build(low);
}
