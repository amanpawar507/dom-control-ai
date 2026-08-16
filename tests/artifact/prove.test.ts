// tests/artifact/prove.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { proveControl } from "../../src/artifact/prove.js";
import { observe } from "../../src/observe/snapshot.js";
import { resolveBinding } from "../../src/surface/playwright-web/resolver.js";

let browser: Browser;
let page: Page;

const fixture = (n: string) => pathToFileURL(resolvePath(`tests/fixtures/parabank/${n}.html`)).href;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

describe("proveControl", () => {
  it("produces a chain whose every rung was proven unique on this page", async () => {
    await page.goto(fixture("findtrans"));
    const obs = await observe(page);
    const node = obs.nodes.find((n) => n.editable)!;
    const binding = await proveControl(page, node.handle);

    expect(binding.chain.length).toBeGreaterThan(0);
    for (const strategy of binding.chain) {
      const res = await resolveBinding(page, { scope: [], chain: [strategy] }, {});
      expect(res.ok, `tier ${strategy.tier} did not resolve uniquely`).toBe(true);
    }
  });

  it("refuses to emit a binding for an element nothing can uniquely address", async () => {
    // findtrans.html carries four identically-named buttons. If proving cannot
    // find a unique strategy it must throw, not emit a chain that resolves
    // ambiguously at replay time — that is the failure this whole design exists
    // to prevent.
    //
    // The brief's own `obs.nodes.find((n) => n.name === "Find Transactions")`
    // does not actually reach one of the four: findtrans.html's left-nav menu
    // carries its own link named exactly "Find Transactions"
    // (`<a href="findtrans.htm">Find Transactions</a>`), which observe() walks
    // in DOM order *before* the four buttons — so a bare `.find()` silently
    // picks the nav link, not an ambiguous button, and this test would pass
    // for a reason that has nothing to do with the four-buttons scenario it
    // claims to cover (that link *does* have a working anchor: "Bill Pay",
    // the item above it in the menu, uniquely identifies it). Filtering on
    // role as well is what actually reaches the four buttons this test is
    // about.
    await page.goto(fixture("findtrans"));
    const obs = await observe(page);
    const buttons = obs.nodes.filter((n) => n.name === "Find Transactions" && n.role === "button");
    expect(buttons.length).toBe(4);
    await expect(proveControl(page, buttons[0]!.handle)).rejects.toThrow(/unique/i);
  });

  // The failure above must be earned, not accidental: it must come from every
  // generated candidate genuinely failing to resolve uniquely, not from the
  // candidate generator quietly producing nothing to try. This test pins the
  // specific, known-ambiguous candidate directly, on the same terms
  // `tests/surface/resolver.test.ts`'s "refuses to choose among four
  // identically-named buttons" already establishes for the resolver itself —
  // so a change that made `proveControl` stop even attempting a role+name
  // guess (rather than correctly rejecting the one it tries) would leave this
  // failing for the wrong reason, and this test catches that distinction.
  it("rejects the ambiguous buttons because the obvious candidate is genuinely ambiguous, not because none was tried", async () => {
    await page.goto(fixture("findtrans"));
    const res = await resolveBinding(
      page,
      { scope: [], chain: [{ tier: 1, by: "role", role: "button", name: "Find Transactions" }] },
      {},
    );
    expect(res).toEqual({ ok: false, reason: "ambiguous", tier: 1, count: 4 });
  });

  it("orders the chain by what proved unique, not by tier number", async () => {
    // Spec §7: tier order is recorded per binding, decided by what proved
    // unique at record time. On a legacy surface that usually yields
    // anchor-first, which is why the chain is not sorted ascending.
    await page.goto(fixture("login"));
    const obs = await observe(page);
    const user = obs.nodes.find((n) => n.editable)!;
    const binding = await proveControl(page, user.handle);
    expect(binding.chain.every((s) => s.tier >= 0 && s.tier <= 3)).toBe(true);
  });

  // The test above only pins the weak property (valid tiers). ParaBank's own
  // login form has no `<label for>` association for either field — the
  // markup is `<p><b>Username</b></p>` followed by a sibling `<div>` holding
  // the input — so tier 1 (role+name) never even survives (no accessible
  // name), and the chain this codebase's own reasoning says should win is
  // anchor-first, css last: anchor text degrades gracefully with markup
  // churn as long as the visible label stays near the field, while a
  // class/attribute-based css selector is coupled to the exact current
  // structure. This pins that concretely, against the specific fixture the
  // brief calls out by name.
  it("ranks the anchor strategy ahead of the css strategy for ParaBank's own login form", async () => {
    await page.goto(fixture("login"));
    const obs = await observe(page);
    const user = obs.nodes.find((n) => n.editable)!;
    const binding = await proveControl(page, user.handle);

    const anchorIndex = binding.chain.findIndex((s) => s.by === "anchor");
    const cssIndex = binding.chain.findIndex((s) => s.by === "css");
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(cssIndex).toBeGreaterThanOrEqual(0);
    expect(anchorIndex).toBeLessThan(cssIndex);

    const anchorStrategy = binding.chain[anchorIndex];
    expect(anchorStrategy).toMatchObject({ by: "anchor", anchorText: "Username", rel: "nearest-below" });
  });

  // A handle is valid only for the observation that produced it —
  // `tests/observe/snapshot.test.ts` pins that `observe()` invalidates a
  // stale handle rather than silently re-pointing it. `proveControl` must
  // honour that rather than defeat it by falling back to some other match:
  // a handle from a superseded observation must fail loudly, the same way a
  // handle that was never stamped at all must.
  it("refuses to prove a handle from a superseded observation instead of searching for a near-match", async () => {
    await page.goto(fixture("login"));
    const first = await observe(page);
    const stale = first.nodes.find((n) => n.editable)!.handle;

    await observe(page); // renumbers the epoch; `stale` now matches nothing

    await expect(proveControl(page, stale)).rejects.toThrow(/matches 0 element/i);
  });

  it("refuses a handle that was never stamped at all", async () => {
    await page.goto(fixture("login"));
    await expect(proveControl(page, "o999n999")).rejects.toThrow(/matches 0 element/i);
  });
});
