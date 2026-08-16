import { describe, it, expect } from "vitest";
import { checkAllowlist, type Allowlist } from "../../src/policy/allowlist.js";

const list: Allowlist = {
  origins: ["http://localhost:8081"],
  paths: ["/parabank/**"],
  actions: ["click", "fill", "navigate", "extract"],
};

describe("checkAllowlist", () => {
  it("allows an in-scope origin, path, and action", () => {
    expect(checkAllowlist(list, "http://localhost:8081/parabank/overview.htm", "click"))
      .toEqual({ allowed: true });
  });

  it("refuses a foreign origin", () => {
    const d = checkAllowlist(list, "https://evil.example/parabank/x", "click");
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: expect.stringContaining("origin") });
  });

  it("refuses an out-of-scope path on an allowed origin", () => {
    const d = checkAllowlist(list, "http://localhost:8081/other/x", "click");
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("path") });
  });

  it("refuses an action type not on the list", () => {
    const d = checkAllowlist(list, "http://localhost:8081/parabank/x", "upload");
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("action") });
  });

  it("allows a nested path under a ** glob", () => {
    expect(checkAllowlist(list, "http://localhost:8081/parabank/services/bank/accounts", "click"))
      .toEqual({ allowed: true });
  });

  it("does not let a single * cross a path segment", () => {
    const single: Allowlist = { ...list, paths: ["/parabank/*"] };
    expect(checkAllowlist(single, "http://localhost:8081/parabank/a/b", "click"))
      .toMatchObject({ allowed: false, reason: expect.stringContaining("path") });
  });
});
