// tests/replay/conditions.test.ts
//
// `page.setContent` keeps this container-free and network-free — the markup
// is inline and `detect` runs against a real browser layout engine because
// visibility (`getComputedStyle`, box area) is not simulable outside one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { detect, SEVEN_CONDITIONS, type ConditionDecl } from "../../src/replay/conditions.js";

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
