import { it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
const app = createApp();
it("requires a user session for mailbox data and settings", async () => {
  expect((await request(app).get("/api/accounts")).status).toBe(401);
  expect(
    (
      await request(app)
        .patch("/api/accounts/a@example.com")
        .send({ enabled: false })
    ).status,
  ).toBe(401);
});
it("rejects unauthenticated and forged push and scheduler requests", async () => {
  expect(
    (
      await request(app)
        .post("/hooks/gmail")
        .send({ message: { data: "e30=" } })
    ).status,
  ).toBe(401);
  expect((await request(app).post("/jobs/renew")).status).toBe(401);
  expect(
    (
      await request(app)
        .post("/hooks/gmail")
        .set("Authorization", "Bearer fake")
        .send({})
    ).status,
  ).toBe(401);
});
it("returns a minimal public health response and security headers", async () => {
  const r = await request(app).get("/health");
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(r.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
});
