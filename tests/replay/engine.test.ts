// tests/replay/engine.test.ts
//
// Container-free and network-free. Every page in this file is served by a
// Playwright route handler that fulfils the request inside the browser, so
// nothing leaves the process — and the fixture origin is `http://fixtures.test`,
// a reserved TLD (RFC 6761) that cannot resolve. If the interception ever broke,
// these tests would fail loudly on DNS rather than silently reaching something
// real, which is the property a `localhost` fixture origin would not have.
//
// Why a routed origin rather than `page.setContent`: the engine opens the
// artifact's own `bindings.entryUrl` as its first act, gated like any other
// navigation. That is the whole reason an artifact records where it starts, and
// a fixture that could not be navigated to would leave the entry path — and the
// gate on it — untested.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { rmSync, existsSync } from "node:fs";
import { replay } from "../../src/replay/engine.js";
import { parseArtifact, type CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/logger.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import type { AuthenticatedContext, SessionProvider } from "../../src/session/provider.js";

const ORIGIN = "http://fixtures.test";
const EVIDENCE_DIR = "tests/.tmp-replay-evidence";

let browser: Browser;
let context: BrowserContext;
let page: Page;

/** Path → HTML. Mutable so a test can re-serve the same path with drifted markup. */
const PAGES = new Map<string, string>();

/**
 * The ordinary fixture: an account lookup with a result panel, an empty-result
 * region, an internal-error region, and a second button whose only job is to
 * leave a mark on the page.
 *
 * The three regions are the shapes `SEVEN_CONDITIONS` declares, copied from the
 * target rather than invented for the test — which is the correction the final
 * review demanded of the previous version. That one carried a single `<div
 * id="errorContainer">No matching record</div>`: the selector the
 * `record-not-found` row declared, with content written to match the row's
 * *meaning*. On the real application `#errorContainer` is the internal-error
 * banner (`tests/fixtures/parabank/findtrans.html:202`), so the fixture agreed
 * with the declaration and both disagreed with the target, and no test in this
 * file could see it.
 *
 * So the empty answer is now the target's own empty-answer branch — the
 * transaction table hidden and `#noTransactions` left standing — and it is
 * shipped in the state ParaBank ships it: `#noTransactions` *visible* from the
 * start, table not yet hidden. That interval is the hazard the two-part
 * selector exists for, and every run in this file passes through it, because
 * detection runs after the first `fill` while the page is still in it.
 *
 * `#printed` is what makes "did the run stop" answerable against the page. A
 * result whose status says `business_outcome` is equally consistent with the
 * remaining steps having executed, so the flow below deliberately has a step
 * *after* the one that triggers the condition, and that step is observable.
 */
const FIND_PAGE = `<!doctype html>
<html><body>
  <h1>Find account</h1>
  <label for="acct">Account</label>
  <input id="acct" data-testid="acct" name="accountId">
  <button id="find" type="button">Find</button>
  <button id="print" type="button">Print</button>
  <div id="accountActivity">
    <table id="transactionTable"><tbody id="transactionBody"></tbody></table>
    <p id="noTransactions">No transactions found.</p>
  </div>
  <div id="errorContainer" style="display:none">
    <h1 class="title">Error!</h1>
    <p class="error">An internal error has occurred and has been logged.</p>
  </div>
  <div id="result" style="display:none"><span id="balance">-2300.00</span></div>
  <script>
    document.getElementById('find').addEventListener('click', function () {
      var v = document.getElementById('acct').value;
      if (v === '12345') {
        document.getElementById('noTransactions').style.display = 'none';
        document.getElementById('transactionBody').innerHTML = '<tr><td>a transaction</td></tr>';
        document.getElementById('result').style.display = 'block';
      } else if (v === '99999') {
        document.getElementById('transactionTable').style.display = 'none';
      } else {
        document.getElementById('errorContainer').style.display = 'block';
      }
    });
    document.getElementById('print').addEventListener('click', function () {
      var s = document.createElement('span');
      s.id = 'printed';
      s.textContent = 'printed';
      document.body.appendChild(s);
    });
  </script>
</body></html>`;

/**
 * The same page after the surface drifted: the recorded test id has moved onto
 * a different input, so tier 0 and tier 2 of `account_input`'s chain each still
 * resolve uniquely — to different elements.
 *
 * Both are `<input>`, deliberately. The recorded fingerprint is `tag: "input"`,
 * so it is satisfied by the *wrong* element too: this fixture defeats every
 * guard that existed before corroboration, which is what makes it evidence that
 * the engine resolves through `resolveCorroborated` rather than `resolveBinding`.
 */
const DRIFTED_PAGE = `<!doctype html>
<html><body>
  <input id="moved" data-testid="acct" name="moved">
  <input id="real" name="accountId">
</body></html>`;

/** The Find button is gone. Everything else is where it was. */
const NO_FIND_PAGE = `<!doctype html>
<html><body>
  <input id="acct" data-testid="acct" name="accountId">
  <button id="print" type="button">Print</button>
</body></html>`;

/**
 * The result panel arrives 40ms after load, from the page's own timer. The
 * engine waits on a condition with an explicit budget; nothing in this file
 * sleeps.
 */
const SLOW_PAGE = `<!doctype html>
<html><body>
  <input id="acct" data-testid="acct" name="accountId">
  <button id="find" type="button">Find</button>
  <div id="result" style="display:none"><span id="balance">-2300.00</span></div>
  <script>
    setTimeout(function () { document.getElementById('result').style.display = 'block'; }, 40);
  </script>
</body></html>`;

/** The result panel never arrives. */
const NEVER_PAGE = `<!doctype html>
<html><body>
  <input id="acct" data-testid="acct" name="accountId">
  <div id="result" style="display:none"><span id="balance">-2300.00</span></div>
</body></html>`;

/** A login form where a flow step expected the application — `session-expiry`. */
const LOGIN_PAGE = `<!doctype html>
<html><body>
  <div id="loginPanel">
    <input id="acct" data-testid="acct" name="accountId">
    <button id="find" type="button">Find</button>
  </div>
</body></html>`;

/**
 * Two rendered nodes answer `#errorContainer`'s declared landmark. The detector
 * abstains — correctly, because a landmark that has gone this broad no longer
 * means what it meant — and the engine has to say so, or a capability that
 * silently stopped detecting a condition looks exactly like a page that never
 * had one.
 */
const AMBIGUOUS_LANDMARK_PAGE = `<!doctype html>
<html><body>
  <input id="acct" data-testid="acct" name="accountId">
  <div class="errorContainer" id="e1">one</div>
  <div class="errorContainer" id="e2">two</div>
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

/**
 * The whole recorded capability, built through `parseArtifact` rather than cast.
 * A fixture artifact that could not survive the schema would prove nothing about
 * an engine whose input always has.
 */
function findArtifact(over: { entryUrl?: string; steps?: unknown[] } = {}): CapabilityArtifact {
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
      steps: over.steps ?? [
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
  return new RunLogger(`engine-test-${runSeq}`, EVIDENCE_DIR);
}

/** What the page says happened, read after a run rather than inferred from its status. */
async function pageState(): Promise<{
  url: string;
  filled: string;
  printed: boolean;
  resultShown: boolean;
  errorShown: boolean;
  emptyAnswerShown: boolean;
}> {
  return page.evaluate(() => {
    const acct = document.querySelector("#acct");
    const result = document.querySelector("#result");
    const err = document.querySelector("#errorContainer");
    const table = document.querySelector("#transactionTable");
    const none = document.querySelector("#noTransactions");
    return {
      url: location.href,
      filled: acct === null ? "<no field>" : (acct as HTMLInputElement).value,
      printed: document.querySelector("#printed") !== null,
      resultShown: result !== null && window.getComputedStyle(result).display !== "none",
      errorShown: err !== null && window.getComputedStyle(err).display !== "none",
      emptyAnswerShown:
        table !== null &&
        none !== null &&
        window.getComputedStyle(table).display === "none" &&
        window.getComputedStyle(none).display !== "none",
    };
  });
}

describe("replay — the four result shapes", () => {
  it("returns success with the declared outputs", async () => {
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.outputs).toEqual({ balance: "-2300.00" });

    // The flow really ran: every later step left its mark on the page.
    const state = await pageState();
    expect(state.filled).toBe("12345");
    expect(state.printed).toBe(true);
    expect(state.resultShown).toBe(true);
  });

  it("returns a business outcome without acting further", async () => {
    // Asserted against the page, not the result: a business outcome that kept
    // executing is indistinguishable from one that stopped, by its status
    // alone. `print_button` is step 3 — the step immediately after the one
    // that reveals the empty-result region — and clicking it appends `#printed`.
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "99999" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("business_outcome");
    if (res.status !== "business_outcome") return;
    expect(res.code).toBe("RECORD_NOT_FOUND");

    const state = await pageState();
    expect(state.emptyAnswerShown).toBe(true);
    expect(state.errorShown).toBe(false);
    expect(state.printed).toBe(false);
    expect(state.resultShown).toBe(false);
  });

  it("calls the application's own internal-error banner a fault, not an answer", async () => {
    // The defect the final review found, pinned at the engine: the same click,
    // the same declared table, and a page that answers with a stack trace
    // instead of a record. `#errorContainer` used to be the `record-not-found`
    // landmark, so this run ended `business_outcome` / `RECORD_NOT_FOUND` — a
    // caller told "no matching record" for a question the application never
    // answered, and nothing downstream could tell it from the truth.
    //
    // Asserted on the *class* rather than only on the status: a business
    // outcome is a claim that the call succeeded, and no page showing this
    // banner has succeeded at anything.
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "50000" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.observed).toContain("APPLICATION_ERROR");
    expect(res.classification).toBe("hard");

    const state = await pageState();
    expect(state.errorShown).toBe(true);
    expect(state.printed).toBe(false);
  });

  it("escalates rather than acting when the gate refuses", async () => {
    // The rule that caught a real defect in Phase 2: assert against the page.
    // A result saying "escalated" is also consistent with the click having
    // landed and then been reported.
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith({ riskRules: [{ tier: "irreversible", matchControl: "^Find$" }] }),
      log: newLogger(),
    });

    expect(res.status).toBe("escalated");
    if (res.status !== "escalated") return;
    expect(res.interventionId).toContain("find_button");
    expect(res.reason).toMatch(/irreversible/);

    const state = await pageState();
    // The URL did not change — no navigation happened on the escalated step.
    expect(state.url).toBe(`${ORIGIN}/app/find.htm`);
    // The click did not land: neither branch of the page's own handler ran.
    expect(state.resultShown).toBe(false);
    expect(state.errorShown).toBe(false);
    // And nothing past it ran either.
    expect(state.printed).toBe(false);
    // Step 1 was permitted and did happen, which is what makes the assertions
    // above evidence about the escalated step rather than about a run that
    // never started.
    expect(state.filled).toBe("12345");
  });

  it("refuses without filling the field when the allowlist forbids the action", async () => {
    // The other half of the gate: a refusal has no human on the other end of
    // it, so it is a `failed` result rather than an escalation — and it must
    // be just as inert against the page.
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith({
        allowlist: { origins: [ORIGIN], paths: ["/app/**"], actions: ["navigate", "click", "extract"] },
      }),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("policy-refusal");
    expect(res.stepId).toContain("account_input");

    const state = await pageState();
    expect(state.filled).toBe("");
    expect(state.printed).toBe(false);
    expect(state.url).toBe(`${ORIGIN}/app/find.htm`);
  });

  it("fails with the step, the expectation and what it saw", async () => {
    PAGES.set("/app/find.htm", NO_FIND_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
      // The control is absent by construction, so the run waits out its whole
      // patience budget before saying so. Named here at 300ms rather than left
      // at the ten-second default purely so a container-free suite does not
      // spend ten seconds waiting for something this fixture will never serve.
      // Nothing else about the subject changes: the assertions below are on
      // what the failure *says*, and the budget it waited is not one of them.
      controlBudgetMs: 300,
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("no-match");
    expect(res.stepId).toContain("find_button");
    expect(res.stepId).toContain("click");
    expect(res.expected).toContain("find_button");
    // What it saw, not merely that it broke.
    expect(res.observed).toMatch(/no rung/i);
    expect(res.observed).not.toBe("");

    // Nothing past the failing step ran.
    expect((await pageState()).printed).toBe(false);
  });

  it("refuses to act when the chain disagrees with itself", async () => {
    // Task 2's corroboration reaching the engine. Both rungs resolve uniquely
    // and both satisfy the recorded `tag` fingerprint, so this is refused only
    // if the engine resolves through `resolveCorroborated`.
    PAGES.set("/app/drifted.htm", DRIFTED_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact({ entryUrl: `${ORIGIN}/app/drifted.htm` }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("chain-disagreement");
    expect(res.stepId).toContain("account_input");
    // Which tiers disagreed, named — the field exists to say where to look.
    expect(res.observed).toMatch(/tier 0/);
    expect(res.observed).toMatch(/tier 2/);

    // Neither candidate was filled. "Refuses to act" is a claim about the page.
    const values = await page.evaluate(() => [
      (document.querySelector("#moved") as HTMLInputElement).value,
      (document.querySelector("#real") as HTMLInputElement).value,
    ]);
    expect(values).toEqual(["", ""]);
  });

  it("never acts on a control the artifact does not bind", async () => {
    // `parseArtifact` rejects this, so it is only reachable by a caller that
    // hand-built an artifact. The engine still refuses rather than trusting
    // its input, and it refuses before touching the page.
    const base = findArtifact();
    const unbound: CapabilityArtifact = {
      ...base,
      flow: {
        steps: [
          { kind: "act", action: "fill", control: "account_input", value: "$account" },
          { kind: "act", action: "click", control: "nowhere_button" },
        ],
      },
    };

    const res = await replay({
      page,
      artifact: unbound,
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("unreplayable");
    expect(res.observed).toContain("nowhere_button");

    // Nothing ran at all: the defect is found before the entry is even opened,
    // so the earlier, perfectly valid step did not execute either.
    expect(page.url()).not.toBe(`${ORIGIN}/app/find.htm`);
  });
});

describe("replay — arguments", () => {
  it("fails rather than typing an unbound placeholder into the page", async () => {
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: {},
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("unreplayable");
    expect(res.expected).toContain("account");
  });

  it("writes no argument value into the evidence trail", async () => {
    // Replay takes the values discovery refused to record. Logging them would
    // undo the artifact's discipline at the sink.
    const secret = "ZZTOPSECRETARG9";
    const log = newLogger();
    await replay({
      page,
      artifact: findArtifact(),
      args: { account: secret },
      policy: policyWith(),
      log,
    });

    const raw = readFileSync(log.path(), "utf8");
    expect(raw).not.toContain(secret);
    // The argument's *name* is recorded — a run whose inputs are unknowable is
    // not auditable — and that is the whole of what is recorded about it.
    expect(raw).toContain("account");
  });
});

describe("replay — detection", () => {
  it("records that a declared detector abstained, not merely that nothing fired", async () => {
    // "Condition absent" and "detector broken" are different facts. A landmark
    // matching two rendered nodes is the second one, and it is invisible in the
    // result: the run succeeds either way.
    PAGES.set("/app/ambig.htm", AMBIGUOUS_LANDMARK_PAGE);
    const log = newLogger();

    await replay({
      page,
      artifact: findArtifact({
        entryUrl: `${ORIGIN}/app/ambig.htm`,
        steps: [{ kind: "act", action: "fill", control: "account_input", value: "$account" }],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log,
      // A landmark this fixture makes ambiguous, declared alongside one that is
      // simply absent, so the two are told apart in the same event.
      conditions: [
        {
          id: "record-not-found",
          class: "business",
          code: "RECORD_NOT_FOUND",
          message: "No matching record was found.",
          locate: { tier: 2, by: "css", value: ".errorContainer" },
        },
        {
          id: "application-error",
          class: "recoverable",
          code: "APPLICATION_ERROR",
          message: "The application displayed an internal error banner.",
          locate: { tier: 2, by: "css", value: "#showError" },
        },
      ],
    });

    const events = readFileSync(log.path(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const detections = events.filter((e) => e["kind"] === "replay.detect");
    expect(detections.length).toBeGreaterThan(0);
    for (const d of detections) {
      expect(d["ambiguous"]).toEqual(["record-not-found"]);
      expect(d["unmatched"]).toEqual(["application-error"]);
      expect(d["detected"]).toBeNull();
    }
  });

  it("fails hard when a recoverable condition has no recovery available to it", async () => {
    // Session expiry with no `SessionProvider` cannot be recovered, and the one
    // thing it must never do is carry on against the login screen.
    PAGES.set("/app/login.htm", LOGIN_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact({
        entryUrl: `${ORIGIN}/app/login.htm`,
        steps: [{ kind: "act", action: "fill", control: "account_input", value: "$account" }],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("hard");
    expect(res.observed).toContain("SESSION_EXPIRED");
  });

  it("does not resume a session-expired run whose checkpoint cannot be re-verified", async () => {
    // A provider that "succeeds" changes nothing about the page in front of the
    // engine. Spec §7 is three steps — refresh, re-verify, resume — and the
    // third one is conditional on the second.
    PAGES.set("/app/login.htm", LOGIN_PAGE);
    const refreshed: string[] = [];
    const session: SessionProvider = {
      async acquire(): Promise<AuthenticatedContext> {
        return { storageState: "{}", acquiredAt: new Date(0).toISOString() };
      },
      async refresh(): Promise<AuthenticatedContext> {
        refreshed.push("refresh");
        return { storageState: "{}", acquiredAt: new Date(0).toISOString() };
      },
      async release(): Promise<void> {},
    };

    const res = await replay({
      page,
      artifact: findArtifact({
        entryUrl: `${ORIGIN}/app/login.htm`,
        steps: [
          { kind: "checkpoint", control: "find_button", state: "visible" },
          { kind: "act", action: "fill", control: "account_input", value: "$account" },
        ],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
      session,
      maxRecoveryAttempts: 2,
    });

    expect(refreshed.length).toBeGreaterThan(0);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("hard");
    // Bounded: it did not retry forever.
    expect(refreshed).toHaveLength(2);
  });
});

describe("replay — checkpoints", () => {
  it("waits for a checkpoint within its budget rather than failing on the first look", async () => {
    PAGES.set("/app/slow.htm", SLOW_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact({
        entryUrl: `${ORIGIN}/app/slow.htm`,
        steps: [
          { kind: "checkpoint", control: "result_panel", state: "visible" },
          { kind: "extract", control: "result_balance", as: "balance" },
        ],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
      checkpointBudgetMs: 2_000,
    });

    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.outputs).toEqual({ balance: "-2300.00" });
  });

  it("fails hard, saying what it waited for, when the checkpoint never arrives", async () => {
    PAGES.set("/app/never.htm", NEVER_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact({
        entryUrl: `${ORIGIN}/app/never.htm`,
        steps: [
          { kind: "checkpoint", control: "result_panel", state: "visible" },
          { kind: "extract", control: "result_balance", as: "balance" },
        ],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
      checkpointBudgetMs: 300,
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("hard");
    expect(res.stepId).toContain("result_panel");
    expect(res.expected).toContain("result_panel");
    expect(res.observed).toMatch(/budget|re-wait|bounded/i);
  });
});

describe("replay — a control that is not there yet", () => {
  it("waits for a non-checkpoint control, as patiently as it waits for a checkpoint", async () => {
    // Removing the wait must break something, and before this test it did not:
    // the reference application happens to have finished filling its table by
    // the time `goto` resolves, so every live run passed either way. A step
    // that names a control on a page still filling is the transient-slowness
    // case whatever the step's kind, and this is the page that proves it —
    // `#late` does not exist when the entry finishes loading.
    PAGES.set(
      "/app/late.htm",
      `<!doctype html><html><body>
         <input id="acct" data-testid="acct" name="accountId">
         <script>
           setTimeout(function () {
             var d = document.createElement("div");
             d.id = "late";
             d.textContent = "arrived";
             document.body.appendChild(d);
           }, 120);
         </script>
       </body></html>`,
    );

    const base = findArtifact({ entryUrl: `${ORIGIN}/app/late.htm` });
    const res = await replay({
      page,
      artifact: {
        ...base,
        flow: { steps: [{ kind: "extract", control: "late_panel", as: "text" }] },
        bindings: {
          ...base.bindings,
          controls: {
            ...base.bindings.controls,
            late_panel: { scope: [], chain: [{ tier: 2, by: "css", value: "#late" }] },
          },
        },
      },
      args: {},
      policy: policyWith(),
      log: newLogger(),
      controlBudgetMs: 3_000,
    });

    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.outputs).toEqual({ text: "arrived" });
  });
});

describe("replay — the entry and the gate", () => {
  it("opens the artifact's entry URL, through the same gate as every other action", async () => {
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith({
        allowlist: { origins: [ORIGIN], paths: ["/nowhere/**"], actions: [...ALLOWED_ACTIONS] },
      }),
      log: newLogger(),
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("policy-refusal");
    expect(res.stepId).toContain("entry");
    // Refused means not opened.
    expect(page.url()).not.toBe(`${ORIGIN}/app/find.htm`);
  });

  it("gates a navigate step by where it is going, and resolves it against the entry", async () => {
    // The second page serves the ordinary fixture rather than the stripped one:
    // this test's subject is that a root-relative step resolves against
    // `entryUrl` and is gated on its destination, and the proof the run carried
    // on afterwards is the print button leaving its mark — which the stripped
    // fixture has no handler to do.
    PAGES.set("/app/second.htm", FIND_PAGE);

    const res = await replay({
      page,
      artifact: findArtifact({
        steps: [
          { kind: "navigate", url: "/app/second.htm" },
          { kind: "act", action: "click", control: "print_button" },
        ],
      }),
      args: { account: "12345" },
      policy: policyWith(),
      log: newLogger(),
    });

    expect(res.status).toBe("success");
    expect(page.url()).toBe(`${ORIGIN}/app/second.htm`);
    expect((await pageState()).printed).toBe(true);
  });

  it("refuses an extract the allowlist does not permit, and reads nothing", async () => {
    // Replay used to run its extract branch without a gate at all, while the
    // discovery actor gated the same `ActionType` and said so in a comment. One
    // policy object, two engines, two answers — and the engine that ignored it
    // is the one that runs unattended. Reading a value off a page is how data
    // leaves the application; the allowlist has an `extract` action because
    // somebody decided that, and this is where the decision takes effect.
    //
    // Everything else the flow does stays permitted, so the run reaches the
    // extract and is refused *there*, rather than being stopped early by an
    // allowlist so narrow that it proves nothing about this step.
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith({
        allowlist: { origins: [ORIGIN], paths: ["/app/**"], actions: ["navigate", "click", "fill", "select"] },
      }),
      log,
    });

    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.classification).toBe("policy-refusal");
    expect(res.stepId).toContain("result_balance");
    expect(res.observed).toContain("action not allowed: extract");

    const events = readFileSync(log.path(), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // The verdict was recorded, on the step it was reached for.
    const extractGate = events.find((e) => e["kind"] === "replay.gate" && e["action"] === "extract");
    expect(extractGate).toMatchObject({ control: "result_balance", verdict: { decision: "refuse" } });

    // And the read never happened: refusing after reading would leave the value
    // already out of the application, which is the whole thing being refused.
    expect(events.some((e) => e["kind"] === "replay.extract")).toBe(false);

    // The steps before it did run, so this is a refusal of the extract rather
    // than a run that never got near one.
    expect((await pageState()).filled).toBe("12345");
  });
});

describe("replay — evidence", () => {
  it("points every result at the run that produced it", async () => {
    const log = newLogger();
    const res = await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
    });

    expect(res.evidence.runId).toBe(log.runId);
    expect(res.evidence.logPath).toBe(log.path());
    expect(existsSync(res.evidence.logPath)).toBe(true);
  });

  it("records the tier that resolved each control and how many rungs corroborated it", async () => {
    const log = newLogger();
    await replay({
      page,
      artifact: findArtifact(),
      args: { account: "12345" },
      policy: policyWith(),
      log,
    });

    const events = readFileSync(log.path(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const resolved = events.filter((e) => e["kind"] === "replay.resolved");
    const forInput = resolved.find((e) => e["control"] === "account_input");
    expect(forInput).toBeDefined();
    expect(forInput?.["tier"]).toBe(0);
    // Both rungs of the recorded chain named the same element.
    expect(forInput?.["agreed"]).toBe(2);
  });
});
