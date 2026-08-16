// tests/surface/resolver.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { resolveBinding } from "../../src/surface/playwright-web/resolver.js";
import type { Binding } from "../../src/surface/types.js";

let browser: Browser;
let page: Page;

const fixture = (n: string) => pathToFileURL(resolvePath(`tests/fixtures/parabank/${n}.html`)).href;
/** Hand-authored geometry fixtures, deliberately kept apart from captured markup. */
const synthetic = (n: string) => pathToFileURL(resolvePath(`tests/fixtures/synthetic/${n}.html`)).href;

beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

describe("resolveBinding", () => {
  it("refuses to choose among four identically-named buttons", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 1, by: "role", role: "button", name: "Find Transactions" }],
    };
    expect(await resolveBinding(page, binding, {})).toEqual({
      ok: false, reason: "ambiguous", tier: 1, count: 4,
    });
  });

  // The anchor tests run against findtrans.html, not login.html. Both fixtures have
  // unassociated labels (neither carries a single `<label for=>`), but login.html
  // renders its label in a block `<p>` *above* the input — the input is below the
  // anchor, never to its right, so "nearest-right" is unsatisfiable there by
  // construction. findtrans.html has the genuine inline form of the same legacy
  // pattern: `<b>Find by Transaction ID</b>: <input id="transactionId">`.
  it("resolves an unnamed input by anchor text to its right-hand neighbour", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Find by Transaction ID", rel: "nearest-right", accepts: ["input"] }],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tier).toBe(3);
    // Assert *which* control was resolved, not merely that one was: the geometry
    // must land on the input to the right of that anchor and no other.
    expect(await page.locator("[data-dca-handle]").getAttribute("id")).toBe("transactionId");
  });

  it("falls through a failing tier to the next strategy in the chain", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [
        { tier: 1, by: "role", role: "textbox", name: "Find by Transaction ID" }, // no accessible name — fails
        { tier: 3, by: "anchor", anchorText: "Find by Transaction ID", rel: "nearest-right", accepts: ["input"] },
      ],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r).toMatchObject({ ok: true, tier: 3 });
  });

  it("reports no-match when every strategy fails", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: "#definitely-not-here" }],
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: false, reason: "no-match" });
  });

  it("rejects a unique match whose fingerprint does not hold", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: 'input[name="username"]' }],
      fingerprint: { tag: "select" },
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: false, reason: "fingerprint-mismatch" });
  });

  // Regression pins, not red-first tests: both already hold under the current
  // implementation. They fix behaviour the chain depends on but nothing exercised —
  // that an ambiguous tier is survivable, and that the *first* ambiguous tier is the
  // one reported once several are ambiguous.
  it("falls through an ambiguous strategy to a later unique one", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [
        { tier: 1, by: "role", role: "button", name: "Find Transactions" }, // 4 matches
        { tier: 2, by: "css", value: "#findByAmount" },                     // exactly 1
      ],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r).toMatchObject({ ok: true, tier: 2 });
  });

  it("reports the first ambiguous tier when several strategies are ambiguous", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [
        { tier: 1, by: "role", role: "button", name: "Find Transactions" }, // 4 matches
        { tier: 2, by: "css", value: "button.button" },                     // also 4
      ],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r).toMatchObject({ ok: false, reason: "ambiguous", tier: 1 });
  });

  // A tier-0 testid is used deliberately, not a css selector. `#$accountId` would make
  // Playwright's own CSS parser throw, so that test would pass without any validation
  // on our side. `[data-testid="$accountId"]` parses cleanly and silently reports
  // no-match — indistinguishable from a legitimately absent element. That silence is
  // the bug. The assertion pins our own message so it cannot pass on a parse error.
  it("throws on an unbound $placeholder instead of targeting it literally", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 0, by: "testid", value: "$accountId" }],
    };
    await expect(resolveBinding(page, binding, {})).rejects.toThrow(
      /unbound placeholder "\$accountId" in tier 0 testid strategy/i,
    );
  });

  // Geometry edge cases the captured ParaBank markup cannot produce: it contains no
  // overlapping or absolutely-positioned controls, so the tie branch is unreachable
  // from those fixtures. Pinned here against hand-authored markup instead.
  it("refuses to choose between two equidistant candidates on the same row", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Amount", rel: "nearest-right", accepts: ["input"] }],
    };
    // #tie-a and #tie-b share the same `left`, so neither is nearer. A total order
    // over distance does not exist here, and picking one would be first-of-many.
    expect(await resolveBinding(page, binding, {})).toMatchObject({
      ok: false, reason: "ambiguous", tier: 3, count: 2,
    });
  });

  it("still picks the nearer of two candidates at distinct distances", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Reference", rel: "nearest-right", accepts: ["input"] }],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r).toMatchObject({ ok: true, tier: 3 });
    // Tie-collection must not have broken ordinary nearest-wins resolution.
    expect(await page.locator("[data-dca-handle]").getAttribute("id")).toBe("near");
  });

  // Frame and shadow descent belong with the observer in Phase 2. What must not
  // wait for Phase 2 is the guard: `scope` was accepted and ignored, so a
  // binding naming a frame that does not exist resolved against the top
  // document and reported `{ok:true, tier:2, handle}`. A missing feature that
  // fails loudly is a deferral; one that answers confidently about the wrong
  // element is the defect this component exists to prevent.
  it("refuses a binding whose scope cannot be honoured, rather than resolving elsewhere", async () => {
    await page.goto(fixture("transfer"));
    const binding: Binding = {
      scope: [{ kind: "frame", name: "no-such-frame" }],
      // Deliberately a chain that *does* resolve against the top document, so
      // this cannot pass merely because the element was absent.
      chain: [{ tier: 2, by: "css", value: "#showResult h1" }],
    };
    await expect(resolveBinding(page, binding, {})).rejects.toThrow(/scope.*\/frame:no-such-frame/i);
  });

  it("resolves that same chain when the binding declares no scope", async () => {
    // The other half of the guard: it refuses what it cannot honour and nothing
    // else. Without this, a resolver that threw on every binding would pass.
    await page.goto(fixture("transfer"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: "#showResult h1" }],
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: true, tier: 2 });
  });

  it("substitutes $arg placeholders into strategy fields", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "$label", rel: "nearest-right", accepts: ["input"] }],
    };
    const r = await resolveBinding(page, binding, { label: "Find by Amount" });
    expect(r.ok).toBe(true);
    expect(await page.locator("[data-dca-handle]").getAttribute("id")).toBe("amount");
  });
});
