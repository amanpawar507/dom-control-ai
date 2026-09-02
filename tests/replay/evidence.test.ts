// tests/replay/evidence.test.ts
//
// Task 7: the evidence a replay leaves behind, not the engine's control flow —
// that is `engine.test.ts`'s job. This file asks a narrower question: given
// only what `RunLogger` wrote to disk, can the run be read back as a story,
// and does that story ever contain a value it must not?
//
// Container-free and network-free for the same reason as `engine.test.ts`:
// every page here is served by a Playwright route handler over the reserved,
// unresolvable `http://fixtures.test` origin.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { replay } from "../../src/replay/engine.js";
import { parseArtifact, type CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/logger.js";
import type { PolicyConfig } from "../../src/policy/gate.js";

const ORIGIN = "http://fixtures.test";
const EVIDENCE_DIR = "tests/.tmp-replay-evidence-tests";

let browser: Browser;
let context: BrowserContext;
let page: Page;

const PAGES = new Map<string, string>();

const FIND_PAGE = `<!doctype html>
<html><body>
  <h1>Find account</h1>
  <label for="acct">Account</label>
  <input id="acct" data-testid="acct" name="accountId">
  <button id="find" type="button">Find</button>
  <button id="print" type="button">Print</button>
  <div id="errorContainer" style="display:none">
    <h1 class="title">Error!</h1>
    <p class="error">An internal error has occurred and has been logged.</p>
  </div>
  <div id="result" style="display:none"><span id="balance">-2300.00</span></div>
  <script>
    document.getElementById('find').addEventListener('click', function () {
      var v = document.getElementById('acct').value;
      if (v === '12345') { document.getElementById('result').style.display = 'block'; }
      else { document.getElementById('errorContainer').style.display = 'block'; }
    });
    document.getElementById('print').addEventListener('click', function () {
      var s = document.createElement('span');
      s.id = 'printed';
      s.textContent = 'printed';
      document.body.appendChild(s);
    });
  </script>
</body></html>`;

/** The Find button is gone — the one control this flow cannot resolve. */
const NO_FIND_PAGE = `<!doctype html>
<html><body>
  <input id="acct" data-testid="acct" name="accountId">
  <button id="print" type="button">Print</button>
</body></html>`;

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = PAGES.get(path);
    if (body === undefined) {
      await route.fulfill({ status: 404, contentType: "text/html", body: "<h1>404</h1>" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
});

afterAll(async () => {
  await browser.close();
  if (existsSync(EVIDENCE_DIR)) rmSync(EVIDENCE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  PAGES.clear();
  PAGES.set("/app/find.htm", FIND_PAGE);
});

const ALLOWED_ACTIONS = ["click", "fill", "select", "navigate", "extract"] as const;

function policyWith(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    allowlist: { origins: [ORIGIN], paths: ["/app/**"], actions: [...ALLOWED_ACTIONS] },
    riskRules: [],
    approved: true,
    ...over,
  };
}

function findArtifact(over: { entryUrl?: string } = {}): CapabilityArtifact {
  return parseArtifact({
    capability: {
      id: "find-account",
      product: "fixtures",
      version: 1,
      goal: "look up an account and read its balance",
      inputs: { account: { type: "string" } },
      outputs: { balance: { type: "string" } },
      status: "approved",
    },
    flow: {
      steps: [
        { kind: "act", action: "fill", control: "account_input", value: "$account" },
        { kind: "act", action: "click", control: "find_button" },
        { kind: "act", action: "click", control: "print_button" },
        { kind: "checkpoint", control: "result_panel", state: "visible" },
        { kind: "extract", control: "result_balance", as: "balance" },
      ],
    },
    bindings: {
      tenant: "local",
      variant: "baseline",
      entryUrl: over.entryUrl ?? `${ORIGIN}/app/find.htm`,
      controls: {
        account_input: {
          scope: [],
          chain: [
            { tier: 0, by: "testid", value: "acct" },
            { tier: 2, by: "css", value: 'input[name="accountId"]' },
          ],
          fingerprint: { tag: "input" },
        },
        find_button: {
          scope: [],
          chain: [
            { tier: 1, by: "role", role: "button", name: "Find" },
            { tier: 2, by: "css", value: "#find" },
          ],
          fingerprint: { tag: "button" },
        },
        print_button: { scope: [], chain: [{ tier: 2, by: "css", value: "#print" }] },
        result_panel: { scope: [], chain: [{ tier: 2, by: "css", value: "#result" }] },
        result_balance: { scope: [], chain: [{ tier: 2, by: "css", value: "#balance" }] },
      },
    },
  });
}

let runSeq = 0;
function newLogger(): RunLogger {
  runSeq += 1;
  return new RunLogger(`evidence-test-${runSeq}`, EVIDENCE_DIR);
}

/** Every line of a run's evidence file, parsed. The only interface this file trusts. */
function readEvents(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("replay evidence — the run as a readable story", () => {
  it("lets a full run be reconstructed from the log alone: which step resolved at which tier, how many rungs corroborated it, and what the gate said", async () => {
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
    });
    expect(res.status).toBe("success");

    // Deliberately read back only `res.evidence.logPath` — the one thing a
    // caller holding a `ReplayResult` is guaranteed to have — rather than the
    // typed result fields the engine test file already exercises.
    const events = readEvents(res.evidence.logPath);

    const resolved = events.filter((e) => e["kind"] === "replay.resolved");
    const byControl = Object.fromEntries(resolved.map((e) => [e["control"], e]));

    // Every control the flow actually names resolved, at the tier the chain
    // recorded, with the rung count that corroborated it.
    expect(byControl["account_input"]).toMatchObject({ ok: true, tier: 0, agreed: 2 });
    expect(byControl["find_button"]).toMatchObject({ ok: true, tier: 1, agreed: 2 });
    expect(byControl["print_button"]).toMatchObject({ ok: true, agreed: 1 });
    expect(byControl["result_panel"]).toMatchObject({ ok: true, agreed: 1 });
    expect(byControl["result_balance"]).toMatchObject({ ok: true, agreed: 1 });

    // What the gate said, for the entry and for every gated action.
    const gates = events.filter((e) => e["kind"] === "replay.gate");
    expect(gates.length).toBeGreaterThanOrEqual(3);
    for (const g of gates) {
      expect((g["verdict"] as { decision: string }).decision).toBe("allow");
    }

    // Where it stopped: a terminal success event, naming its outputs.
    const success = events.find((e) => e["kind"] === "replay.success");
    expect(success).toMatchObject({ outputs: ["balance"] });
  });

  it("lets where a run stopped be reconstructed from the log alone, when it fails", async () => {
    PAGES.set("/app/find.htm", NO_FIND_PAGE);
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
      // See the note on the same option in tests/replay/engine.test.ts: the
      // control is absent by construction, and this only declines to spend the
      // default ten seconds proving it.
      controlBudgetMs: 300,
    });
    expect(res.status).toBe("failed");

    const events = readEvents(res.evidence.logPath);

    // The one control this page still has resolved, and at which tier.
    const accountResolved = events.find((e) => e["kind"] === "replay.resolved" && e["control"] === "account_input");
    expect(accountResolved).toMatchObject({ ok: true, tier: 0, agreed: 2 });

    // What the gate said before it acted.
    const gates = events.filter((e) => e["kind"] === "replay.gate");
    expect(gates.length).toBeGreaterThan(0);

    // Where it stopped, named without ambiguity.
    const failure = events.find((e) => e["kind"] === "replay.failed");
    expect(failure).toMatchObject({ classification: "no-match" });
    expect(failure?.["stepId"]).toContain("find_button");

    // And the story ends there: nothing after the failing step left a mark —
    // no `print_button` was ever acted on.
    const acted = events.filter((e) => e["kind"] === "replay.acted");
    expect(acted.some((e) => e["control"] === "print_button")).toBe(false);
  });
});

describe("replay evidence — no argument value ever reaches the log", () => {
  // Obviously secret-shaped, and never planted in real code — a real captured
  // credential in a test file would be exactly the leak this suite exists to
  // catch, written by hand.
  const SECRET_ARG = "sk-QUITE-OBVIOUSLY-A-SECRET-9F3K2Q";
  /** The option nobody selected. On a real account picker this is somebody else's account number. */
  const OTHER_ACCOUNT = "sk-THE-OPTION-NOBODY-PICKED-4T7Z1";

  /**
   * A dropdown whose options are the data — an account picker, a payee list, a
   * patient id. The label is deliberately unrelated to both options, so a name
   * read from the label cannot be mistaken for a name read from the contents.
   */
  const PICK_PAGE = `<!doctype html>
<html><body>
  <label for="from">From account</label>
  <select id="from" data-testid="from">
    <option>${SECRET_ARG}</option>
    <option>${OTHER_ACCOUNT}</option>
  </select>
</body></html>`;

  function pickArtifact(): CapabilityArtifact {
    return parseArtifact({
      capability: {
        id: "pick-account",
        product: "fixtures",
        version: 1,
        goal: "choose an account",
        inputs: { account: { type: "string" } },
        outputs: {},
        status: "approved",
      },
      flow: { steps: [{ kind: "act", action: "select", control: "from_select", value: "$account" }] },
      bindings: {
        tenant: "local",
        variant: "baseline",
        entryUrl: `${ORIGIN}/app/pick.htm`,
        controls: {
          from_select: {
            scope: [],
            chain: [
              { tier: 0, by: "testid", value: "from" },
              { tier: 2, by: "css", value: "#from" },
            ],
            fingerprint: { tag: "select" },
          },
        },
      },
    });
  }

  it("carries no credential, token, or argument value — only the argument's name", async () => {
    const log = newLogger();
    await replay({
      page,
      artifact: findArtifact(),
      args: { account: SECRET_ARG },
      policy: policyWith(),
      log,
    });

    const raw = readFileSync(log.path(), "utf8");
    expect(raw).not.toContain(SECRET_ARG);
    // The name survives — a run whose inputs are unknowable is not auditable —
    // and that is the whole of what is recorded about it.
    expect(raw).toContain("account");
  });

  it("carries no option of a select, argument or otherwise", async () => {
    // The path the test above could never reach. It uses a `fill`, and a text
    // input's `value` is deliberately never read as a name — so the argument
    // had no route into the log to begin with and the test passed for a reason
    // that does not generalise.
    //
    // A `<select>` is the case that does not hold: `controlNamesOf` reads the
    // element's `textContent`, which for a select is every option concatenated,
    // and the argument to a select step is by construction one of those
    // options. Measured on the real target, the `from account` dropdown reads
    // as one name: "1234512456125671267812789129001301113122132331334454321".
    // Every account number the customer has, in a file, by a route the
    // redactor has no pattern to key on.
    //
    // So the other option is asserted too. An argument value that leaks is one
    // bug; a control whose contents leak is the bug, and the argument is only
    // the part of it somebody happened to be looking for.
    PAGES.set("/app/pick.htm", PICK_PAGE);
    const log = newLogger();
    const res = await replay({
      page,
      artifact: pickArtifact(),
      args: { account: SECRET_ARG },
      policy: policyWith(),
      log,
    });
    // The step really ran, so the log really had the chance to record it.
    expect(res.status).toBe("success");
    expect(await page.locator("#from").inputValue()).toBe(SECRET_ARG);

    const raw = readFileSync(log.path(), "utf8");
    expect(raw).not.toContain(SECRET_ARG);
    expect(raw).not.toContain(OTHER_ACCOUNT);
  });
});

describe("replay evidence — a run summary carrying elapsed time against its budget", () => {
  it("records elapsed time over budget as such, without a test ever sleeping", async () => {
    // The clock is injected — the same reason `discover()` (`src/discover/loop.ts`)
    // takes a `now` — so this property is provable without waiting out a real
    // wall clock. Two calls only: `startedAt` at the top, and the read at the
    // end that produces `elapsedMs`.
    let reading = 0;
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
      wallClockBudgetMs: 1_000,
      now: () => (reading++ === 0 ? 0 : 5_000),
    });
    expect(res.status).toBe("success");

    const summary = readEvents(log.path()).find((e) => e["kind"] === "replay.summary");
    expect(summary).toMatchObject({
      status: "success",
      elapsedMs: 5_000,
      wallClockBudgetMs: 1_000,
      overBudget: true,
    });
  });

  it("records a run that finished inside its budget as such", async () => {
    let reading = 0;
    const log = newLogger();
    await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
      wallClockBudgetMs: 10_000,
      now: () => (reading++ === 0 ? 0 : 1_000),
    });

    const summary = readEvents(log.path()).find((e) => e["kind"] === "replay.summary");
    expect(summary).toMatchObject({ elapsedMs: 1_000, wallClockBudgetMs: 10_000, overBudget: false });
  });

  it("writes the summary on a failed run too — cost is a fact regardless of outcome", async () => {
    PAGES.set("/app/find.htm", NO_FIND_PAGE);
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
      controlBudgetMs: 300,
    });
    expect(res.status).toBe("failed");

    const summary = readEvents(log.path()).find((e) => e["kind"] === "replay.summary");
    expect(summary).toMatchObject({ status: "failed" });
    expect(typeof summary?.["elapsedMs"]).toBe("number");
  });
});
