// src/discover/budget.ts

/**
 * Thrown by `Budget.charge()` when applying a charge would push cumulative
 * spend past the configured ceiling. The charge that triggers this is never
 * recorded — see `Budget.charge` for why that ordering is the entire point
 * of this class.
 */
export class BudgetExceeded extends Error {
  constructor(
    public readonly limitUsd: number,
    public readonly attemptedUsd: number,
  ) {
    super(
      `budget exceeded: charging this turn would bring total spend to $${attemptedUsd.toFixed(4)}, over the $${limitUsd.toFixed(2)} ceiling`,
    );
    this.name = "BudgetExceeded";
  }
}

/**
 * A hard spend ceiling for the discovery loop, not an advisory counter. With
 * $5 of total funding for this phase, "remember to check the running total"
 * is not good enough — a runaway loop must be structurally unable to spend
 * past the limit, which is what `charge` throwing (rather than warning)
 * gives us.
 *
 * `rate` is a constructor parameter rather than a hardcoded constant so that
 * Sonnet 5's intro pricing ($2/1M input, $10/1M output, in effect through
 * 2026-08-31) can be swapped for whatever replaces it without editing this
 * class — only the call site that constructs a `Budget` changes.
 */
export class Budget {
  private spent = 0;

  constructor(
    private readonly limitUsd: number,
    private readonly rate: { inPerM: number; outPerM: number },
  ) {}

  /**
   * Converts `u` to a dollar cost at `rate` and, only if the resulting total
   * would not exceed `limitUsd`, commits it to the running total.
   *
   * The check happens strictly before the write. A `charge` that recorded
   * first and threw second would leave `spentUsd()` reporting money the
   * guard just refused to spend — the object would be lying about its own
   * state at the exact moment it is supposed to be most trustworthy. The
   * projected total is computed into a local (`projected`), tested, and only
   * then assigned to `this.spent`; there is no intermediate state in which
   * the rejected charge is visible.
   */
  charge(u: { inputTokens: number; outputTokens: number }): void {
    const cost = (u.inputTokens / 1_000_000) * this.rate.inPerM + (u.outputTokens / 1_000_000) * this.rate.outPerM;
    const projected = this.spent + cost;
    if (projected > this.limitUsd) {
      throw new BudgetExceeded(this.limitUsd, projected);
    }
    this.spent = projected;
  }

  spentUsd(): number {
    return this.spent;
  }
}
