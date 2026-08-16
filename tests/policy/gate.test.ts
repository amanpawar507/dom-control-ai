import { describe, it, expect } from "vitest";
import { gate, type PolicyConfig } from "../../src/policy/gate.js";

const cfg: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "navigate", "extract"],
  },
  riskRules: [
    { tier: "irreversible", matchControl: "^(Clean|Shutdown)$" },
    { tier: "guarded", matchAction: "fill" },
  ],
  sensitiveControls: ["SSN:"],
  approved: false,
};

const at = (path: string) => `http://localhost:8081${path}`;

describe("gate", () => {
  it("permits a safe in-scope action", () => {
    expect(gate(cfg, { url: at("/parabank/overview.htm"), action: "click", controlNames: ["Accounts Overview"] }))
      .toEqual({ decision: "allow", risk: "safe" });
  });

  it("refuses an out-of-allowlist action before considering risk", () => {
    const v = gate(cfg, { url: "https://evil.example/x", action: "click", controlNames: [] });
    expect(v).toMatchObject({ decision: "refuse" });
  });

  it("escalates an irreversible action even when in-allowlist", () => {
    expect(gate(cfg, { url: at("/parabank/admin.htm"), action: "click", controlNames: ["Clean"] }))
      .toMatchObject({ decision: "escalate", risk: "irreversible" });
  });

  it("refuses a guarded action while the capability is unapproved", () => {
    expect(gate(cfg, { url: at("/parabank/register.htm"), action: "fill", controlNames: ["First Name:"] }))
      .toMatchObject({ decision: "refuse", risk: "guarded" });
  });

  it("permits a guarded action once approved", () => {
    expect(gate({ ...cfg, approved: true }, { url: at("/parabank/register.htm"), action: "fill", controlNames: ["First Name:"] }))
      .toEqual({ decision: "allow", risk: "guarded" });
  });
});
