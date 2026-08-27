import { describe, it, expect } from "vitest";
import { Budget, BudgetExceeded } from "../../src/discover/budget.js";

describe("Budget", () => {
  it("throws before the spend crosses the ceiling, not after", () => {
    // Sonnet 5 intro rate: $2/1M in, $10/1M out.
    const b = new Budget(0.05, { inPerM: 2, outPerM: 10 });
    b.charge({ inputTokens: 10_000, outputTokens: 1_000 }); // $0.02 + $0.01
    expect(b.spentUsd()).toBeCloseTo(0.03, 4);
    expect(() => b.charge({ inputTokens: 20_000, outputTokens: 0 })).toThrow(BudgetExceeded);
    // and the rejected charge must not have been recorded
    expect(b.spentUsd()).toBeCloseTo(0.03, 4);
  });

  it("rejects specifically because the ceiling would be crossed, not for some other reason", () => {
    // A bare `.toThrow()` would also pass if charge threw on, say, negative
    // token counts or a malformed argument. Pin down the actual error type
    // and its reported numbers so a future refactor can't silently change
    // what "reject" means here.
    const b = new Budget(0.05, { inPerM: 2, outPerM: 10 });
    b.charge({ inputTokens: 10_000, outputTokens: 1_000 });
    let caught: unknown;
    try {
      b.charge({ inputTokens: 20_000, outputTokens: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExceeded);
    const err = caught as BudgetExceeded;
    expect(err.limitUsd).toBe(0.05);
    expect(err.attemptedUsd).toBeCloseTo(0.07, 4);
  });

  it("allows a charge that lands exactly on the ceiling", () => {
    // "Crosses" the ceiling, not "reaches" it — a charge that brings spend
    // to exactly the limit has not overspent.
    const b = new Budget(0.05, { inPerM: 2, outPerM: 10 });
    expect(() => b.charge({ inputTokens: 25_000, outputTokens: 0 })).not.toThrow(); // $0.05 exactly
    expect(b.spentUsd()).toBeCloseTo(0.05, 4);
  });

  it("accumulates across multiple successful charges", () => {
    const b = new Budget(1, { inPerM: 2, outPerM: 10 });
    b.charge({ inputTokens: 100_000, outputTokens: 0 }); // $0.20
    b.charge({ inputTokens: 100_000, outputTokens: 0 }); // $0.20
    expect(b.spentUsd()).toBeCloseTo(0.4, 4);
  });

  it("leaves room for a later charge that fits, after an earlier one was rejected", () => {
    // A rejected charge must not corrupt the running total for whatever
    // comes after it — a smaller charge that still fits under the ceiling
    // must succeed exactly as if the rejected one had never been attempted.
    const b = new Budget(0.01, { inPerM: 2, outPerM: 10 });
    expect(() => b.charge({ inputTokens: 10_000, outputTokens: 0 })).toThrow(BudgetExceeded); // $0.02 > $0.01
    expect(b.spentUsd()).toBe(0);
    expect(() => b.charge({ inputTokens: 1_000, outputTokens: 0 })).not.toThrow(); // $0.002, fits
    expect(b.spentUsd()).toBeCloseTo(0.002, 4);
  });
});
