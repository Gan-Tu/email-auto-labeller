import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../server/config";
import { requestOrigin } from "../server/origins";
import { csrf } from "../server/auth";
const custom = "https://labels.example.com";
const original = "https://email-auto-labeller-example.us-central1.run.app";
const saved = [...config.appOrigins];
const req = (host: string, origin: string, protocol = "https") =>
  ({
    protocol,
    get: (name: string) =>
      ({
        host: host,
        origin: origin,
        "x-csrf-token": "token",
        "x-forwarded-host": new URL(custom).host,
      })[name],
    session: { csrf: "token" },
  }) as any;
beforeEach(() => (config.appOrigins = [custom, original]));
afterEach(() => (config.appOrigins = saved));
it("accepts same-origin settings requests on both registered hosts", () => {
  for (const origin of [custom, original]) {
    const r = req(new URL(origin).host, origin);
    const next = vi.fn();
    const res = { status: vi.fn(), json: vi.fn() };
    expect(requestOrigin(r)).toBe(origin);
    csrf(r, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  }
});
it("rejects arbitrary hosts, spoofed forwarded hosts, and cross-origin requests", () => {
  for (const r of [
    req("evil.example", custom),
    req(new URL(custom).host, original),
    req(new URL(custom).host, custom, "http"),
  ]) {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    csrf(r, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  }
});
