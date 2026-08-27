import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { isRenderedIn } from "../../src/observe/visibility.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`
    <div id="shown">visible</div>
    <div id="dnone" style="display:none">hidden by display</div>
    <div id="vhidden" style="visibility:hidden">hidden by visibility</div>
    <div id="opacity" style="opacity:0">hidden by opacity</div>
    <div id="zero" style="width:0;height:0;overflow:hidden">zero area</div>
    <div id="offscreen" style="position:absolute;left:-9999px">offscreen</div>
  `);
});
afterAll(async () => { await browser.close(); });

const check = (id: string) =>
  page.locator(`#${id}`).evaluate(isRenderedIn);

describe("isRenderedIn", () => {
  it("accepts a plainly visible element", async () => {
    expect(await check("shown")).toBe(true);
  });

  it.each([
    ["dnone", "display:none"],
    ["vhidden", "visibility:hidden"],
    ["opacity", "opacity:0"],
    ["zero", "zero area"],
  ])("rejects %s (%s)", async (id) => {
    expect(await check(id)).toBe(false);
  });

  it("accepts an offscreen element, which is rendered but scrolled away", async () => {
    // Deliberate: offscreen is not the same as hidden. A control below the
    // fold is real and clickable after scrolling; treating it as hidden
    // would make long forms undiscoverable.
    expect(await check("offscreen")).toBe(true);
  });
});
