import { chromium } from "playwright";
import type { AuthenticatedContext, SessionProvider } from "./provider.js";

/**
 * Credentials are confined to this module. Nothing above the seam ever sees
 * them: acquire() returns only { storageState, acquiredAt } — the serialized
 * Playwright storage state (a session cookie) and a timestamp. Playwright's
 * storageState() captures cookies and localStorage/sessionStorage only, never
 * form input, so the fixture username/password never enter the returned
 * value. This module must never write to a log or evidence file.
 *
 * The local implementation uses the fixture account shipped inside the
 * container image (never a real credential), read the same way
 * scripts/capture-fixtures.mts does.
 */
export class ParabankSessionProvider implements SessionProvider {
  /**
   * The only product this provider serves. Both acquire()'s validation and
   * refresh()'s delegation reference this constant, so there is exactly one
   * place that knows what this provider is for.
   */
  private static readonly PRODUCT = "parabank";

  constructor(
    private readonly base: string,
    private readonly username = process.env["PARABANK_USER"] ?? "john",
    private readonly password = process.env["PARABANK_PASS"] ?? "demo",
  ) {}

  async acquire(product: string, _tenant: string): Promise<AuthenticatedContext> {
    // _tenant is intentionally unused, not merely unimplemented: this
    // provider serves exactly one tenant (the fixture account inside the
    // local ParaBank container). Accepting the argument and silently
    // ignoring it is honest about that; validating or routing on it would
    // imply multi-tenant support that does not exist.
    if (product !== ParabankSessionProvider.PRODUCT) {
      throw new Error(
        `ParabankSessionProvider serves only ParaBank; received product "${product}"`,
      );
    }
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${this.base}/index.htm`);
      await page.locator('input[name="username"]').fill(this.username);
      await page.locator('input[name="password"]').fill(this.password);
      await page.locator('input[value="Log In"]').click();
      // Success signal verified against the live container: a successful
      // login redirects to /overview.htm; this does not fire on failure.
      // On failure, verified against the live container, Playwright raises
      // a plain TimeoutError naming only the URL pattern and timeout — never
      // a locator's value — so no credential surfaces on that path either.
      await page.waitForURL(/overview\.htm/, { timeout: 20_000 });
      const state = await ctx.storageState();
      return { storageState: JSON.stringify(state), acquiredAt: new Date().toISOString() };
    } finally {
      await browser.close();
    }
  }

  async refresh(_ctx: AuthenticatedContext): Promise<AuthenticatedContext> {
    return this.acquire(ParabankSessionProvider.PRODUCT, "local");
  }

  async release(_ctx: AuthenticatedContext): Promise<void> {
    // Storage state is in-memory only; nothing to revoke against this target.
  }
}
