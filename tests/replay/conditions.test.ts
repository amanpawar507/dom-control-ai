// tests/replay/conditions.test.ts
//
// `page.setContent` keeps this container-free and network-free — the markup
// is inline and `detect` runs against a real browser layout engine because
// visibility (`getComputedStyle`, box area) is not simulable outside one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { detect, SEVEN_CONDITIONS, type ConditionDecl } from "../../src/replay/conditions.js";

/**
 * A region of the captured markup, lifted out of the fixture file rather than
 * retyped here.
 *
 * Retyping is what let the previous version of the engine's fixture agree with
 * a declaration that disagreed with the target: markup written to match what a
 * row *means* proves only that the row matches itself. This reads the bytes
 * that were captured off the running application, and asserts the region was
 * found — a regex that silently matched nothing would turn every test below
 * into a test of an empty page.
 *
 * The region is served on its own, without the surrounding document. The
 * fixtures reference `template.css` and a bundled jQuery relative to a
 * ParaBank origin they are no longer served from, and this file makes no
 * network calls; the claim under test is about the markup of one region, and
 * the rest of the page has no part in it.
 */
function capturedRegion(fixture: string, id: string): string {
  const html = readFileSync(`tests/fixtures/parabank/${fixture}.html`, "utf8");
  const found = [...html.matchAll(new RegExp(`<div id="${id}"[\\s\\S]*?</div>`, "g"))];
  expect(found, `no region #${id} in ${fixture}.html`).toHaveLength(1);
  return found[0]![0]!;
}

/** The same region with its shipped `display: none` removed, which is what the application's own failure handler does. */
function revealed(region: string): string {
  const shown = region.replace(' style="display: none;"', "");
  expect(shown, "region was not shipped hidden, so revealing it proves nothing").not.toBe(region);
  return shown;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

const notFoundDecl: ConditionDecl = {
  id: "record-not-found",
  class: "business",
  code: "RECORD_NOT_FOUND",
  message: "No such account",
  locate: { tier: 2, by: "css", value: "#err" },
};

describe("detect", () => {
  it("does not fire on a hidden error node", async () => {
    // The target ships these by the dozen. A detector that fires on one reports
    // a business outcome for a page that is displaying nothing of the sort.
    await page.setContent(`<div id="err" style="display:none">Account not found</div>`);
    expect(await detect(page, [notFoundDecl])).toBeNull();
  });

  it("fires when the same node is shown", async () => {
    await page.setContent(`<div id="err">Account not found</div>`);
    const c = await detect(page, [notFoundDecl]);
    expect(c).toMatchObject({ class: "business", code: "RECORD_NOT_FOUND" });
  });

  it("classifies each of the seven declared conditions into its declared class", () => {
    // The mechanism is uniform and only the data differs (§7); this pins that
    // the data is complete rather than that the mechanism works.
    const classes = SEVEN_CONDITIONS.map((c) => c.class);
    expect(classes.filter((c) => c === "business")).toHaveLength(3);
    expect(classes.filter((c) => c === "recoverable")).toHaveLength(4);
  });

  it("reports nothing when no declared condition matches", async () => {
    await page.setContent(`<p>ordinary page, nothing exceptional</p>`);
    expect(await detect(page, [notFoundDecl])).toBeNull();
  });

  it("returns the first declared condition that matches, in declaration order", async () => {
    // Two conditions' landmarks are both on the page; declaration order is
    // the tie-break, not element order or anything else incidental.
    await page.setContent(`
      <div id="err">Account not found</div>
      <p class="error">Invalid amount</p>
    `);
    const validationFirst: ConditionDecl = {
      id: "validation-error",
      class: "business",
      code: "VALIDATION_ERROR",
      message: "bad amount",
      locate: { tier: 2, by: "css", value: ".error" },
    };
    const c = await detect(page, [validationFirst, notFoundDecl]);
    expect(c?.code).toBe("VALIDATION_ERROR");
    const reordered = await detect(page, [notFoundDecl, validationFirst]);
    expect(reordered?.code).toBe("RECORD_NOT_FOUND");
  });

  it("abstains rather than guessing when the declared landmark matches more than one element", async () => {
    // This codebase never takes the first of several. Two rendered nodes both
    // answer the same declared selector, so there is no single element this
    // condition can honestly claim is "the" error — resolveBinding reports
    // ambiguous, and detect treats that the same as not-present rather than
    // picking one.
    await page.setContent(`
      <div class="err">Account not found</div>
      <div class="err">A different message</div>
    `);
    const ambiguousDecl: ConditionDecl = {
      ...notFoundDecl,
      locate: { tier: 2, by: "css", value: ".err" },
    };
    expect(await detect(page, [ambiguousDecl])).toBeNull();
  });

  it("never reports a business outcome for the target's own internal-error banner", async () => {
    // The Critical the final review found, reproduced against the captured
    // markup it was found in. Both of this application's error regions carry
    // the identical `<h1>Error!</h1><p>An internal error has occurred and has
    // been logged.</p>`, and two `business` rows used to be pointed at them:
    // `record-not-found` at `#errorContainer` and `permission-denial` at any
    // heading reading "Error!". A crashed application told its caller "no
    // matching record" — an answer to a question it never answered, and the one
    // failure nothing downstream can distinguish from the truth.
    //
    // Asserted on the class, not only on the id: what must never happen is a
    // *business* verdict off a stack trace, whichever row produces it.
    for (const [fixture, id] of [
      ["findtrans", "errorContainer"],
      ["transfer", "showError"],
    ] as const) {
      const region = revealed(capturedRegion(fixture, id));
      await page.setContent(region);
      const c = await detect(page, SEVEN_CONDITIONS);
      expect(c?.class, `${fixture}.html #${id} was classified ${c?.class}`).not.toBe("business");
      expect(c).toMatchObject({ id: "application-error", class: "recoverable", code: "APPLICATION_ERROR" });

      // The same banner with the region's own id taken away — which is all a
      // caller has if the application renames it. `permission-denial` used to
      // be keyed on the heading inside, `Error!`, which is the generic title of
      // both regions and of nothing else in particular. Ordering alone does not
      // save this case: with no `#error`-family id left, the fault row does not
      // match, so a heading-keyed business row would be the only row that did
      // and would answer a 500 with "the account is not permitted".
      const inner = region.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
      expect(inner, "the wrapper was not stripped").not.toContain("<div");
      await page.setContent(inner);
      expect(await detect(page, SEVEN_CONDITIONS)).toBeNull();
    }
  });

  it("prefers a fault over an answer when both are on the page, whatever the declaration order", async () => {
    // The other half of the same Critical: even a correctly-aimed business
    // landmark must not outrank a fault, because `detect` stops at the first
    // row that matches and every business row in §7's table is declared ahead
    // of `application-error`. Declaration order is the tie-break between rows
    // of equal standing; a claim that the call succeeded does not have equal
    // standing with evidence that it did not.
    await page.setContent(`
      <div id="answer">No matching record</div>
      <div id="fault">Error! An internal error has occurred and has been logged.</div>
    `);
    const answer: ConditionDecl = { ...notFoundDecl, locate: { tier: 2, by: "css", value: "#answer" } };
    const fault: ConditionDecl = {
      id: "application-error",
      class: "recoverable",
      code: "APPLICATION_ERROR",
      message: "internal error",
      locate: { tier: 2, by: "css", value: "#fault" },
    };
    expect((await detect(page, [answer, fault]))?.code).toBe("APPLICATION_ERROR");
    expect((await detect(page, [fault, answer]))?.code).toBe("APPLICATION_ERROR");

    // And the fault genuinely has to be on the page for it to win — otherwise
    // this test would pass against a detector that had simply stopped
    // reporting business outcomes at all.
    await page.setContent(`<div id="answer">No matching record</div>`);
    expect((await detect(page, [answer, fault]))?.code).toBe("RECORD_NOT_FOUND");
  });

  it("does not read the empty-result region as an answer while the page is still loading it", async () => {
    // `#noTransactions` ships *visible* on this target and stays visible until
    // the first XHR returns, so a landmark keyed on it alone fires during the
    // load of a perfectly ordinary page — the run would report "no records"
    // before it had asked anything. The declared selector requires the
    // transaction table to have been hidden as well, which only the empty
    // branch does.
    const row = SEVEN_CONDITIONS.find((c) => c.id === "record-not-found");
    expect(row?.locate).toBeDefined();

    await page.setContent(`
      <div id="accountActivity">
        <table id="transactionTable"><tbody></tbody></table>
        <p id="noTransactions">No transactions found.</p>
      </div>`);
    expect(await detect(page, SEVEN_CONDITIONS)).toBeNull();

    await page.setContent(`
      <div id="accountActivity">
        <table id="transactionTable" style="display: none"><tbody></tbody></table>
        <p id="noTransactions">No transactions found.</p>
      </div>`);
    expect(await detect(page, SEVEN_CONDITIONS)).toMatchObject({ code: "RECORD_NOT_FOUND", class: "business" });
  });

  it("skips a declared condition with no landmark to look for", async () => {
    // transient-slowness in SEVEN_CONDITIONS carries no `locate` — its signal
    // is a checkpoint's own wait budget expiring, not a node on the page. A
    // detector asked to find it must not silently fire on the next declared
    // condition's landmark, and must not throw either.
    const noLocate = SEVEN_CONDITIONS.find((c) => c.id === "transient-slowness");
    expect(noLocate).toBeDefined();
    await page.setContent(`<p>nothing here</p>`);
    if (noLocate) expect(await detect(page, [noLocate])).toBeNull();
  });
});
