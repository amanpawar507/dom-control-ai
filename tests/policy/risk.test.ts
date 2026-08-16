import { describe, it, expect } from "vitest";
import { classifyRisk, type RiskRule } from "../../src/policy/risk.js";

const rules: RiskRule[] = [
  { tier: "irreversible", matchControl: "^(Clean|Shutdown)$" },
  { tier: "irreversible", matchPath: "^/parabank/transfer\\.htm$", matchAction: "click" },
  { tier: "guarded", matchAction: "fill" },
];

describe("classifyRisk", () => {
  it("defaults to safe when no rule matches", () => {
    expect(classifyRisk("http://localhost:8081/parabank/overview.htm", "click", ["Accounts Overview"], rules))
      .toBe("safe");
  });

  it("marks the admin Clean button irreversible by control name", () => {
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", ["Clean"], rules))
      .toBe("irreversible");
  });

  it("marks a transfer submit irreversible by path and action", () => {
    expect(classifyRisk("http://localhost:8081/parabank/transfer.htm", "click", ["Transfer"], rules))
      .toBe("irreversible");
  });

  it("marks a form fill guarded", () => {
    expect(classifyRisk("http://localhost:8081/parabank/register.htm", "fill", [], rules))
      .toBe("guarded");
  });

  it("fires a control rule when any one of the control's names matches", () => {
    // `<button aria-label="Clean">Purge everything</button>` — the element goes
    // by both, and only one of them is written into the rules.
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", ["Purge everything", "Clean"], rules))
      .toBe("irreversible");
  });

  it("cannot be talked down by an additional name", () => {
    // The monotonicity that lets a caller's claimed label be passed alongside
    // the element's own without reopening the hole: more names, never less risk.
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", ["Clean", "Accounts Overview"], rules))
      .toBe("irreversible");
  });

  it("matches no control rule when the control goes by no name at all", () => {
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", [], rules)).toBe("safe");
  });

  it("prefers the most severe matching rule regardless of order", () => {
    const reordered: RiskRule[] = [{ tier: "guarded", matchAction: "click" }, ...rules];
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", ["Clean"], reordered))
      .toBe("irreversible");
  });
});
