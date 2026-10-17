import type { Request } from "express";
import { config } from "./config.js";

// Never derive an OAuth redirect from an arbitrary Host or forwarded-host header.
export function requestOrigin(
  req: Pick<Request, "protocol" | "get">,
): string | undefined {
  const host = req.get("host")?.toLowerCase();
  if (!host) return undefined;
  const origin = `${req.protocol}://${host}`;
  return config.appOrigins.includes(origin) ? origin : undefined;
}
