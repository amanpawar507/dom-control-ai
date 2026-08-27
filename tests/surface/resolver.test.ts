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
    const res = await resolveBinding(page, binding, {});
    expect(res).toEqual({
      ok: false, reason: "ambiguous", tier: 1, count: 4,
      candidates: [expect.any(String), expect.any(String), expect.any(String), expect.any(String)],
    });
    if (res.ok) return;
    // The candidates are identities, not a tally: each stamped handle names one
    // of the four buttons and no two name the same one. A caller can therefore
    // ask which elements the rung was torn between — which is the whole reason
    // the field exists — rather than only how many there were.
    const ids = await Promise.all(
      (res.candidates ?? []).map((h) => page.locator(`[data-dca-handle="${h}"]`).getAttribute("id")),
    );
    expect(ids).toEqual(["findById", "findByDate", "findByDateRange", "findByAmount"]);
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

  // ParaBank's own login form is the reason `nearest-below` exists at all.
  // Measured live: the Username label sits at y=287-302 and its input at
  // y=305-323, same x — stacked, not side by side, so `nearest-right` cannot
  // reach it. `login.html` loads no stylesheets, so its blocks stack vertically
  // in the fixture too, which is exactly the geometry this relation needs.
  it("resolves a field below its label, the ParaBank login shape", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Username", rel: "nearest-below", accepts: ["input"] }],
    };
    const res = await resolveBinding(page, binding, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const name = await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("name");
    expect(name).toBe("username");
  });

  // The mirror relation, exercised against the same captured markup: the
  // control immediately above the "Password" label, column-aligned with it, is
  // the username input. No new fixture markup needed — `nearest-above` is a
  // structural mirror of `nearest-below` and this pins it against real evidence.
  it("resolves a field above its label", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Password", rel: "nearest-above", accepts: ["input"] }],
    };
    const res = await resolveBinding(page, binding, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const name = await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("name");
    expect(name).toBe("username");
  });

  it("refuses to choose between two equidistant fields below an anchor", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Amount", rel: "nearest-below", accepts: ["input"] }],
    };
    // #below-tie-a and #below-tie-b share the same `top` and `left`, so neither
    // the primary (vertical gap) nor the secondary (horizontal offset) ranking
    // key breaks the tie.
    expect(await resolveBinding(page, binding, {})).toMatchObject({
      ok: false, reason: "ambiguous", tier: 3, count: 2,
    });
  });

  // `nearest-above` shares its tie-break block with `nearest-below` (whose tie is
  // pinned above), so the two relations agreeing on tie behaviour was, before this
  // test, a code-reading argument rather than something the suite verified for
  // itself: zeroing out `nearest-above`'s secondary ranking key left all 20
  // resolver tests green. This pins it directly, independent of `nearest-below`.
  it("refuses to choose between two equidistant fields above an anchor", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Total", rel: "nearest-above", accepts: ["input"] }],
    };
    // #above-tie-a and #above-tie-b share the same `top` and `left`, so neither
    // the primary (vertical gap) nor the secondary (horizontal offset) ranking
    // key breaks the tie.
    expect(await resolveBinding(page, binding, {})).toMatchObject({
      ok: false, reason: "ambiguous", tier: 3, count: 2,
    });
  });

  // The "resolves a field above its label" test above (login.html) proves
  // direction against real evidence, but only one input qualifies as "above"
  // Password there, so it cannot exercise ranking: a bug that always returned
  // the first qualifying candidate would still pass it. This proves both
  // ranking keys against #sub-far/#sub-near/#sub-offset:
  //   - #sub-far sits a full row further from "Subtotal" than the other two,
  //     so it must lose on the primary (vertical-gap) key.
  //   - #sub-near and #sub-offset are equidistant on the primary key —
  //     #sub-near is column-aligned with the anchor and #sub-offset is not, so
  //     only the secondary (horizontal-offset) key can tell them apart. A
  //     primary-only ranking test (farther vs. nearer, as the `nearest-right`
  //     "still picks the nearer" test above already covers for that relation)
  //     would never reach the secondary key at all, because the primary key
  //     alone would already have picked a unique winner.
  it("picks the nearest of several candidates above an anchor by vertical gap, then horizontal offset", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Subtotal", rel: "nearest-above", accepts: ["input"] }],
    };
    const res = await resolveBinding(page, binding, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("id")).toBe("sub-near");
  });

  // Pins the Task 1 fold-in for tier 3 across all five cases `isRenderedIn`
  // checks, not just `visibility:hidden`. `anchorResolve` cannot import
  // `isRenderedIn` and call it — the serialisation guard requires an evaluate
  // callback to resolve entirely within its own module — so the inline copy in
  // resolver.ts is independent text that has to be kept in sync by hand. Before
  // this table, only `visibility:hidden` had a tier-3 pin; `display:none`,
  // `opacity:0` and zero-area could each have been dropped from the inline copy
  // with the suite staying green throughout. `tests/observe/visibility.test.ts`
  // pins the same five cases directly against the canonical `isRenderedIn`; this
  // is their tier-3 counterpart, so a clause missing from either copy fails the
  // one case it stopped covering, in whichever file reaches it.
  it.each(["None Field", "Hidden Field", "Invisible Field", "Zero Field"])(
    "does not resolve a candidate at tier 3 hidden behind the %s anchor",
    async (anchorText) => {
      await page.goto(synthetic("geometry"));
      const binding: Binding = {
        scope: [],
        chain: [{ tier: 3, by: "anchor", anchorText, rel: "nearest-right", accepts: ["input"] }],
      };
      const res = await resolveBinding(page, binding, {});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe("no-match");
    },
  );

  // The fifth case, and the one that must NOT be excluded: offscreen is not the
  // same as hidden. A control below the fold, or scrolled past, is real and
  // clickable once scrolled to — treating it as hidden would make anything past
  // the first screenful of a long form unreachable. `#offscreen-input` sits at
  // left:9999px, well outside the viewport but still "to the right" of its
  // anchor, so `nearest-right` can reach it.
  it("still resolves an offscreen candidate at tier 3, which is rendered but scrolled away", async () => {
    await page.goto(synthetic("geometry"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Offscreen Field", rel: "nearest-right", accepts: ["input"] }],
    };
    const res = await resolveBinding(page, binding, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("id")).toBe("offscreen-input");
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

  it("resolves an unscoped binding normally, rather than throwing for every binding", async () => {
    // The other half of the guard: it refuses what it cannot honour (previous
    // test) and nothing else. Without this, a resolver that threw on every
    // binding would pass. Deliberately a different, visible target than the
    // scope-guard test above: `#showResult h1` is the hidden success node
    // exercised by the "rejects a hidden node" regression test below, and no
    // longer resolves now that tiers 0-2 filter for rendering.
    await page.goto(fixture("transfer"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: "#showForm h1" }],
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: true, tier: 2 });
  });

  it("rejects a hidden node at tier 2, matching tier 1's behaviour", async () => {
    // Phase 1 shipped a ladder that disagreed with itself here: tier 1 rejected
    // the hidden success node and tier 2 accepted it, fingerprint and all.
    await page.goto(fixture("transfer"));
    const res = await resolveBinding(
      page,
      { scope: [], chain: [{ tier: 2, by: "css", value: "#showResult h1" }] },
      {},
    );
    expect(res.ok).toBe(false);
  });

  // The brief's own version of these two tests targets an account-overview
  // fixture (`#accountTable`) that is not among the captured fixtures in this
  // repo — only findtrans/login/transfer exist under tests/fixtures/parabank/.
  // Adapted to findtrans.html, keeping the brief's chain shapes (a testid that
  // is nowhere on the page, then a css selector already proven unique by the
  // "falls through an ambiguous strategy" test above) so the assertion is about
  // `attempts`, not about which fixture happens to host it.
  it("records the rungs that missed before the one that won", async () => {
    await page.goto(fixture("findtrans"));
    const res = await resolveBinding(page, {
      scope: [],
      chain: [
        { tier: 0, by: "testid", value: "not-present-anywhere" },
        { tier: 2, by: "css", value: "#findByAmount" },
      ],
    }, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tier).toBe(2);
    expect(res.attempts).toEqual([{ tier: 0, reason: "no-match" }]);
  });

  it("reports an empty attempt list when the first rung wins", async () => {
    await page.goto(fixture("findtrans"));
    const res = await resolveBinding(page, {
      scope: [],
      chain: [{ tier: 1, by: "role", role: "link", name: "Accounts Overview" }],
    }, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempts).toEqual([]);
  });

  // `ok: true` claims "exactly one element", and the handle is the only form in
  // which that element leaves the resolver — so the claim is false the moment two
  // elements answer to the handle. A page that clones an already-stamped node is
  // how that happens, and it is not exotic: a re-rendered row or a duplicated
  // table body does it. The actor refuses such a handle before acting, but a
  // property every caller has to re-check is a property nobody owns, and replay's
  // corroboration compares two rungs *by handle string* — it would read agreement
  // into two genuinely different elements.
  it("refuses a handle that more than one element answers to", async () => {
    await page.setContent(`<input id="orig" data-testid="amt">`);
    const binding: Binding = { scope: [], chain: [{ tier: 0, by: "testid", value: "amt" }] };

    const before = await resolveBinding(page, binding, {});
    expect(before).toMatchObject({ ok: true, tier: 0 });

    // Clone the stamped node, stripping what the strategy matches on, so the
    // strategy still finds exactly one element and only the handle is shared.
    await page.evaluate(() => {
      const el = document.querySelector("#orig");
      if (el === null) throw new Error("fixture element missing");
      const twin = el.cloneNode(true) as Element;
      twin.setAttribute("id", "twin");
      twin.removeAttribute("data-testid");
      document.body.appendChild(twin);
    });

    expect(await resolveBinding(page, binding, {})).toEqual({
      ok: false, reason: "ambiguous", tier: 0, count: 2, candidates: [expect.any(String)],
    });
  });

  it("falls through a duplicated handle to a rung whose element still owns its own", async () => {
    // The duplicated handle is reported as ambiguity and the chain continues,
    // rather than ending the resolution: another rung may land on an element
    // whose identity is still its own, and that answer is safe to return.
    await page.setContent(`<input id="a" data-testid="amt"><input id="b" name="other">`);
    await resolveBinding(page, { scope: [], chain: [{ tier: 0, by: "testid", value: "amt" }] }, {});
    await page.evaluate(() => {
      const el = document.querySelector("#a");
      if (el === null) throw new Error("fixture element missing");
      const twin = el.cloneNode(true) as Element;
      twin.setAttribute("id", "a-twin");
      twin.removeAttribute("data-testid");
      document.body.appendChild(twin);
    });

    const res = await resolveBinding(page, {
      scope: [],
      chain: [
        { tier: 0, by: "testid", value: "amt" },
        { tier: 2, by: "css", value: 'input[name="other"]' },
      ],
    }, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tier).toBe(2);
    expect(res.attempts).toEqual([{ tier: 0, reason: "ambiguous" }]);
    expect(await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("id")).toBe("b");
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
