import { describe, it, expect } from "vitest";
import { classifyRisk, controlNameEvidence, type RiskRule } from "../../src/policy/risk.js";

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

describe("controlNameEvidence", () => {
  const at = (path: string): string => `http://localhost:8081${path}`;

  it("records the name that made the rule fire, and not the ones that did not", () => {
    // The gate is handed everything the element answers to. The file keeps the
    // half that explains the verdict, because the other half is page text —
    // and on a `<select>` page text is the option list, which is where the
    // argument to a select step lives by construction.
    const ev = controlNameEvidence(at("/parabank/admin.htm"), "click", ["Clean", "Accounts Overview"], rules);
    expect(ev.controlNames).toEqual(["Clean"]);
  });

  it("records no name at all when no rule matched, which is the whole explanation of a safe verdict", () => {
    // The verdict is a pure function of url, action, rules and this set, so a
    // set that fired nothing is fully accounted for by saying it fired nothing.
    const names = ["1234512456125671267812789129001301113122132331334454321"];
    const ev = controlNameEvidence(at("/parabank/transfer.htm"), "select", names, rules);
    expect(ev.controlNames).toEqual([]);
    expect(classifyRisk(at("/parabank/transfer.htm"), "select", names, rules)).toBe("safe");
    expect(JSON.stringify(ev)).not.toContain("12345");
  });

  it("says that names were read, and distinguishes one set from another, without showing either", () => {
    const a = controlNameEvidence(at("/parabank/overview.htm"), "click", ["12345"], rules);
    const again = controlNameEvidence(at("/parabank/overview.htm"), "click", ["12345"], rules);
    const b = controlNameEvidence(at("/parabank/overview.htm"), "click", ["54321"], rules);
    expect(a.controlNamesDigest).toBe(again.controlNamesDigest);
    expect(a.controlNamesDigest).not.toBe(b.controlNamesDigest);
    expect(a.controlNamesDigest).not.toContain("12345");
  });

  it("reports no digest when there was no name to read", () => {
    // Empty stays empty for the reason `observe()`'s value digest does: that a
    // control has no accessible name is a fact about the page rather than
    // about its contents, and it is worth an operator's attention.
    expect(controlNameEvidence(at("/parabank/admin.htm"), "click", [], rules).controlNamesDigest).toBeNull();
  });
});
