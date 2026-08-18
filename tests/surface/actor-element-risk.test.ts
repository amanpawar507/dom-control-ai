// Container-free, but backed by a real DOM.
//
// tests/surface/actor.test.ts proves what the actor does *once the gate has
// spoken*, with a stub page. This file proves the question one level earlier:
// that the verdict is a function of the element being acted on, and not of the
// label the caller passed alongside it. That claim cannot be made against a stub
// page, because the stub is where a lie about an element would be believed.
//
// No container and no network: a hand-authored fixture is served to an
// allowlisted URL through `page.route`, so the URL the policy judges is a real
// in-allowlist http URL while the bytes come from `tests/fixtures/synthetic/`.
// Interception happens before the network stack, so nothing reaches the target
// even when one is running on that port.
//
// The escalation tests call `act()` — the effecting path, not the probe — and a
// capture-phase click listener in the page is the proof that nothing was
// clicked. "An error was thrown" is satisfied by an actor that clicks and then
// throws; an empty click log is not.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { resolveBinding } from "../../src/surface/playwright-web/resolver.js";
import { PolicyEscalation, WebActor } from "../../src/surface/playwright-web/actor.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import { StubLogger } from "../support/stubs.js";

/**
 * A path the real ParaBank does not serve, under a prefix the allowlist does
 * permit. If the route ever failed to intercept, the fixture would not load and
 * every resolution below would fail loudly rather than silently testing the
 * live target.
 */
const PAGE_URL = "http://localhost:8081/parabank/admin-shapes.htm";
const FIXTURE = "tests/fixtures/synthetic/irreversible.html";

/** The smoke's config, kept identical in the fields these tests turn on. */
const CFG: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  approved: true,
};

let browser: Browser;
let page: Page;

declare global {
  // eslint-disable-next-line no-var
  var __clicks: string[] | undefined;
}

beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const body = readFileSync(FIXTURE, "utf8");
  await ctx.route(PAGE_URL, (route) => route.fulfill({ contentType: "text/html", body }));
  page = await ctx.newPage();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  // A fresh load per test: handles are stamped per document, and a click that
  // did land would leave the page somewhere else.
  await page.goto(PAGE_URL);
  await page.evaluate(() => {
    globalThis.__clicks = [];
    document.addEventListener(
      "click",
      (e) => globalThis.__clicks?.push((e.target as Element).tagName),
      true, // capture: recorded before anything can stop propagation
    );
  });
});

const clicksSeen = (): Promise<string[]> => page.evaluate(() => globalThis.__clicks ?? []);

/** Resolve by css and fail loudly rather than testing against a guessed handle. */
async function handleFor(css: string): Promise<string> {
  const res = await resolveBinding(page, { scope: [], chain: [{ tier: 2, by: "css", value: css }] }, {});
  if (!res.ok) throw new Error(`fixture control ${css} did not resolve: ${res.reason}`);
  return res.handle;
}

const build = (): { log: StubLogger; actor: WebActor } => {
  const log = new StubLogger();
  return { log, actor: new WebActor(page, CFG, log.asLogger()) };
};

const CLEAN_BUTTON = 'form[name="cleanDB"] button[value="CLEAN"]';
const SHUTDOWN_INPUT = 'form[name="toggleJms"] input[type="submit"]';
const INITIALIZE_BUTTON = 'form[name="cleanDB"] button[value="INIT"]';
const ALIASED_BUTTON = "#aliased";

describe("risk is classified from the resolved element", () => {
  it("escalates a click on the irreversible control when the caller supplies no name", async () => {
    const { actor } = build();
    const handle = await handleFor(CLEAN_BUTTON);

    // The C1 reproduction: the caller holds a handle to the button that drops
    // the database and says nothing about it.
    await expect(actor.act({ type: "click", handle }, null)).rejects.toBeInstanceOf(PolicyEscalation);

    expect(await clicksSeen()).toEqual([]);
  });

  it("escalates it even when the caller names a different, harmless control", async () => {
    const { actor } = build();
    const handle = await handleFor(CLEAN_BUTTON);

    // A caller that is wrong rather than silent — the shape Phase 2's discovery
    // loop produces, where the handle comes from an observation and the label
    // comes from somewhere else.
    await expect(
      actor.act({ type: "click", handle }, "Accounts Overview"),
    ).rejects.toBeInstanceOf(PolicyEscalation);

    expect(await clicksSeen()).toEqual([]);
  });

  it("reads an input's name from its value, where the element keeps it", async () => {
    const { actor } = build();
    const handle = await handleFor(SHUTDOWN_INPUT);

    await expect(actor.act({ type: "click", handle }, null)).rejects.toBeInstanceOf(PolicyEscalation);

    expect(await clicksSeen()).toEqual([]);
  });

  it("does not read a button's name from its value attribute", async () => {
    // `<button value="CLEAN">Clean</button>`. A derivation that reached for
    // `value` would compare "CLEAN" against a rule written for "Clean" and let
    // the click through, so this pins which of the two the name comes from.
    const { log, actor } = build();
    const handle = await handleFor(CLEAN_BUTTON);

    await actor.act({ type: "click", handle }, null).catch(() => undefined);

    expect(log.events[0]).toMatchObject({ kind: "gate", controlNames: ["Clean"] });
  });

  it("sees a name the element carries only in aria-label, alongside its text", async () => {
    const { actor } = build();
    const handle = await handleFor(ALIASED_BUTTON);

    // `<button aria-label="Clean">Purge everything</button>`: neither name alone
    // is safe to rely on, so both are put to the rules.
    await expect(actor.act({ type: "click", handle }, null)).rejects.toBeInstanceOf(PolicyEscalation);

    expect(await clicksSeen()).toEqual([]);
  });

  it("still allows a control the rules do not name, so the gate discriminates", async () => {
    // Without this the suite would pass against a gate that escalates
    // everything, which is not a guard but a stoppage.
    const { actor } = build();

    const verdict = await actor.verdictFor({ type: "click", handle: await handleFor(INITIALIZE_BUTTON) }, null);

    expect(verdict.decision).toBe("allow");
  });

  it("lets a caller's label narrow the verdict but never widen it", async () => {
    const { actor } = build();
    const handle = await handleFor(INITIALIZE_BUTTON);

    // The element is "Initialize"; the caller believes it is "Clean". Matching
    // over the set of names means an extra name can only raise the tier, so a
    // caller may be more cautious than the element warrants and never less.
    const verdict = await actor.verdictFor({ type: "click", handle }, "Clean");

    expect(verdict).toMatchObject({ decision: "escalate", risk: "irreversible" });
  });

  it("refuses a mutating action with no handle rather than judging the label alone", async () => {
    const { actor } = build();

    // Nothing to read means nothing to classify. Allowing on the strength of a
    // caller-supplied string is the defect this whole file exists to close, so
    // the unclassifiable case fails closed.
    const verdict = await actor.verdictFor({ type: "click" }, "Accounts Overview");

    expect(verdict.decision).toBe("refuse");
  });

  it("refuses when the handle names no element on the page", async () => {
    const { actor } = build();

    const verdict = await actor.verdictFor({ type: "click", handle: "h-not-stamped" }, "Accounts Overview");

    expect(verdict).toMatchObject({ decision: "refuse" });
    expect((verdict as { reason: string }).reason).toContain("h-not-stamped");
  });
});
