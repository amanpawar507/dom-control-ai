// tests/artifact/prove.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { proveControl } from "../../src/artifact/prove.js";
import { observe, OBS_ATTR, type ObservedNode } from "../../src/observe/snapshot.js";
import { HANDLE_ATTR, resolveBinding } from "../../src/surface/playwright-web/resolver.js";
import type { Strategy } from "../../src/surface/types.js";

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

/**
 * The observation handle of whatever element this strategy resolves to, or
 * `null` if it does not resolve to exactly one, or resolves to something
 * `observe()` never stamped.
 *
 * This is the assertion the whole file exists to make and the one it used to
 * skip. `expect(res.ok).toBe(true)` says "exactly one element matches";
 * `expect(landedOn(s)).toBe(node.handle)` says "and it is the element the
 * model touched". Only the second one means anything for replay — a strategy
 * that resolves uniquely to the *wrong* control is precisely the artifact
 * that looks correct in every respect and clicks something else.
 */
async function landedOn(p: Page, strategy: Strategy): Promise<string | null> {
  const res = await resolveBinding(p, { scope: [], chain: [strategy] }, {});
  if (!res.ok) return null;
  return p.locator(`[${HANDLE_ATTR}="${res.handle}"]`).evaluate((el, attr) => el.getAttribute(attr), OBS_ATTR);
}

describe("proveControl", () => {
  it("produces a chain whose every rung resolves, uniquely, to the element it was proven for", async () => {
    await page.goto(fixture("findtrans"));
    const obs = await observe(page);
    const node = obs.nodes.find((n) => n.editable)!;
    const binding = await proveControl(page, node);

    expect(binding.chain.length).toBeGreaterThan(0);
    for (const strategy of binding.chain) {
      const res = await resolveBinding(page, { scope: [], chain: [strategy] }, {});
      expect(res.ok, `tier ${strategy.tier} did not resolve uniquely`).toBe(true);
      expect(await landedOn(page, strategy), `tier ${strategy.tier} resolved to a different element`).toBe(
        node.handle,
      );
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
    await expect(proveControl(page, buttons[0]!)).rejects.toThrow(/unique/i);
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
    expect(res).toEqual({
      ok: false,
      reason: "ambiguous",
      tier: 1,
      count: 4,
      // Every candidate is stamped and reported by handle (`Resolution`), so
      // this stays an exact-shape assertion rather than being loosened.
      candidates: [expect.any(String), expect.any(String), expect.any(String), expect.any(String)],
    });
  });

  it("orders the chain by what proved unique, not by tier number", async () => {
    // Spec §7: tier order is recorded per binding, decided by what proved
    // unique at record time. On a legacy surface that usually yields
    // anchor-first, which is why the chain is not sorted ascending.
    await page.goto(fixture("login"));
    const obs = await observe(page);
    const user = obs.nodes.find((n) => n.editable)!;
    const binding = await proveControl(page, user);
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
    const binding = await proveControl(page, user);

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
    const stale = first.nodes.find((n) => n.editable)!;

    await observe(page); // renumbers the epoch; `stale.handle` now matches nothing

    await expect(proveControl(page, stale)).rejects.toThrow(/matches 0 element/i);
  });

  it("refuses a handle that was never stamped at all", async () => {
    await page.goto(fixture("login"));
    const neverStamped: ObservedNode = { handle: "o999n999", role: "textbox", name: "", valueDigest: null, selectedIndex: null, editable: true };
    await expect(proveControl(page, neverStamped)).rejects.toThrow(/matches 0 element/i);
  });

  // `proveControl` takes role and name from the `ObservedNode` it is handed
  // rather than recomputing them itself — see the note on `proveControl` in
  // `src/artifact/prove.ts`. Before that change, this file kept its own copy
  // of `observe()`'s `walk` role heuristic, and the two had already drifted
  // for one input shape (a `<div contenteditable>`: `walk` maps it to role
  // "textbox", this file's old copy fell through to the bare tag "div"). The
  // fix removes the second copy rather than adding the missing branch, so
  // there is nothing left in this file to drift. That is easiest to pin not
  // by reproducing the contenteditable case (Chromium does not, in fact,
  // expose an implicit "textbox" role for a bare contenteditable element
  // either way, so that specific input can't distinguish "uses the passed
  // role" from "recomputes it" — both produce the same no-match outcome) but
  // directly: hand `proveControl` a role deliberately wrong for a real,
  // provable element, and confirm it fails instead of silently correcting
  // itself back to the true role by reading the DOM.
  it("uses the role and name it is handed, not values re-derived from the DOM", async () => {
    await page.goto(fixture("login"));
    const obs = await observe(page);
    const adminLink = obs.nodes.find((n) => n.name === "Admin Page")!;
    expect(adminLink.role).toBe("link");

    // Positive: the real node proves at tier 1 via its actual role.
    const real = await proveControl(page, adminLink);
    expect(real.chain).toEqual([{ tier: 1, by: "role", role: "link", name: "Admin Page" }]);

    // Negative: same handle, role deliberately swapped for one this element
    // does not have. If `proveControl` re-derived role from the live DOM
    // instead of trusting the argument, it would silently recompute "link"
    // again and this would succeed anyway — indistinguishable from the fix
    // actually being in place. It must fail instead: nothing else about this
    // node proves unique (see the chain above — a lone tier-1 entry, no
    // surviving css or anchor candidate), so a `proveControl` that actually
    // used the wrong role throws.
    const wrongRole: ObservedNode = { ...adminLink, role: "button" };
    await expect(proveControl(page, wrongRole)).rejects.toThrow(/unique/i);
  });

  it("records a fingerprint, so resolution rule 3 is something the artifact carries", () => {
    // Without this, every binding this phase produces skips the fingerprint
    // check at replay and spec §7's third resolution rule — "fingerprint and
    // stability must both hold" — holds because nothing tests it.
    return (async () => {
      await page.goto(fixture("login"));
      const obs = await observe(page);
      const input = obs.nodes.find((n) => n.editable)!;
      const binding = await proveControl(page, input);
      expect(binding.fingerprint?.tag).toBe("input");
    })();
  });

  it("records no `matches`, because inferring one from a single sample is how phase 1 broke", () => {
    // A format class guessed from one observed value is always consistent with
    // that value, so it looks right at record time and fails later on the first
    // legitimate variation. Phase 1 shipped exactly that: an inferred currency
    // fingerprint that rejected negative balances, reporting a valid overdrawn
    // account as a resolution failure. The recorder does not guess.
    return (async () => {
      await page.goto(fixture("login"));
      const obs = await observe(page);
      const input = obs.nodes.find((n) => n.editable)!;
      const binding = await proveControl(page, input);
      expect(binding.fingerprint?.matches).toBeUndefined();
    })();
  });

  it("the recorded fingerprint actually binds, on the one tier that needs it", () => {
    // Where a `tag` fingerprint earns its place is narrower than it first
    // looks, and worth stating precisely.
    //
    // Every tier except 0 already encodes the element type in its targeting:
    // the css candidates are tag-based (`input`, `input.foo`,
    // `input[name=x]`), the anchor strategy carries `accepts: [tag]`, and a
    // role is derived from the tag. If the element type changes, those
    // strategies stop matching and resolution fails as `no-match` before any
    // fingerprint is consulted.
    //
    // Tier 0 is the exception, and it is the tier the ladder prefers most:
    // `[data-testid="x"]` matches whatever element carries the attribute,
    // whatever it is. So a test id that survives onto a structurally different
    // element resolves cleanly and would be acted on — and the fingerprint is
    // the only thing standing between that and a click on the wrong kind of
    // control. ParaBank's fixtures carry no test ids at all, so this case
    // needs an authored page.
    return (async () => {
      const scratch = await browser.newPage();
      try {
        await scratch.setContent(`<input data-testid="amount" name="amount" value="10">`);
        const obs = await observe(scratch);
        const node = obs.nodes.find((n) => n.editable)!;
        const binding = await proveControl(scratch, node);

        expect(binding.chain[0]).toMatchObject({ tier: 0, by: "testid" });
        expect(binding.fingerprint?.tag).toBe("input");

        // The test id survives onto a div. Tier 0 still resolves to exactly
        // one element, so only the fingerprint can refuse it.
        await scratch.setContent(`<div data-testid="amount">10</div>`);
        const res = await resolveBinding(scratch, { ...binding, chain: [binding.chain[0]!] }, {});
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.reason).toBe("fingerprint-mismatch");

        // And without the fingerprint that same swap resolves happily — which
        // is what makes the assertion above load-bearing rather than incidental.
        const unguarded = await resolveBinding(scratch, { scope: [], chain: [binding.chain[0]!] }, {});
        expect(unguarded.ok).toBe(true);
      } finally {
        await scratch.close();
      }
    })();
  });

  // The two vectors below are the same defect seen from two tiers: a
  // candidate that resolves to exactly one element, which is not this
  // element. Uniqueness held in both; identity did not. Neither was caught by
  // anything in this file, because every assertion here used to stop at
  // `res.ok`.
  //
  // Both are written as "the chain contains no rung of tier N, and every rung
  // it does contain lands on the target". The second clause is what keeps the
  // first honest: a `proveControl` that generated no candidates at all would
  // satisfy "no tier-N rung" for the wrong reason, and the positive assertion
  // that some other rung *did* prove rules that out.

  it("rejects a role rung that resolves uniquely to a different element (the aria-hidden twin)", async () => {
    // `walk` has no `aria-hidden` clause and Playwright's accessible-name
    // computation does, so the two disagree about what exists. The ghost is
    // observed as {role:"button", name:"Save"} and handed to the model;
    // `getByRole("button",{name:"Save",exact:true})` skips it and matches only
    // the real button — exactly one element, and the wrong one. Both are
    // `<button>`, so the recorded `tag` fingerprint passes too.
    const scratch = await browser.newPage();
    try {
      await scratch.setContent(
        `<button aria-hidden="true" class="ghost">Save</button><button id="real">Save</button>`,
      );
      const obs = await observe(scratch);
      const ghost = obs.nodes.find((n) => n.name === "Save")!;
      // Both buttons are observed, and the ghost is the first of them — that
      // divergence is the premise of the whole test.
      expect(obs.nodes.filter((n) => n.name === "Save")).toHaveLength(2);

      // The premise, stated as a fact about the page rather than assumed: the
      // tier-1 candidate generated from the ghost resolves, uniquely, to the
      // real button.
      const roleRung: Strategy = { tier: 1, by: "role", role: "button", name: "Save" };
      const realHandle = obs.nodes.filter((n) => n.name === "Save")[1]!.handle;
      expect(await landedOn(scratch, roleRung)).toBe(realHandle);
      expect(realHandle).not.toBe(ghost.handle);

      const binding = await proveControl(scratch, ghost);
      expect(binding.chain.some((s) => s.by === "role")).toBe(false);
      expect(binding.chain.length).toBeGreaterThan(0);
      for (const strategy of binding.chain) {
        expect(await landedOn(scratch, strategy), `tier ${strategy.tier} left the target`).toBe(ghost.handle);
      }
    } finally {
      await scratch.close();
    }
  });

  it("rejects an anchor rung the target merely qualifies for while a nearer element wins it", async () => {
    // `readProvingFacts` checks that the target qualifies for a relation;
    // `anchorResolve` returns the *nearest* qualifier. Qualifying is not
    // winning. And `accepts: [facts.tag]` guarantees the element that does win
    // shares the target's tag, so the `tag` fingerprint — the only fingerprint
    // discovery records — cannot catch this one by construction.
    const scratch = await browser.newPage();
    try {
      await scratch.setViewportSize({ width: 1280, height: 800 });
      await scratch.setContent(`<div style="position:relative;height:60px">
  <span style="position:absolute;left:0px;top:10px">Amount:</span>
  <input id="target" name="target" style="position:absolute;left:300px;top:10px;width:50px;height:20px">
  <input id="decoy" name="decoy" style="position:absolute;left:120px;top:10px;width:50px;height:20px">
</div>`);
      const obs = await observe(scratch);
      const targetHandle = await handleOf(scratch, "#target");
      const decoyHandle = await handleOf(scratch, "#decoy");
      const target = obs.nodes.find((n) => n.handle === targetHandle)!;

      // The premise: the anchor rung the generator would produce for #target
      // resolves uniquely — to #decoy.
      const anchorRung: Strategy = {
        tier: 3,
        by: "anchor",
        anchorText: "Amount:",
        rel: "nearest-right",
        accepts: ["input"],
      };
      expect(await landedOn(scratch, anchorRung)).toBe(decoyHandle);
      expect(decoyHandle).not.toBe(target.handle);

      const binding = await proveControl(scratch, target);
      expect(binding.chain.some((s) => s.by === "anchor")).toBe(false);
      expect(binding.chain.length).toBeGreaterThan(0);
      for (const strategy of binding.chain) {
        expect(await landedOn(scratch, strategy), `tier ${strategy.tier} left the target`).toBe(target.handle);
      }
    } finally {
      await scratch.close();
    }
  });
});

/** The observation handle `observe()` stamped on the element this selector names. */
async function handleOf(p: Page, selector: string): Promise<string | null> {
  return p.locator(selector).evaluate((el, attr) => el.getAttribute(attr), OBS_ATTR);
}
