// tests/replay/identity.test.ts
//
// These tests assert on *which element* was resolved, not merely that
// something was. That distinction is the whole subject: every check that
// exists today — uniqueness at each rung, a `tag` fingerprint over the
// winner — passes for a chain whose rungs land on different elements, which
// is precisely the case `resolveCorroborated` exists to refuse. A test that
// only asserted `ok`/`reason` would pass against a first-match implementation
// on three of the four cases below and would therefore be testing the
// outcome rather than the guarantee.
//
// `page.setContent` keeps this container-free and network-free: the markup is
// inline, nothing is fetched, and the resolver runs against a real browser
// layout engine because tier-3 geometry and `getComputedStyle` are not
// simulable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveCorroborated } from "../../src/replay/identity.js";
import { HANDLE_ATTR } from "../../src/surface/playwright-web/resolver.js";
import type { Binding } from "../../src/surface/types.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

/** The `id` of the element a handle names — the identity assertion these tests are about. */
async function idOf(handle: string): Promise<string | null> {
  return page.locator(`[${HANDLE_ATTR}="${handle}"]`).getAttribute("id");
}

describe("resolveCorroborated", () => {
  it("resolves when every rung agrees", async () => {
    // Two proven strategies, one element. This is the ordinary case and must
    // stay cheap to reason about.
    await page.setContent(`<input data-testid="amt" name="amount">`);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(2);
  });

  it("refuses when two rungs resolve to different elements", async () => {
    // The surface drifted: the test id moved to a different input. Each rung
    // still resolves uniquely, so every check that exists today passes — and
    // acting on either would be a guess about which one the recording meant.
    await page.setContent(`
      <input data-testid="amt" name="moved">
      <input name="amount">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("chain-disagreement");
    // Reported against a reference rung — the first that resolved — so the
    // field names what to go and look at. The brief's own draft of this test
    // expected `[0, 2]`, every rung that resolved; the coordinator's round-1
    // direction narrowed it to the rungs that differ from the reference,
    // because naming the reference among the disagreeing has it disagreeing
    // with itself and leaves a reader nothing to act on.
    expect(res.tier).toBe(0);
    expect(res.disagreeingTiers).toEqual([2]);
  });

  it("still resolves on a single-rung chain, reporting that nothing corroborated it", async () => {
    // Honest rather than strict: a one-rung binding cannot be corroborated, and
    // refusing it would make the common case unreplayable. The count says so.
    await page.setContent(`<input data-testid="amt">`);
    const res = await resolveCorroborated(
      page,
      { scope: [], chain: [{ tier: 0, by: "testid", value: "amt" }] },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(1);
  });

  it("ignores a rung that no longer resolves at all, provided the rest agree", async () => {
    // A missing rung is drift too, but it is not ambiguity: nothing about it
    // suggests a different element. Recording it as unresolved and continuing
    // is what keeps a capability alive across a harmless markup change.
    await page.setContent(`<input name="amount">`);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "gone" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(1);
  });

  it("returns the element the rungs agreed on, named by the strongest rung that resolved", async () => {
    // Two candidate inputs on the page, so "it resolved" and "it resolved to
    // the right one" are different claims and the assertion is on the second.
    // The reported tier is the first rung in chain order that resolved — the
    // chain is ordered by record-time reliability, so that is the strongest
    // surviving strategy, not an accident of iteration.
    await page.setContent(`
      <input id="decoy" name="other">
      <input id="target" data-testid="amt" name="amount" placeholder="Amount">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
          { tier: 2, by: "css", value: 'input[placeholder="Amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await idOf(res.handle)).toBe("target");
    expect(res.tier).toBe(0);
    expect(res.agreed).toBe(3);
  });

  it("keeps walking after two rungs agree, so a later rung can still disagree", async () => {
    // The reason the walk is exhaustive rather than early-exit. A first-match
    // implementation, and equally a stop-when-two-agree one, returns the input
    // here and never learns that the role rung now names a different control.
    await page.setContent(`
      <input id="target" data-testid="amt" name="amount">
      <button id="go">Go</button>
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
          { tier: 1, by: "role", role: "button", name: "Go" },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("chain-disagreement");
    // The rungs that differ from the reference (tier 0, the first that
    // resolved), in chain order. Two of the three agree, and that majority
    // buys nothing — the reference is a coordinate for reading the report,
    // not a ruling that the outvoted rung is the wrong one. Nothing is acted
    // on either way.
    expect(res.tier).toBe(0);
    expect(res.disagreeingTiers).toEqual([1]);
  });

  it("names only the rungs that actually resolved when reporting disagreement", async () => {
    // A rung that no longer matches is drift, not evidence of a different
    // element, so it must not be listed among the tiers that disagree —
    // otherwise the report sends whoever reads it to inspect a strategy that
    // said nothing.
    await page.setContent(`
      <input id="a" data-testid="amt">
      <input id="b" name="amount">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 1, by: "role", role: "button", name: "Nowhere" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("chain-disagreement");
    expect(res.tier).toBe(0);
    expect(res.disagreeingTiers).toEqual([2]);
  });

  it("treats an ambiguous rung that still matches the agreed element as drift", async () => {
    // `input` now matches both inputs, and #target — the element the resolved
    // rung named — is one of them. That rung has lost its discriminating
    // power; it has not started pointing somewhere else, so it contradicts
    // nothing. It still cannot corroborate, because there is no single element
    // to compare, so `agreed` stays at the one rung that did resolve.
    await page.setContent(`
      <input id="target" data-testid="amt">
      <input id="other">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: "input" },
        ],
      },
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(1);
    expect(await idOf(res.handle)).toBe("target");
  });

  it("refuses when an ambiguous rung matches several elements and the agreed one is not among them", async () => {
    // The downgrade path this closes: without it, drift only has to make a
    // contradicting rung ambiguous rather than uniquely wrong, and a refusal
    // becomes a shrug — the tier-0 rung would win alone with `agreed: 1` while
    // a proven rung was pointing at two entirely different elements. The
    // judgment needs the rung's match set, which is why `Resolution` carries
    // the candidate handles rather than only a count.
    await page.setContent(`
      <input id="target" data-testid="amt">
      <input id="x" class="amount">
      <input id="y" class="amount">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "amt" },
          { tier: 2, by: "css", value: "input.amount" },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("chain-disagreement");
    expect(res.tier).toBe(0);
    expect(res.disagreeingTiers).toEqual([2]);
  });

  it("reports ambiguity when that is the only thing standing in the way", async () => {
    // Nothing resolved, and one rung matched several elements. Reporting
    // `no-match` there would be false: the element is plausibly still present
    // and the strategy stopped telling it apart from its neighbours.
    await page.setContent(`<input id="a"><input id="b">`);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "gone" },
          { tier: 2, by: "css", value: "input" },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("ambiguous");
    expect(res.tier).toBe(2);
  });

  it("reports no-match when no rung finds anything", async () => {
    await page.setContent(`<p>nothing here</p>`);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "gone" },
          { tier: 2, by: "css", value: 'input[name="amount"]' },
        ],
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-match");
  });

  it("carries the binding's fingerprint into every rung it checks", async () => {
    // The fingerprint is a property of the binding, not of the winning rung.
    // Dropping it while resolving rungs one at a time would silently disable
    // the one check Phase 2 did ship.
    await page.setContent(`<div data-testid="amt">not an input any more</div>`);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [{ tier: 0, by: "testid", value: "amt" }],
        fingerprint: { tag: "input" },
      },
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("fingerprint-mismatch");
    expect(res.tier).toBe(0);
  });

  it("substitutes arguments into every rung, and agreement is over the substituted values", async () => {
    await page.setContent(`
      <input id="wrong" data-testid="row-1-amt" name="amount-1">
      <input id="right" data-testid="row-2-amt" name="amount-2">
    `);
    const res = await resolveCorroborated(
      page,
      {
        scope: [],
        chain: [
          { tier: 0, by: "testid", value: "row-$row-amt" },
          { tier: 2, by: "css", value: 'input[name="amount-$row"]' },
        ],
      },
      { row: "2" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreed).toBe(2);
    expect(await idOf(res.handle)).toBe("right");
  });

  it("refuses when the agreed handle has stopped naming exactly one element", async () => {
    // Identity here is a handle string, and the string is only an identity for
    // as long as one element carries it. A page that clones a stamped node
    // breaks that: both copies carry the handle, so two rungs landing on two
    // different elements would compare equal and the agreement would be
    // fiction.
    //
    // The guarantee that makes the comparison sound lives in `resolveBinding`,
    // which refuses a handle more than one element answers to rather than
    // reporting `ok: true` (see `tests/surface/resolver.test.ts`). This test is
    // the consumer-side regression: corroboration relies on that property and
    // deliberately does not re-check it, so it has to fail here if the resolver
    // ever stops providing it.
    await page.setContent(`<input id="orig" data-testid="amt" name="amount">`);
    const binding: Binding = {
      scope: [],
      chain: [
        { tier: 0, by: "testid", value: "amt" },
        { tier: 2, by: "css", value: 'input[name="amount"]' },
      ],
    };

    const before = await resolveCorroborated(page, binding, {});
    expect(before.ok).toBe(true);

    // Clone the stamped element, stripping the attributes the two rungs match
    // on so both still resolve to the original and only the handle is shared.
    await page.evaluate(() => {
      const el = document.querySelector("#orig");
      if (el === null) throw new Error("fixture element missing");
      const twin = el.cloneNode(true) as Element;
      twin.setAttribute("id", "twin");
      twin.removeAttribute("data-testid");
      twin.removeAttribute("name");
      document.body.appendChild(twin);
    });

    const after = await resolveCorroborated(page, binding, {});
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe("ambiguous");
  });

  it("propagates a binding the resolver cannot honour at all rather than reporting a miss", async () => {
    // A scoped binding is "this resolver cannot replay this", which is a
    // different statement from "the element was not there". Swallowing the
    // throw into `no-match` would let a frame-scoped binding look like
    // ordinary drift.
    await page.setContent(`<input data-testid="amt">`);
    await expect(
      resolveCorroborated(
        page,
        { scope: [{ kind: "frame", name: "inner" }], chain: [{ tier: 0, by: "testid", value: "amt" }] },
        {},
      ),
    ).rejects.toThrow(/scope/);
  });
});
