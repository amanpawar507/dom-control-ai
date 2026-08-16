import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { RunLogger } from "../../src/evidence/logger.js";

const DIR = "tests/.tmp-evidence";
afterEach(() => { if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

describe("RunLogger", () => {
  it("writes one JSON object per line", () => {
    const log = new RunLogger("run-1", DIR);
    log.log({ kind: "step.start", stepId: "s1" });
    log.log({ kind: "step.end", stepId: "s1", ok: true });

    const lines = readFileSync(log.path(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "step.start", stepId: "s1", runId: "run-1" });
  });

  it("redacts a session token in a logged url", () => {
    const log = new RunLogger("run-2", DIR);
    log.log({ kind: "nav", url: "http://localhost:8081/parabank/about.htm;jsessionid=ABC123DEF456GHI789" });
    expect(readFileSync(log.path(), "utf8")).toContain(";jsessionid=<redacted>");
    expect(readFileSync(log.path(), "utf8")).not.toContain("ABC123DEF456GHI789");
  });

  it("redacts an SSN appearing anywhere in a logged string value", () => {
    const log = new RunLogger("run-3", DIR);
    log.log({ kind: "observe", note: "field held 123-45-6789" });
    expect(readFileSync(log.path(), "utf8")).toContain("<redacted:ssn>");
  });

  // Synthetic. A real captured token in a test file would be the leak this
  // suite exists to catch, written by hand.
  const TOKEN = "SYNTHETICTESTTOKEN00000000000000";

  it("redacts a session token logged as a Set-Cookie line", () => {
    const log = new RunLogger("run-6", DIR);
    log.log({ kind: "cookie", raw: `Set-Cookie: JSESSIONID=${TOKEN}; Path=/parabank` });
    expect(readFileSync(log.path(), "utf8")).not.toContain(TOKEN);
  });

  it("redacts a session token logged inside a storage state", () => {
    // This is exactly what ParabankSessionProvider.acquire() returns, and the
    // only representation of the token that exists once a replay is
    // authenticated. Nothing in the value itself is pattern-matchable; it is a
    // secret because of where it sits.
    const log = new RunLogger("run-7", DIR);
    log.log({
      kind: "session.acquired",
      storageState: { cookies: [{ name: "JSESSIONID", value: TOKEN, path: "/parabank" }], origins: [] },
    });
    expect(readFileSync(log.path(), "utf8")).not.toContain(TOKEN);
  });

  it("redacts a session token logged as the serialized storage state string", () => {
    const log = new RunLogger("run-8", DIR);
    log.log({
      kind: "session.acquired",
      storageState: JSON.stringify({ cookies: [{ name: "JSESSIONID", value: TOKEN }] }),
    });
    expect(readFileSync(log.path(), "utf8")).not.toContain(TOKEN);
  });

  it("stamps every line with runId and an ISO timestamp", () => {
    const log = new RunLogger("run-4", DIR);
    log.log({ kind: "x" });
    const rec = JSON.parse(readFileSync(log.path(), "utf8").trim());
    expect(rec.runId).toBe("run-4");
    expect(() => new Date(rec.at).toISOString()).not.toThrow();
  });

  it("ignores a caller-supplied runId and at, keeping the canonical values", () => {
    const log = new RunLogger("run-5", DIR);
    log.log({ kind: "spoof", runId: "SPOOFED", at: "not-a-timestamp" });

    const rec = JSON.parse(readFileSync(log.path(), "utf8").trim());
    expect(rec.runId).toBe("run-5");
    expect(rec.at).not.toBe("not-a-timestamp");
    expect(new Date(rec.at).toISOString()).toBe(rec.at);
    expect(rec.kind).toBe("spoof");
  });
});
