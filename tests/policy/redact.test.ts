import { describe, it, expect } from "vitest";
import { redactUrl, redactText, redactDeep, stripSessionToken } from "../../src/policy/redact.js";

/**
 * Synthetic, and it must stay synthetic. A real captured token in a test file is
 * the leak the redactor exists to prevent, committed by hand. Shaped like the
 * real thing — 32 alphanumeric characters — so the patterns are exercised at the
 * length they will meet in production.
 */
const TOKEN = "SYNTHETICTESTTOKEN00000000000000";

/** Exactly what `ParabankSessionProvider.acquire()` hands back, parsed. */
const storageState = {
  cookies: [
    { name: "JSESSIONID", value: TOKEN, domain: "localhost", path: "/parabank", expires: -1 },
  ],
  origins: [],
};

describe("redactUrl", () => {
  it("strips a jsessionid path parameter", () => {
    expect(redactUrl("http://localhost:8081/parabank/about.htm;jsessionid=SYNTHETICTESTTOKEN00000000000000"))
      .toBe("http://localhost:8081/parabank/about.htm;jsessionid=<redacted>");
  });

  it("leaves a clean url untouched", () => {
    const u = "http://localhost:8081/parabank/overview.htm";
    expect(redactUrl(u)).toBe(u);
  });
});

// Item 1 of the final review's second fix round: `observe()` (perception, not
// the log sink) needs to hand the model a URL it can still use, so it strips
// the token rather than marking it. This pins the primitive `observe()`
// calls; the boundary itself is pinned end-to-end in
// tests/observe/snapshot.test.ts.
describe("stripSessionToken", () => {
  it("removes the parameter entirely, leaving a working address", () => {
    expect(stripSessionToken("http://localhost:8081/parabank/overview.htm;jsessionid=" + TOKEN)).toBe(
      "http://localhost:8081/parabank/overview.htm",
    );
  });

  it("leaves a clean url untouched", () => {
    const u = "http://localhost:8081/parabank/overview.htm";
    expect(stripSessionToken(u)).toBe(u);
  });

  it("does not leave a <redacted> marker behind — that would not be a real address", () => {
    expect(stripSessionToken("http://x/a.htm;jsessionid=" + TOKEN)).not.toContain("redacted");
  });
});

describe("redactText", () => {
  it("redacts an SSN-shaped string", () => {
    expect(redactText("ssn 123-45-6789 on file")).toBe("ssn <redacted:ssn> on file");
  });

  it("redacts a jsessionid appearing in free text", () => {
    expect(redactText("GET /x;jsessionid=ABCDEF0123456789ABCDEF0123456789"))
      .toBe("GET /x;jsessionid=<redacted>");
  });
});

// The three forms the session token actually takes on this target. Only the
// first was covered originally, and per spec §2 it is the one that stops
// appearing the moment the session cookie round-trips — so the two forms an
// authenticated replay produces were the two that passed through verbatim.
describe("redactText — the forms an authenticated session produces", () => {
  it("redacts the cookie-header form", () => {
    const out = redactText(`Set-Cookie: JSESSIONID=${TOKEN}; Path=/parabank; HttpOnly`);
    expect(out).not.toContain(TOKEN);
    // The surrounding attributes survive: a redacted line must stay readable as
    // a cookie, or the evidence loses the fact that a cookie was set at all.
    expect(out).toContain("Path=/parabank");
  });

  it("redacts the request-header form", () => {
    expect(redactText(`Cookie: JSESSIONID=${TOKEN}`)).not.toContain(TOKEN);
  });

  it("redacts the storage-state form when it arrives as serialized JSON", () => {
    // `AuthenticatedContext.storageState` is a string, so this is what a caller
    // logging it directly would write.
    expect(redactText(JSON.stringify(storageState))).not.toContain(TOKEN);
  });

  it("leaves the cookie's name alone, so what was redacted stays legible", () => {
    expect(redactText(`Set-Cookie: JSESSIONID=${TOKEN}`)).toContain("JSESSIONID");
  });

  it("leaves a mention of the cookie with no value attached", () => {
    const note = "the JSESSIONID cookie had already been set";
    expect(redactText(note)).toBe(note);
  });
});

describe("redactDeep", () => {
  it("redacts a token that is an object value under a cookie-name key", () => {
    // Nothing in the string "SYNTHETICTESTTOKEN00000000000000" identifies it as
    // a secret. Only its position — the `value` of a record whose `name` is a
    // session cookie — does, so this case cannot be reached by pattern matching
    // the string alone.
    expect(JSON.stringify(redactDeep(storageState))).not.toContain(TOKEN);
  });

  it("keeps the record's shape, so the evidence still shows a session existed", () => {
    const out = redactDeep(storageState) as typeof storageState;
    expect(out.cookies[0]).toMatchObject({ name: "JSESSIONID", path: "/parabank" });
  });

  it("leaves an unrelated name/value pair untouched", () => {
    const out = redactDeep({ cookies: [{ name: "theme", value: "dark" }] });
    expect(JSON.stringify(out)).toContain("dark");
  });

  it("still scrubs strings by pattern wherever they sit", () => {
    const out = redactDeep({ trail: [{ url: `http://x/a.htm;jsessionid=${TOKEN}` }] });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

// `redactValue` and `PolicyConfig.sensitiveControls` were deleted in the
// second fix round on the Phase 2 final review (item 2): neither ever had a
// call site, because nothing in this project logs a raw typed value in the
// first place — see the comment where `redactValue` used to be defined
// (src/policy/redact.ts) for why that is the stronger property.
