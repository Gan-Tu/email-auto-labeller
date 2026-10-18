import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { config } from "../server/config";
import {
  escapeHtml,
  mountPublicPages,
  publicPage,
} from "../server/public-pages";

const originalSupport = process.env.SUPPORT_EMAIL;
const originalOperator = process.env.OPERATOR_NAME;
const app = express();
mountPublicPages(app);

beforeEach(() => {
  delete process.env.SUPPORT_EMAIL;
  delete process.env.OPERATOR_NAME;
});
afterEach(() => {
  if (originalSupport === undefined) delete process.env.SUPPORT_EMAIL;
  else process.env.SUPPORT_EMAIL = originalSupport;
  if (originalOperator === undefined) delete process.env.OPERATOR_NAME;
  else process.env.OPERATOR_NAME = originalOperator;
});

describe("Public OAuth information", () => {
  it.each([
    ["/about", "Give every email"],
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Use"],
    ["/support", "Support"],
  ])(
    "serves %s without a session or authentication middleware",
    async (path, title) => {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.type).toBe("text/html");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.text).toContain(title);
      expect(response.text).toContain(`href="${config.baseUrl}${path}"`);
      expect(response.text).toContain('href="/public-pages.css"');
      for (const link of ["/about", "/privacy", "/terms", "/support"])
        expect(response.text).toContain(`href="${link}"`);
      expect(response.text).toContain('href="mailto:dev@tugan.io');
      expect(response.text).not.toMatch(/<script\b|\sstyle=/i);
    },
  );

  it("discloses data sharing, retained records, and the current deletion process", async () => {
    const { text } = await request(app).get("/privacy");
    expect(text).toContain(
      "Our use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including its Limited Use requirements.",
    );
    expect(text).toContain("Google Cloud");
    expect(text).toContain("OpenAI API");
    expect(text).toContain("mailbox email address, message identifiers");
    expect(text).toContain(
      "API data is not used for model training by default",
    );
    expect(text).toContain("up to 30 days by default");
    expect(text).toContain("up to 24 hours");
    expect(text).toContain("We do not claim Zero Data Retention");
    expect(text).toContain(
      "subjects, message identifiers, rule settings and version snapshots",
    );
    expect(text).toContain("Scheduled for deletion 30 days after completion");
    expect(text).toContain("it does not expire automatically after 30 days");
    expect(text).toContain("Sessions expire after seven days");
    expect(text).toContain("OAuth transactions expire after ten minutes");
    expect(text).toContain("Authorized account holders and workspace owners");
    expect(text).toContain(
      "Disconnect does not erase retained rules or activity",
    );
    expect(text).toContain("no self-service delete-all-data button");
    expect(text).toContain("https://myaccount.google.com/connections");
    expect(text).toContain(
      "revoking that grant may also disconnect other integrations",
    );
  });

  it("has a descriptive homepage and separates support from automatic deletion", async () => {
    const about = await request(app).get("/about");
    expect(about.text).toContain("classification prompt");
    expect(about.text).toContain('href="/auth/google"');
    expect(about.text).toContain("OpenAI processes email text");
    const support = await request(app).get("/support");
    expect(support.text).toContain("manual operator process");
    expect(support.text).toContain(
      "do not mean Google has approved or verified the app",
    );
    const terms = await request(app).get("/terms");
    expect(terms.text).toContain("does not send that draft automatically");
  });

  it("uses configurable support details and escapes operator/title markup", async () => {
    process.env.SUPPORT_EMAIL = "support@example.com";
    process.env.OPERATOR_NAME = '<img src=x onerror="alert(1)">';
    const { text } = await request(app).get("/privacy");
    expect(text).toContain('href="mailto:support@example.com');
    expect(text).not.toContain('href="mailto:dev@tugan.io');
    expect(text).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(text).not.toContain('<img src=x onerror="alert(1)">');
    const html = publicPage(
      '<script>alert("title")</script>',
      "<p>Authored content</p>",
      "/auth/google",
    );
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;",
    );
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain("<p>Authored content</p>");
    expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
