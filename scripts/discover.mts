// The one entry point in this project that spends money.
//
//   npm run discover -- --goal "..." --max-steps 12 --budget 1.00
//
// It is a script and not a test on purpose: `npm test` must stay
// container-free and free of network calls, and a suite that called a paid
// API would cost money every time anyone ran it and would fail whenever a
// third party was down. The single exchange this script performs is captured
// by `recordCassette` into a replayable artifact, so the wire shape it proves
// is guarded from then on at no cost (src/discover/cassette.ts).
//
// It never touches ParaBank's admin console. `Clean` and `Shutdown` there drop
// the fixture database every later phase depends on; the policy below
// classifies them irreversible so the gate escalates rather than clicking, and
// the run finishes by re-reading the seed account to show the database is
// still the one every other test expects.
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { AnthropicDriver, DISCOVERY_MODEL } from "../src/discover/anthropic.js";
import { Budget, BudgetExceeded } from "../src/discover/budget.js";
import { recordCassette } from "../src/discover/cassette.js";
import { discover } from "../src/discover/loop.js";
import { saveArtifact } from "../src/artifact/store.js";
import { RunLogger } from "../src/evidence/logger.js";
import type { PolicyConfig } from "../src/policy/gate.js";
import { ParabankSessionProvider } from "../src/session/playwright-state.js";

const { values } = parseArgs({
  options: {
    goal: { type: "string" },
    id: { type: "string" },
    "max-steps": { type: "string", default: "12" },
    budget: { type: "string", default: "1.00" },
    model: { type: "string", default: DISCOVERY_MODEL },
    base: { type: "string", default: "http://localhost:8081/parabank" },
    entry: { type: "string" },
    /**
     * Where to record this run's exchange. No default, deliberately.
     *
     * It had one — the path of the cassette a previous run recorded — and two
     * failed runs silently overwrote it, replacing a committed evidence
     * artifact with a dead end. Nothing complained: the file is valid, the
     * tests that read it are the only thing that noticed, and they noticed a
     * commit later.
     *
     * A recording destination is a decision about which file to write, and a
     * default that names an existing recording answers it wrongly by omission.
     * Omit this and the run keeps its exchange in the evidence directory with
     * the rest of its trail, where nothing is at risk.
     */
    cassette: { type: "string" },
    video: { type: "string" },
    approve: { type: "boolean", default: false },
  },
});

if (values.goal === undefined || values.goal.trim() === "") {
  throw new Error("--goal is required: this run drives a model, and a model with no goal spends money for nothing");
}

/**
 * Required, and deliberately not derived from `--goal`.
 *
 * The id was `slug(goal).slice(0, 48)`, which made the capability's identity —
 * and therefore its path in the store — a function of prose. Three materially
 * different goals all beginning "Record the first account number listed in the
 * ac…" truncate to one id, `version` is hardcoded to 1, and `saveArtifact`
 * overwrites a draft by design, so the second recording silently destroyed the
 * first. Naming the capability is a decision about identity ("is this a new
 * version of that capability, or a different one?") and no sentence of prose
 * answers it. See `DiscoverOptions.capabilityId`.
 */
if (values.id === undefined || values.id.trim() === "") {
  throw new Error(
    "--id is required: it names the capability this run records and the directory it is stored under. " +
      'Reuse the id to record a new version of an existing capability (e.g. --id "account-activity-debits").',
  );
}

/**
 * Passed in, never defaulted. The client would happily read the environment
 * itself, but then a run with no key configured would fail somewhere inside
 * the SDK instead of here, and `AnthropicDriver` could not promise that the
 * key reaches it from exactly one place.
 */
const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
if (apiKey.trim() === "") {
  throw new Error("ANTHROPIC_API_KEY is not set (put it in .env — `npm run discover` loads that file)");
}

const BASE = values.base;
const GOAL = values.goal;
const MAX_STEPS = Number(values["max-steps"]);
const CEILING_USD = Number(values.budget);
const ENTRY = values.entry ?? `${BASE}/overview.htm`;

if (!Number.isFinite(MAX_STEPS) || MAX_STEPS <= 0) throw new Error(`--max-steps must be a positive number`);
if (!Number.isFinite(CEILING_USD) || CEILING_USD <= 0) throw new Error(`--budget must be a positive number of dollars`);

/**
 * Claude Sonnet 5 introductory pricing, in effect through 2026-08-31. It is a
 * constructor argument to `Budget` rather than a constant inside it precisely
 * so this line is the only thing that changes when the rate does.
 */
const RATE = { inPerM: 2, outPerM: 10 } as const;

/** Pinned for the same reason Phase 1 pinned it: tier 3 compares rendered rectangles. */
const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * What the model is allowed to do, and what it is stopped from doing.
 *
 * `approved: false` is the load-bearing half of the risk rules below: a
 * `guarded` control is refused outright unless the capability has already been
 * approved by a human, and nothing recorded by discovery has been. So the
 * money-moving controls ParaBank puts in the navigation of every authenticated
 * page — Transfer Funds, Bill Pay, Request Loan, Open New Account — are
 * refused if the model wanders onto one, and the run ends rather than
 * transferring fixture money about.
 *
 * `Clean` and `Shutdown` are `irreversible` and escalate instead: they drop
 * the fixture database, which is not a thing to merely refuse quietly.
 * `Admin Page` is in the same class because it is the door to both and is
 * linked from every page on the site.
 */
const POLICY: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [
    { tier: "irreversible", matchControl: "^(Clean|Shutdown|Admin Page)$" },
    /**
     * The controls that commit the act, not the links that lead to it.
     *
     * This rule exists because the first version did not have it, and a live
     * run moved real fixture money through a gate that returned `allow/safe`
     * on every step. The guarded list named `Bill Pay`, `Transfer Funds` and
     * their siblings — which are the *navigation links* in the menu. The
     * button that actually sends the payment is called `Send Payment`, matched
     * nothing, and was classified safe.
     *
     * So the policy guarded the doorway and not the act. Anything entering the
     * page by another route — a recorded capability whose `entryUrl` is the
     * form itself, which is exactly what a replay does — never touches the
     * link and never meets the rule. The submit control is the only place the
     * money actually moves, and it is the thing worth naming.
     *
     * The navigation rule below stays. Refusing the doorway is still useful:
     * it stops a wandering discovery run from arriving somewhere expensive by
     * accident, which is a different job from stopping the act itself.
     */
    {
      tier: "guarded",
      matchControl: "^(Send Payment|Transfer|Apply Now|Open New Account|Update Profile|Send to Payee)$",
    },
    {
      tier: "guarded",
      matchControl: "^(Transfer Funds|Bill Pay|Request Loan|Open New Account|Update Contact Info|Log Out)$",
    },
  ],
  /**
   * Withheld by default, and `--approve` grants it for one run only.
   *
   * `guarded` controls — the money-moving ones this target puts in the
   * navigation of every authenticated page — are refused unless a capability
   * has been approved by a human. Recording one therefore requires saying so
   * at the command line, which is the point: the grant is a decision somebody
   * makes, visible in the invocation, rather than a default nobody revisits.
   *
   * It does not weaken the two rules that matter. `irreversible` still
   * escalates regardless of approval, so `Clean` and `Shutdown` remain
   * unreachable. And the artifact is still recorded `status: "draft"` — a
   * recorder that marked its own output approved would be granting itself the
   * permission this flag exists to withhold.
   */
  approved: values.approve === true,
};

/**
 * The allowlist as the model is told it, which is deliberately not the same
 * object the gate enforces. The gate is the authority; this is a sentence in
 * a prompt. Deriving the sentence from the config keeps the two from drifting
 * into saying different things, while leaving no doubt about which one decides.
 */
const ALLOWLIST_FOR_PROMPT = POLICY.allowlist.origins.flatMap((origin) =>
  POLICY.allowlist.paths.map((path) => `${origin}${path}`),
);

const runId = `discover-${Date.now()}`;
const log = new RunLogger(runId);

/**
 * Capabilities never authenticate (spec §5). The provider is the only module
 * that ever sees a credential; what comes back is a storage state — a session
 * cookie and nothing else — and that is what the browser this run drives is
 * built from. The discovery loop therefore starts already logged in, and no
 * password is ever typed by the model, put in a prompt, or written to the
 * cassette.
 */
const session = await new ParabankSessionProvider(BASE).acquire("parabank", "local");

const browser = await chromium.launch();
/**
 * `--video <dir>` records the run to a webm. Off by default: it costs a little
 * time and disk on every run, and the evidence log is the artifact that
 * matters for auditing. It is worth having anyway, because a JSONL trail tells
 * you which control the model chose and a recording tells you what the page
 * looked like when it chose it — and when a run goes wrong those are different
 * questions.
 */
const context = await browser.newContext({
  viewport: VIEWPORT,
  storageState: JSON.parse(session.storageState),
  ...(values.video === undefined ? {} : { recordVideo: { dir: values.video, size: VIEWPORT } }),
});
const page = await context.newPage();
await page.goto(ENTRY);
// A condition with an explicit budget, never a sleep. ParaBank fills the
// accounts table after load, and the first observation is taken before the
// loop's own settle ever runs — without this the model's first snapshot would
// be missing every account link on the page it starts from.
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

/**
 * Two `Budget` objects, one ceiling.
 *
 * They cannot be the same object: `AnthropicDriver` charges from each
 * response's usage before returning a turn, and `discover()` charges the delta
 * of `driver.usage()` after it — one shared instance would bill every turn
 * twice, binding at half the stated ceiling and reporting double the spend.
 * Two instances at the same limit are each charged exactly once from the same
 * token counts, so they must agree at the end; the check below is what makes
 * that "must" observable rather than assumed.
 */
const driverBudget = new Budget(CEILING_USD, RATE);
const loopBudget = new Budget(CEILING_USD, RATE);

const live = new AnthropicDriver({
  apiKey,
  model: values.model,
  budget: driverBudget,
  goal: GOAL,
  allowlist: ALLOWLIST_FOR_PROMPT,
});

// Absent `--cassette`, the exchange is kept beside the run's own evidence,
// where it cannot overwrite a recording somebody committed on purpose.
const cassettePath = values.cassette ?? join(dirname(log.path()), "exchange.json");
mkdirSync(dirname(cassettePath), { recursive: true });
/**
 * Every exchange this run pays for is written to disk as it happens, so a
 * single expenditure becomes a permanent replayable fixture rather than a
 * one-off. The recorder scrubs `fill`/`select` values structurally and runs
 * `redactDeep` over the whole record before writing (src/discover/cassette.ts).
 */
const driver = recordCassette(cassettePath, live);

console.log(`goal:      ${GOAL}`);
console.log(`id:        ${values.id}`);
console.log(`model:     ${values.model}`);
console.log(`entry:     ${ENTRY}`);
console.log(`ceiling:   $${CEILING_USD.toFixed(2)} at $${RATE.inPerM}/1M in, $${RATE.outPerM}/1M out`);
console.log(`max steps: ${MAX_STEPS}`);
console.log(`cassette:  ${cassettePath}`);
console.log(`evidence:  ${log.path()}`);
console.log("");

let result: Awaited<ReturnType<typeof discover>> | null = null;
let failure: unknown = null;
try {
  result = await discover({
    page,
    goal: GOAL,
    capabilityId: values.id,
    driver,
    policy: POLICY,
    log,
    budget: loopBudget,
    maxSteps: MAX_STEPS,
    product: "parabank",
    tenant: "local",
    variant: "baseline",
  });
} catch (thrown) {
  // Reported rather than rethrown here, so that the accounting below always
  // runs: a run that died still spent money, and the number it spent is the
  // one thing that must not be lost with the stack trace.
  failure = thrown;
}

const used = driver.usage();
console.log("--- usage as the API reported it ---");
console.log(`input tokens:  ${used.inputTokens}`);
console.log(`output tokens: ${used.outputTokens}`);
console.log(`spend (driver's budget): $${driverBudget.spentUsd().toFixed(6)}`);
console.log(`spend (loop's budget):   $${loopBudget.spentUsd().toFixed(6)}`);
if (Math.abs(driverBudget.spentUsd() - loopBudget.spentUsd()) > 1e-9) {
  console.log("WARNING: the two budgets disagree — one of them is not being charged from the same usage");
}

if (failure !== null) {
  console.log("");
  console.log(
    failure instanceof BudgetExceeded
      ? `--- halted: the ceiling was reached --- ${failure.message}`
      : `--- halted: ${(failure as Error).name}: ${(failure as Error).message}`,
  );
} else if (result !== null) {
  console.log("");
  if (result.status === "recorded") {
    // Two writes, for two different readers, and the distinction matters.
    //
    // The evidence copy belongs to this run: it sits beside the JSONL trail so
    // an auditor can see what was produced by the run they are reading, and it
    // lives in a gitignored directory because unreviewed run output is a leak
    // vector.
    //
    // The store copy is the deliverable. The design's claim is that the
    // artifact is the product, and a product written only into scratch does
    // not survive a `git clean`, cannot be diffed in review, and gives the
    // replay engine nothing to load. `saveArtifact` refuses to overwrite a
    // version already approved.
    const runCopy = join(dirname(log.path()), "artifact.json");
    writeFileSync(runCopy, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
    const stored = saveArtifact(process.cwd(), result.artifact);
    console.log(`--- recorded a capability in ${result.steps} step(s) ---`);
    console.log(`    store    ${stored}`);
    console.log(`    run copy ${runCopy}`);
    console.log(JSON.stringify(result.artifact, null, 2));
  } else {
    console.log(`--- escalated after ${result.steps} step(s): ${result.reason} ---`);
  }
}

// The fixture database every later phase depends on. Checked here rather than
// asserted about in prose: a run that had reached `Clean` would leave this
// account gone or reset, so reading the exact seeded value back is what makes
// "we never went near admin" falsifiable.
const seed = await fetch(`${BASE}/services/bank/accounts/12345`).then((r) => r.text());
console.log("");
console.log(
  seed.includes("<balance>-2300.00</balance>")
    ? "seed account 12345: intact (-2300.00)"
    : `seed account 12345: CHANGED — ${seed.slice(0, 200)}`,
);

await browser.close();

if (failure !== null) throw failure;
