import { it, expect } from "vitest";
import { fitThreadContext, type EmailContext } from "../server/context";
const message = (body: string, subject = "A conversation"): EmailContext => ({
  from: "a@example.com",
  to: "b@example.com",
  subject,
  date: "2026-10-05",
  bodies: [body],
});
it("leaves short full-thread context unchanged", () => {
  const input = [message("Hello"), message("A reply")];
  expect(fitThreadContext(input)).toBe(input);
});
it("truncates oversized messages with a strict serialized limit and preserves both ends", () => {
  const input = [message("START " + "x".repeat(250000) + " END")];
  const result = fitThreadContext(input);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(180000);
  expect(result[0].bodies[0]).toContain("START");
  expect(result[0].bodies[0]).toContain("END");
  expect(result[0].bodies[0]).toContain("characters omitted");
  expect(result[0].truncated).toBe(true);
});
it("budgets JSON escaping and gives the latest messages more context", () => {
  const result = fitThreadContext(
    [
      message('"\\'.repeat(9000), "old"),
      message('"\\'.repeat(9000), "recent"),
      message('"\\'.repeat(9000), "latest"),
    ],
    12000,
  );
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
  expect(result).toHaveLength(3);
  expect(result[2].bodies[0].length).toBeGreaterThan(
    result[0].bodies[0].length,
  );
});
it("keeps the newest messages and marks omissions when headers alone exceed the budget", () => {
  const input = Array.from({ length: 100 }, (_, i) =>
    message("body", `message ${i} ` + "s".repeat(600)),
  );
  const result = fitThreadContext(input, 6000);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  expect(result.at(-1)?.subject).toContain("message 99");
  expect(result[0].omittedEarlierMessages).toBeGreaterThan(0);
});

it("retains the target message and stable IDs when long metadata forces omissions", () => {
 const input = Array.from({length:100},(_,i)=>({...message("body "+"x".repeat(1000),"subject "+"s".repeat(600)),id:`m${i}`,threadId:"t1",internalDate:String(i)}));
 const result=fitThreadContext(input,6000,"m0");
 expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
 expect(result.find(m=>m.id==="m0")).toMatchObject({threadId:"t1",internalDate:"0"});
 expect(result[0].omittedMessages).toBeGreaterThan(0);
});
it("rejects a missing target instead of classifying a different message",()=>{
 expect(()=>fitThreadContext([message("hello")],6000,"missing")).toThrow("Incoming message context unavailable");
});
