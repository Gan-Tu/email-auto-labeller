import { z } from "zod";
// Gmail can encode historyId as a JSON integer even though reference examples use strings.
const schema = z.object({
  emailAddress: z.email(),
  historyId: z
    .union([
      z.string().regex(/^\d+$/),
      z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    ])
    .transform(String),
});
export function parseNotification(data: string) {
  return schema.parse(JSON.parse(Buffer.from(data, "base64").toString("utf8")));
}
