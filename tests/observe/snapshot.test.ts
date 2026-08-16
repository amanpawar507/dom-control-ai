import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { observe, OBS_ATTR } from "../../src/observe/snapshot.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pathToFileURL(resolve("tests/fixtures/parabank/login.html")).href);
});
afterAll(async () => {
  await browser.close();
});

describe("observe", () => {
  it("returns the two login inputs as editable nodes", async () => {
    const obs = await observe(page);
    const editable = obs.nodes.filter((n) => n.editable);
    expect(editable.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every node an opaque handle that is not a selector", async () => {
    const obs = await observe(page);
    for (const n of obs.nodes) {
      expect(n.handle).toMatch(/^o\d+n\d+$/);
    }
  });

  it("invalidates a handle from a previous observation instead of re-pointing it", async () => {
    // The property: a stale handle must FAIL, not silently resolve to whatever
    // now occupies that index. Both halves of the mechanism are needed —
    // clearing old stamps, and qualifying handles with the observation epoch —
    // so this asserts the observable consequence rather than either mechanism.
    const first = await observe(page);
    const stale = first.nodes[0]!.handle;
    expect(await page.locator(`[${OBS_ATTR}="${stale}"]`).count()).toBe(1);

    const second = await observe(page);
    expect(second.nodes[0]!.handle).not.toBe(stale);
    expect(await page.locator(`[${OBS_ATTR}="${stale}"]`).count()).toBe(0);
  });

  it("strips the stamp from an element that stops being observable", async () => {
    // The case the epoch alone would miss: an element observed last turn that
    // is hidden this turn is skipped by the walk, so nothing overwrites its
    // attribute. Without the clearing pass it keeps a handle that still
    // resolves — a stale token pointing at a real, hidden element.
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "vanishing";
      b.textContent = "VanishingControl";
      document.body.appendChild(b);
    });
    const before = await observe(page);
    const doomed = before.nodes.find((n) => n.name === "VanishingControl")!.handle;
    expect(await page.locator(`[${OBS_ATTR}="${doomed}"]`).count()).toBe(1);

    await page.evaluate(() => {
      document.querySelector("#vanishing")!.setAttribute("style", "display:none");
    });
    await observe(page);
    expect(await page.locator(`[${OBS_ATTR}="${doomed}"]`).count()).toBe(0);
  });

  /**
   * The brief this test was drafted from asserted the node payload contains
   * none of `["#", "input[", "customer.", "class=", "<"]`. That is too blunt:
   * `#` occurs in legitimate accessible names — ParaBank's own live
   * `register.htm` carries the label "Phone #:" (confirmed against the
   * running instance while implementing this task) — so a bare substring
   * check on `#` either fails on real content the moment the test is
   * repointed at a page that has it, or invites "fixing" it by stripping `#`
   * out of accessible names, which would corrupt the very observation the
   * model reads and make the control it names unfindable.
   *
   * What must actually hold is narrower than "no `#` anywhere": no
   * *selector-shaped* fragment anywhere. An id selector is `#` immediately
   * followed by an identifier character; an attribute selector opens with
   * `[name=`; a raw tag reference opens with `<letter`. Ordinary text with a
   * `#` in it — "Phone #:", "account #12345" — matches none of these, so it
   * passes through untouched while an actual locator does not.
   */
  it("leaks no selector-shaped locator anywhere in the payload", async () => {
    const obs = await observe(page);
    const blob = JSON.stringify(obs.nodes);
    const SELECTOR_SHAPES: RegExp[] = [
      /#[A-Za-z_][\w-]*/, // id selector: #username, #loginPanel
      /\[[a-zA-Z_-]+=/, // attribute selector: [name=, [data-testid=
      /<[a-zA-Z]/, // raw tag: <input, <div
    ];
    for (const shape of SELECTOR_SHAPES) {
      expect(blob).not.toMatch(shape);
    }
  });

  it("preserves an accessible name containing '#' as ordinary text", async () => {
    // The positive half of the test above: a name that legitimately contains
    // '#' must survive the snapshot unmangled, on a fresh page so this
    // doesn't disturb the shared `page` fixture the other cases rely on.
    const scratch = await browser.newPage();
    try {
      await scratch.setContent(`
        <label for="phone">Phone #:</label>
        <input id="phone" name="phone">
      `);
      const obs = await observe(scratch);
      expect(obs.nodes.map((n) => n.name)).toContain("Phone #:");
    } finally {
      await scratch.close();
    }
  });

  it("omits a hidden node", async () => {
    await page.evaluate(() => {
      const d = document.createElement("button");
      d.textContent = "SecretlyHiddenControl";
      d.style.display = "none";
      document.body.appendChild(d);
    });
    const obs = await observe(page);
    expect(obs.nodes.some((n) => n.name.includes("SecretlyHiddenControl"))).toBe(false);
  });

  it("omits the screenshot unless asked, because images dominate token cost", async () => {
    expect((await observe(page)).screenshot).toBeNull();
    expect((await observe(page, { screenshot: true })).screenshot).toBeTypeOf("string");
  });
});
