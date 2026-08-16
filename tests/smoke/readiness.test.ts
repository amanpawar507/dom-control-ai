// Container-free: imports the smoke module but drives one function of it with
// stubs, so nothing launches and nothing is logged in to.
//
// What is pinned here lives on a path a passing run never takes. `resolveWhenReady`
// renames Playwright's readiness timeout into an error that names the control,
// the page and the budget — and because a green run never enters that catch, a
// refactor that dropped the try/catch would have stayed green. Given that this
// phase has already shipped guards that looked enforced and were not, an unpinned
// error message is the same shape of risk one level down.
import { describe, expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import { resolveWhenReady } from "../../src/e2e/phase1-smoke.js";
import type { Binding } from "../../src/surface/types.js";

const PAGE_URL = "http://localhost:8081/parabank/admin.htm";

class NeverReadyLocator {
  /** The budget the caller actually asked for, recorded rather than assumed. */
  timeoutAsked: number | null = null;

  first(): NeverReadyLocator {
    return this;
  }

  async waitFor(opts: { state: string; timeout: number }): Promise<void> {
    this.timeoutAsked = opts.timeout;
    throw new PlaywrightishTimeout(
      "locator.waitFor: Timeout 20000ms exceeded.\nCall log:\n  - waiting for getByRole('button')",
    );
  }

  asLocator(): Locator {
    return this as unknown as Locator;
  }
}

/** Stands in for Playwright's TimeoutError: a distinct type carrying a call log. */
class PlaywrightishTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * A page that can only say where it is. Anything else the code under test
 * reaches for is `undefined` and throws a TypeError, which fails the test rather
 * than passing quietly — in particular, resolution must not be attempted after a
 * readiness failure.
 */
const stubPage = { url: () => PAGE_URL } as unknown as Page;

const BINDING: Binding = { scope: [], chain: [{ tier: 1, by: "role", role: "button", name: "Clean" }] };

describe("resolveWhenReady", () => {
  it("names the control, the page and the budget when readiness times out", async () => {
    const locator = new NeverReadyLocator();

    const err: unknown = await resolveWhenReady(stubPage, "admin_clean", {
      binding: BINDING,
      ready: () => locator.asLocator(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // Playwright's own message says only that a locator.waitFor exceeded
    // 20000ms: no control, no page, nothing an operator can act on at 3am.
    expect(message).toContain("admin_clean");
    expect(message).toContain(PAGE_URL);
    // Asserted against the budget the wait was actually given, so this keeps
    // pinning that the budget is named even if the budget itself changes.
    expect(locator.timeoutAsked).not.toBeNull();
    expect(message).toContain(`${locator.timeoutAsked}ms`);
  });

  it("keeps Playwright's own error as the cause, so no detail is traded away", async () => {
    const locator = new NeverReadyLocator();

    const err: unknown = await resolveWhenReady(stubPage, "admin_clean", {
      binding: BINDING,
      ready: () => locator.asLocator(),
    }).catch((e: unknown) => e);

    const cause = (err as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).name).toBe("TimeoutError");
    // The call log is the part an operator actually debugs from.
    expect((cause as Error).message).toContain("Call log:");
  });

  it("waits for the control to be attached before resolving it", async () => {
    const locator = new NeverReadyLocator();

    await resolveWhenReady(stubPage, "admin_clean", {
      binding: BINDING,
      ready: () => locator.asLocator(),
    }).catch(() => undefined);

    // Resolution is never attempted after a failed wait: the stub page has no
    // `locator` member, so resolveBinding would have thrown a TypeError and the
    // assertions above would have failed on the wrong error type.
    expect(locator.timeoutAsked).toBe(20_000);
  });
});
