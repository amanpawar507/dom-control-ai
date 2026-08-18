// Container-dependent: drives the live ParaBank target, so this lives under
// tests/e2e (npm run test:e2e) and is excluded from `npm test`.
//
// Still no model. The script is hand-written, replayed by `ScriptedDriver`
// through `HandleScript`, and `driver.usage()` is asserted to be zero at the
// end — this run costs nothing, which is the whole reason it can exist at all
// on a $5 budget. What it adds over `tests/discover/loop.test.ts` is the
// surface: real ParaBank markup, unmarked by any `data-testid`, where
// `proveControl` has to earn a binding from role, geometry or structure rather
// than being handed one.
//
// What this run deliberately does NOT touch: `admin.htm`. The `Clean` and
// `Shutdown` controls there drop the fixture database that every later phase
// depends on, and the way to test a guard is not to fire the thing it guards.
// The gate's refusal of an irreversible control is proved container-free in
// tests/discover/loop.test.ts and tests/surface/actor.test.ts.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { discover, type DiscoveryResult } from "../../src/discover/loop.js";
import { Budget } from "../../src/discover/budget.js";
import { RunLogger } from "../../src/evidence/logger.js";
import { parseArtifact } from "../../src/artifact/schema.js";
import { resolveBinding } from "../../src/surface/playwright-web/resolver.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import type { Binding } from "../../src/surface/types.js";
import { HandleScript } from "../support/stubs.js";

const BASE = "http://localhost:8081/parabank";

/** Pinned for the same reason Phase 1 pinned it: tier 3 compares rendered rectangles. */
const VIEWPORT = { width: 1280, height: 800 } as const;

const CFG: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  sensitiveControls: ["SSN:", "Password:"],
  approved: true,
};

const GOAL = "open the customer care page and note where the admin page is";

/**
 * The flow, written the way a model would have to write it: by what a control
 * is called, never by where it sits in the markup.
 *
 * Every name here is unique on the page the turn observes — checked against
 * the live container while writing this, and enforced at run time by
 * `HandleScript`, which refuses a name matching anything other than exactly
 * one node. ParaBank repeats most of its navigation in a second menu
 * ("About Us", "Products", "Services" and "Locations" all appear twice on
 * every page), so the unique ones are the only ones a hand-written script can
 * address at all.
 */
const SCRIPT = [
  [{ name: "navigate", input: { url: `${BASE}/index.htm` } }],
  [{ name: "click", input: { handle: "@Contact Us" } }],
  [{ name: "extract", input: { handle: "@Admin Page", as: "admin_link" } }],
  [{ name: "done", input: { checkpoint: "@Send to Customer Care" } }],
];

let browser: Browser;
let page: Page;
let driver: HandleScript;
let budget: Budget;
let logPath: string;
let result!: DiscoveryResult;

beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  page = await ctx.newPage();

  driver = new HandleScript(SCRIPT);
  budget = new Budget(1, { inPerM: 2, outPerM: 10 });
  const log = new RunLogger(`discover-e2e-${Date.now()}`);
  logPath = log.path();

  result = await discover({
    page,
    goal: GOAL,
    // Supplied, not derived from the goal: a truncated goal slug collides
    // across materially different goals and the later run overwrites the
    // earlier one. See `DiscoverOptions.capabilityId`.
    capabilityId: "customer-care-page",
    driver,
    policy: CFG,
    log,
    budget,
    product: "parabank",
    tenant: "local",
    variant: "baseline",
  });
}, 180_000);

afterAll(async () => {
  await browser.close();
});

describe("discovery against the live ParaBank target", () => {
  it("records an artifact, driven by a script, with no model in the loop", () => {
    expect(result).toMatchObject({ status: "recorded", steps: SCRIPT.length });
    // Zero, permanently: `ScriptedDriver` never talks to a model, so this run
    // cost nothing. If a live driver were ever wired in here by accident, this
    // is the assertion that notices.
    expect(driver.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(budget.spentUsd()).toBe(0);
  });

  it("emits a flow whose every step names a control the artifact binds", () => {
    if (result.status !== "recorded") throw new Error("no artifact was recorded");
    const { flow, bindings } = result.artifact;

    // One click, one extract, one checkpoint. The opening `navigate` is not a
    // flow step: spec §6 makes the entry URL part of the *target* a capability
    // is invoked against, not part of the logic that is shared across tenants.
    // It is not dropped either — it is where `bindings.entryUrl` comes from,
    // asserted below.
    expect(flow.steps.map((s) => s.kind)).toEqual(["act", "extract", "checkpoint"]);
    for (const step of flow.steps) {
      if ("control" in step) expect(Object.keys(bindings.controls)).toContain(step.control);
    }
    expect(flow.steps.at(-1)).toMatchObject({ kind: "checkpoint" });
  });

  it("records the address the run actually began at, not the page it was created on", () => {
    if (result.status !== "recorded") throw new Error("no artifact was recorded");

    // The run's opening move is a `navigate`, and a fresh Playwright page is
    // on `about:blank` until it lands. Reading `page.url()` before the first
    // turn therefore recorded `about:blank` as the entry — accepted by
    // `z.string().url()`, asserted by nothing, and committed: the artifact in
    // `evidence/discover-e2e-1786949218818/run.jsonl` tells a replay engine to
    // start at `about:blank` and then resolve three bindings for pages under
    // `/parabank/`. Every assertion in this file passed over it.
    expect(result.artifact.bindings.entryUrl).toBe(`${BASE}/index.htm`);
  });

  it("proves every binding against the real surface, not a fixture with test ids", async () => {
    if (result.status !== "recorded") throw new Error("no artifact was recorded");
    const { controls } = result.artifact.bindings;

    // ParaBank ships no `data-testid` anywhere, so nothing here can have been
    // proven at tier 0. Every chain had to be earned from role, geometry or
    // structure — which is the point of running this against the container at
    // all rather than against markup written to be easy.
    for (const [name, binding] of Object.entries(controls)) {
      expect(binding.chain.length, `${name} has an empty chain`).toBeGreaterThan(0);
      for (const strategy of binding.chain) {
        expect(strategy.tier, `${name} was proven by a test id ParaBank does not ship`).not.toBe(0);
        // Tier 4 is unrepresentable in the schema; this pins the live values too.
        expect(strategy.tier).toBeLessThanOrEqual(3);
      }
    }

    // And each one resolves, right now, on the page the run finished on —
    // which is what "replayable with no model in the loop" has to mean.
    for (const [name, binding] of Object.entries(controls)) {
      // Discovery records a `tag` fingerprint and deliberately nothing else,
      // so spec §7's third resolution rule — "fingerprint and stability must
      // both hold" — is something the artifact actually carries rather than a
      // rule that holds because no artifact ever tested it. `matches` stays
      // absent on purpose: a format class inferred from one observed value is
      // always consistent with that value, looks right at record time, and
      // fails on the first legitimate variation (Phase 1 shipped exactly that
      // — an inferred currency fingerprint that rejected negative balances).
      // Both halves are asserted, so neither a dropped fingerprint nor a
      // guessed one can arrive unnoticed.
      expect(binding.fingerprint?.tag, `${name} carries no fingerprint`).toBeTruthy();
      expect(binding.fingerprint?.matches, `${name} carries a value shape discovery cannot have proven`).toBeUndefined();
      const probe: Binding = { scope: binding.scope, chain: binding.chain };
      const res = await resolveBinding(page, probe, {});
      expect(res.ok, `${name} did not resolve: ${JSON.stringify(res)}`).toBe(true);
    }
  });

  it("survives a round trip through its own schema", () => {
    if (result.status !== "recorded") throw new Error("no artifact was recorded");
    // Artifacts are stored as JSON on disk (§4) and read back as `unknown`.
    // An artifact that cannot make that trip is not a recording, whatever it
    // looks like in memory.
    const roundTripped = parseArtifact(JSON.parse(JSON.stringify(result.artifact)));
    expect(roundTripped).toEqual(result.artifact);

    expect(roundTripped.capability).toMatchObject({
      product: "parabank",
      goal: GOAL,
      status: "draft",
      outputs: { admin_link: { type: "string" } },
    });
    expect(roundTripped.bindings).toMatchObject({ tenant: "local", variant: "baseline" });
  });

  it("writes evidence that carries no session token in any form", () => {
    const evidence = readFileSync(logPath, "utf8");
    expect(evidence).toMatch(/discover\.recorded/);
    // ParaBank puts `;jsessionid=…` in every href it renders, so this is a
    // live hazard rather than a hypothetical one. The redactor at the log sink
    // is what keeps it out; this asserts the outcome, not the mechanism.
    expect(evidence).not.toMatch(/;jsessionid=(?!<redacted>)/i);
    expect(evidence).not.toMatch(/JSESSIONID["'\s]*[:=]\s*["']?[A-Za-z0-9]{8}/i);
  });

  it("leaves the seed account untouched, because it never went near admin", async () => {
    // The fixture database every later phase depends on. `Clean` and
    // `Shutdown` live on admin.htm and this run has no reason to be there;
    // this asserts it stayed away, by checking the thing that would change.
    const response = await page.goto(`${BASE}/services/bank/accounts/12345`);
    expect(response?.status()).toBe(200);
    // The exact seeded value. A run that had reached Clean would leave this
    // account gone or reset, so pinning the number is what makes the claim
    // falsifiable rather than decorative.
    expect(await response?.text()).toContain("<balance>-2300.00</balance>");
  });
});
