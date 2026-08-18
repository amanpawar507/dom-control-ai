// Container-free and network-free, but not browser-free.
//
// The loop's hardest claim is "the gate ran before the action, so the action
// did not happen". A stub page can record that `click` was never called, and
// `tests/surface/actor.test.ts` proves exactly that about the actor. It cannot
// prove it about the loop, because the loop's whole path to an action runs
// through a real `observe()` — a real `page.evaluate` walking a real DOM — and
// a stub that faked that would be asserting against a fake of the thing under
// test. So these tests drive a real Chromium against real markup, and assert
// against the *page*: the URL did not change, the field is still empty, the
// click never landed.
//
// The markup is served by `page.route`, which fulfils every request inside the
// browser process. Nothing leaves the machine, no container is involved, and
// the origin is `http://target.invalid` — a name RFC 2606 guarantees will
// never resolve. That last part is deliberate: if interception ever broke,
// these tests would fail loudly on DNS rather than quietly start talking to
// whatever happens to be listening on a real host.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { discover, type DiscoveryResult, type StopReason } from "../../src/discover/loop.js";
import {
  DriverFault,
  MalformedModelOutput,
  ScriptedDriver,
  type DriverTurn,
  type ModelDriver,
} from "../../src/discover/driver.js";
import { Budget } from "../../src/discover/budget.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import { HandleScript, StubLogger, type ScriptedCall } from "../support/stubs.js";

const ORIGIN = "http://target.invalid";
const INDEX = `${ORIGIN}/parabank/index.htm`;
const OVERVIEW = `${ORIGIN}/parabank/overview.htm`;

/**
 * Two pages, written to exercise the loop rather than to look like ParaBank.
 *
 * Every control carries a `data-testid` so `proveControl` has something that
 * proves unique on the first rung — proving is exercised against real ParaBank
 * markup in `tests/artifact/prove.test.ts` and again in `tests/e2e/discover.test.ts`,
 * and re-litigating it here would only make these tests fail for reasons that
 * have nothing to do with the loop.
 *
 * `#effect` is a bare `<div>`, so it is *not* in the observation
 * (`OBSERVABLE_SELECTOR` covers controls and things with a role, not
 * structural divs). That is what makes it usable as a witness: a test can ask
 * "did this click land?" by reading it, without the answer also being the
 * thing the loop's own dead-end digest is watching.
 */
const PAGES: Record<string, string> = {
  "/parabank/index.htm": `<!doctype html>
<html><head><title>ParaBank | Welcome</title></head>
<body>
  <a href="/parabank/overview.htm" data-testid="nav-overview">Accounts Overview</a>
  <p><label for="acct">Account Number</label></p>
  <div><input id="acct" name="accountNumber" data-testid="account-number" type="text"></div>
  <button data-testid="mark" onclick="document.getElementById('effect').textContent='Mark clicked'">Mark</button>
  <button data-testid="inert">Do Nothing</button>
  <button data-testid="admin-clean" onclick="document.getElementById('effect').textContent='Clean clicked'">Clean</button>
  <div id="effect"></div>
</body></html>`,
  "/parabank/overview.htm": `<!doctype html>
<html><head><title>ParaBank | Accounts Overview</title></head>
<body>
  <a href="/parabank/index.htm" data-testid="nav-home">Home</a>
  <div id="banner" role="status" data-testid="overview-banner">Accounts Overview</div>
  <button data-testid="hide-banner" onclick="document.getElementById('banner').style.visibility='hidden'">Hide Banner</button>
  <button data-testid="remove-banner" onclick="document.getElementById('banner').remove()">Remove Banner</button>
</body></html>`,
  // Deliberately carries no `data-testid` and four identically-named buttons,
  // the shape ParaBank's own findtrans page has. Every other page here is
  // marked up so proving always succeeds, which is why `control-unprovable`
  // had no scenario until this one existed.
  "/parabank/ambiguous.htm": `<!doctype html>
<html><head><title>ParaBank | Find</title></head>
<body>
  <a href="/parabank/index.htm" data-testid="nav-home">Home</a>
  <button>Find Transactions</button>
  <button>Find Transactions</button>
  <button>Find Transactions</button>
  <button>Find Transactions</button>
</body></html>`,
};

const CFG: PolicyConfig = {
  allowlist: {
    origins: [ORIGIN],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  sensitiveControls: [],
  approved: true,
};

/** The same policy with `fill` struck off, so a fill is refused by the allowlist. */
const CFG_NO_FILL: PolicyConfig = {
  ...CFG,
  allowlist: { ...CFG.allowlist, actions: ["click", "select", "navigate", "extract"] },
};

/** Sonnet 5 intro pricing, the same numbers Task 12 will construct a real Budget with. */
const RATE = { inPerM: 2, outPerM: 10 } as const;

const GOAL = "reach the accounts overview";

let browser: Browser;
let page: Page;

/**
 * Serves `PAGES` inside the browser process. Named rather than inline because
 * a test that needs a page which has *never navigated* (to prove what the
 * entry URL is when the model's first move is a navigate) has to build its
 * own page and give it the same routing.
 */
const serve: Parameters<Page["route"]>[1] = async (route) => {
  const body = PAGES[new URL(route.request().url()).pathname];
  await route.fulfill(
    body === undefined
      ? { status: 404, contentType: "text/html", body: "<!doctype html><title>404</title>" }
      : { status: 200, contentType: "text/html", body },
  );
};

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/*", serve);
}, 60_000);

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page.goto(INDEX);
});

interface Overrides {
  driver: ModelDriver;
  policy?: PolicyConfig;
  budget?: Budget;
  maxSteps?: number;
  wallClockMs?: number;
  now?: () => number;
  /** Defaults to the shared page, which `beforeEach` puts on `INDEX`. */
  page?: Page;
}

async function run(o: Overrides): Promise<{ res: DiscoveryResult; log: StubLogger }> {
  const log = new StubLogger();
  const res = await discover({
    page: o.page ?? page,
    goal: GOAL,
    driver: o.driver,
    policy: o.policy ?? CFG,
    log: log.asLogger(),
    budget: o.budget ?? new Budget(1, RATE),
    ...(o.maxSteps === undefined ? {} : { maxSteps: o.maxSteps }),
    ...(o.wallClockMs === undefined ? {} : { wallClockMs: o.wallClockMs }),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { res, log };
}

/** What the witness div says, i.e. which clicks actually landed. */
const effect = (): Promise<string> => page.locator("#effect").innerText();

describe("discover — success", () => {
  it("records an artifact when the model calls done and the checkpoint verifies", async () => {
    const driver = new HandleScript([
      [{ name: "fill", input: { handle: "@Account Number", value: "12345" } }],
      [{ name: "click", input: { handle: "@Accounts Overview" } }],
      [{ name: "done", input: { checkpoint: "@Accounts Overview" } }],
    ]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "recorded", steps: 3 });
    if (res.status !== "recorded") throw new Error("unreachable");

    // Three flow steps in the order they happened, each naming a control that
    // `bindings` actually binds — the cross-block rule `parseArtifact` enforces.
    expect(res.artifact.flow.steps.map((s) => s.kind)).toEqual(["act", "act", "checkpoint"]);
    const bound = Object.keys(res.artifact.bindings.controls);
    for (const step of res.artifact.flow.steps) {
      if ("control" in step) expect(bound).toContain(step.control);
    }

    expect(res.artifact.capability.goal).toBe(GOAL);
    // Discovery produces a draft; approving is a human act.
    expect(res.artifact.capability.status).toBe("draft");
    expect(log.kinds).toContain("discover.recorded");

    // The checkpoint the page ended on is the last step, and it is a
    // checkpoint step rather than an act.
    expect(res.artifact.flow.steps.at(-1)).toMatchObject({ kind: "checkpoint" });
  });

  it("records what was typed as an input parameter, never as a literal", async () => {
    // The loop cannot tell a password field from a search box — `observe()`
    // reports role "textbox" for both, because that is what the accessibility
    // tree says. So "record the value unless it looks sensitive" is a guess
    // made at the one boundary where a wrong guess writes a credential into a
    // file. Every filled value becomes a parameter instead, which is also what
    // spec §4 asks for: "a concrete id recorded from one session is never
    // replayed literally".
    const driver = new HandleScript([
      [{ name: "fill", input: { handle: "@Account Number", value: "12345" } }],
      [{ name: "click", input: { handle: "@Accounts Overview" } }],
      [{ name: "done", input: { checkpoint: "@Accounts Overview" } }],
    ]);

    const { res, log } = await run({ driver });
    if (res.status !== "recorded") throw new Error("expected a recording");

    const fill = res.artifact.flow.steps.find((s) => s.kind === "act" && s.action === "fill");
    expect(fill).toMatchObject({ value: expect.stringMatching(/^\$[A-Za-z_]\w*$/) });
    expect(Object.keys(res.artifact.capability.inputs)).toHaveLength(1);

    // Not in the artifact, and not in the evidence either.
    expect(JSON.stringify(res.artifact)).not.toContain("12345");
    expect(JSON.stringify(log.events)).not.toContain("12345");
  });

  it("refreshes the observation each turn instead of accumulating a transcript", async () => {
    // Spec §6: "the observation is refreshed each turn rather than
    // accumulated, so context stays bounded on long flows". Two halves, and
    // both are asserted: each turn is handed a *new* observation (fresh
    // handles, current URL), and `history` carries the model's own turns and
    // nothing else — no stack of past snapshots growing quadratically behind
    // it.
    const driver = new HandleScript([
      [{ name: "observe", input: {} }],
      [{ name: "click", input: { handle: "@Accounts Overview" } }],
      [{ name: "done", input: { checkpoint: "@Accounts Overview" } }],
    ]);

    const { res } = await run({ driver });
    expect(res.status).toBe("recorded");

    expect(driver.seen).toHaveLength(3);
    expect(driver.seen.map((s) => s.observation.url)).toEqual([INDEX, INDEX, OVERVIEW]);

    // Fresh handles every turn: the epoch changes, so no handle survives into
    // the next observation. That is the staleness mechanism doing its job, and
    // it is only visible because the loop re-observes.
    const handles = driver.seen.map((s) => s.observation.nodes.map((n) => n.handle).join(","));
    expect(new Set(handles).size).toBe(3);

    // History grows by one turn per turn, and holds only turns.
    expect(driver.seen.map((s) => s.history.length)).toEqual([0, 1, 2]);
    for (const { history } of driver.seen) {
      for (const turn of history) expect(Object.keys(turn)).toEqual(["calls"]);
    }
  });
});

describe("discover — an artifact has to say where it starts, and where it went", () => {
  // A capability is replayed with no model in the loop, so the two things a
  // replay engine cannot infer are the address to open and the navigations the
  // flow depends on. Neither was recorded: the flow step union had no
  // `navigate`, and `entryUrl` was `page.url()` read before the first turn —
  // which is `about:blank` whenever the model's opening move is a navigate,
  // the most natural opening move there is. `z.string().url()` accepted it,
  // and a committed artifact shipped with three proven bindings for pages
  // under `/parabank/` and an entry of `about:blank`.
  //
  // These tests are what "green is not evidence" means here: the whole e2e
  // suite ran over that artifact.

  /** A page that has never navigated, so `page.url()` on it is `about:blank`. */
  async function freshPage(): Promise<Page> {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.route("**/*", serve);
    return p;
  }

  it("records where the run actually began when the model's opening move is a navigate", async () => {
    const blank = await freshPage();
    try {
      expect(blank.url()).toBe("about:blank");

      const driver = new HandleScript([
        [{ name: "navigate", input: { url: INDEX } }],
        [{ name: "click", input: { handle: "@Accounts Overview" } }],
        [{ name: "done", input: { checkpoint: "@Accounts Overview" } }],
      ]);
      const { res } = await run({ driver, page: blank });

      expect(res.status).toBe("recorded");
      if (res.status !== "recorded") throw new Error("unreachable");
      expect(res.artifact.bindings.entryUrl).toBe(INDEX);
      expect(res.artifact.bindings.entryUrl).not.toBe("about:blank");

      // That opening navigate is the entry, so it is not also a step — a
      // replay opening `entryUrl` would otherwise re-open the same address as
      // its first act.
      expect(res.artifact.flow.steps.map((s) => s.kind)).toEqual(["act", "checkpoint"]);
    } finally {
      await blank.close();
    }
  });

  it("keeps the page it started on as the entry when the model navigates away later", async () => {
    // The mirror of the test above: the run *did* start somewhere replayable,
    // so a later navigation must not overwrite the entry with wherever the
    // flow went next.
    const driver = new HandleScript([
      [{ name: "navigate", input: { url: OVERVIEW } }],
      [{ name: "done", input: { checkpoint: "@Home" } }],
    ]);

    const { res } = await run({ driver });

    if (res.status !== "recorded") throw new Error(`expected a recording, got ${JSON.stringify(res)}`);
    expect(res.artifact.bindings.entryUrl).toBe(INDEX);
  });

  it("records a mid-flow navigation as a flow step, as a path rather than a tenant's host", async () => {
    // Without a `navigate` step the loop performed the goto and had nowhere to
    // write it down: the artifact's flow was a list of clicks against whatever
    // page the replay engine happened to be on.
    //
    // The path, not the absolute URL, because `flow` is the block shared
    // across every tenant running this product (spec §4) and a tenant override
    // may modify `bindings` only. `bindings.entryUrl` carries the host; the
    // step resolves against it.
    const driver = new HandleScript([
      [{ name: "navigate", input: { url: OVERVIEW } }],
      [{ name: "done", input: { checkpoint: "@Home" } }],
    ]);

    const { res } = await run({ driver });

    if (res.status !== "recorded") throw new Error(`expected a recording, got ${JSON.stringify(res)}`);
    expect(res.artifact.flow.steps.map((s) => s.kind)).toEqual(["navigate", "checkpoint"]);
    expect(res.artifact.flow.steps[0]).toEqual({ kind: "navigate", url: "/parabank/overview.htm" });
    expect(JSON.stringify(res.artifact.flow)).not.toContain(ORIGIN);

    // And it resolves back to where the run went, with the one call a replay
    // engine makes.
    expect(new URL("/parabank/overview.htm", res.artifact.bindings.entryUrl).href).toBe(OVERVIEW);
  });

  it("escalates rather than recording an artifact whose entry nobody can open", async () => {
    // The goal was reached — the checkpoint verified — on a page that exists
    // only in this process. There is no address to hand a replay, and the
    // honest outcome is an escalation with its own reason rather than a
    // recording that names `about:blank`, or a throw out of `discover()` that
    // no caller can route on.
    const blank = await freshPage();
    try {
      await blank.setContent(`<button data-testid="only">Only</button>`);
      expect(blank.url()).toBe("about:blank");

      const driver = new HandleScript([[{ name: "done", input: { checkpoint: "@Only" } }]]);
      const { res, log } = await run({ driver, page: blank });

      expect(res).toMatchObject({ status: "escalated", reason: "entry-url-unknown", steps: 1 });
      // The checkpoint did verify; this is a recording failure, not a goal
      // failure, and the evidence has to be able to tell them apart.
      expect(log.events.find((e) => e.kind === "discover.checkpoint")).toMatchObject({ verified: true });
      expect(log.kinds).not.toContain("discover.recorded");
    } finally {
      await blank.close();
    }
  });
});

describe("discover — stopping conditions", () => {
  it("escalates at max steps rather than running forever", async () => {
    const script = Array.from({ length: 10 }, () => [{ name: "observe", input: {} }]);
    const { res } = await run({ driver: new ScriptedDriver(script), maxSteps: 3 });

    expect(res).toMatchObject({ status: "escalated", reason: "max-steps", steps: 3 });
  });

  it("escalates on the wall clock without any test ever sleeping", async () => {
    // Resolution rule 4 (§7) is "condition-based waits with explicit budgets.
    // No sleeps." A test that slept for the budget it is checking would be
    // breaking the rule it exists to enforce, so the clock is injected: it
    // advances 600ms per reading against a 1000ms budget, which puts the halt
    // on the second reading, after exactly one turn.
    let reading = 0;
    const script = Array.from({ length: 5 }, () => [{ name: "observe", input: {} }]);
    const { res } = await run({
      driver: new ScriptedDriver(script),
      wallClockMs: 1_000,
      now: () => reading++ * 600,
    });

    expect(res).toMatchObject({ status: "escalated", reason: "wall-clock", steps: 1 });
  });

  it("escalates when the model declares itself stuck", async () => {
    const driver = new ScriptedDriver([
      [{ name: "observe", input: {} }],
      [{ name: "stuck", input: { reason: "no control on this page opens an account" } }],
    ]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "model-stuck", steps: 2 });
    // The reason the model gave survives into the evidence — §8 routes on it.
    expect(JSON.stringify(log.events)).toContain("no control on this page opens an account");
  });

  it("escalates on three consecutive acting turns with no observable state change", async () => {
    // Dead-end detection. Without it a model that clicks a dead control forty
    // times burns the whole step budget and the whole money budget.
    //
    // The script holds exactly three turns, which is itself part of the
    // assertion: the loop must reach its verdict on the *fourth* pass, before
    // asking for a fourth turn. Raise DEAD_END_LIMIT and the loop asks for a
    // turn that is not there, and `ScriptedDriver` fails the test loudly
    // instead of letting it drift.
    const driver = new HandleScript([
      [{ name: "click", input: { handle: "@Do Nothing" } }],
      [{ name: "click", input: { handle: "@Do Nothing" } }],
      [{ name: "click", input: { handle: "@Do Nothing" } }],
    ]);

    const { res } = await run({ driver, maxSteps: 40 });

    expect(res).toMatchObject({ status: "escalated", reason: "dead-end", steps: 3 });
  });

  it("does not call a dead end when the actions keep changing the page", async () => {
    // The negative control for the test above. Four acting turns in a row,
    // each of which does change something observable, must not trip a
    // detector counting consecutive *unchanged* ones — otherwise "dead end"
    // would just mean "acted three times", and every real flow would escalate.
    const driver = new HandleScript([
      [{ name: "fill", input: { handle: "@Account Number", value: "1" } }],
      [{ name: "fill", input: { handle: "@Account Number", value: "12" } }],
      [{ name: "fill", input: { handle: "@Account Number", value: "123" } }],
      [{ name: "fill", input: { handle: "@Account Number", value: "1234" } }],
      [{ name: "stuck", input: { reason: "done experimenting" } }],
    ]);

    const { res } = await run({ driver, maxSteps: 40 });

    expect(res).toMatchObject({ status: "escalated", reason: "model-stuck", steps: 5 });
  });

  it("escalates when the budget guard trips, before performing that turn's action", async () => {
    // A `Budget(0)` with a driver reporting real tokens: the first charge is
    // refused, and the click it arrived with never happens. The money for that
    // turn is already gone — nothing can undo an API call — but a run that is
    // over budget must not also go on touching the page.
    const driver = new HandleScript(
      [[{ name: "click", input: { handle: "@Mark" } }]],
      { inputTokens: 1_000, outputTokens: 100 },
    );

    const { res } = await run({ driver, budget: new Budget(0, RATE) });

    expect(res).toMatchObject({ status: "escalated", reason: "budget-exceeded", steps: 1 });
    expect(await effect()).toBe("");
  });
});

describe("discover — the gate runs before the action, not after", () => {
  // Every test in this block asserts against the *page*. "The result says
  // escalated" is equally consistent with a loop that acted and then reported,
  // which is the failure this whole block exists to rule out.

  it("refuses an out-of-allowlist navigation without the browser leaving the page", async () => {
    const driver = new ScriptedDriver([[{ name: "navigate", input: { url: "https://example.com/" } }]]);

    const { res } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "policy-refusal" });
    expect(page.url()).toBe(INDEX);
  });

  it("refuses a fill the allowlist does not permit without the field being filled", async () => {
    const driver = new HandleScript([
      [{ name: "fill", input: { handle: "@Account Number", value: "12345" } }],
    ]);

    const { res } = await run({ driver, policy: CFG_NO_FILL });

    expect(res).toMatchObject({ status: "escalated", reason: "policy-refusal" });
    expect(await page.locator("#acct").inputValue()).toBe("");
  });

  it("escalates an irreversible control without the click landing", async () => {
    // The model supplied a handle and nothing else — no label it could have
    // used to talk the gate down. The verdict comes from what the element is
    // called, read off the element.
    const driver = new HandleScript([[{ name: "click", input: { handle: "@Clean" } }]]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "policy-refusal" });
    // The button's own onclick would have written here. It is still empty, so
    // the click did not happen — not merely "was reported as refused".
    expect(await effect()).toBe("");

    const gateEvents = log.events.filter((e) => e.kind === "discover.gate");
    expect(gateEvents.at(-1)).toMatchObject({
      controlNames: ["Clean"],
      verdict: { decision: "escalate", risk: "irreversible" },
    });
  });

  it("still performs an allowed click, so the refusals above are not the loop refusing everything", async () => {
    // Without this, every assertion in this block is satisfied by a loop that
    // never clicks anything at all.
    const driver = new HandleScript([
      [{ name: "click", input: { handle: "@Mark" } }],
      [{ name: "stuck", input: { reason: "that is all" } }],
    ]);

    const { res } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "model-stuck" });
    expect(await effect()).toBe("Mark clicked");
  });
});

describe("discover — done is a claim, not a fact", () => {
  // Three tests, three distinct ways a `done` can be wrong, each isolating one
  // mechanism of `checkpointHolds`. They are separate because a single test
  // covering "the checkpoint is bad" would be satisfied by whichever check
  // happens to fire first, and would then stay green while the others were
  // deleted — which is exactly how the first draft of this file went wrong:
  // the invented-handle case below was being caught by a defensive lookup
  // downstream of verification, so disabling verification entirely left it
  // green.

  it("escalates when the checkpoint element has left the page since it was observed", async () => {
    // The handle is real and was stamped: it comes from the observation this
    // turn was handed. The click in front of it removes the element, so the
    // only thing that can catch this is re-checking the *live* page at `done`
    // rather than trusting the observation the model was reasoning over.
    const driver = new HandleScript([
      [{ name: "click", input: { handle: "@Accounts Overview" } }],
      [
        { name: "click", input: { handle: "@Remove Banner" } },
        { name: "done", input: { checkpoint: "@Accounts Overview" } },
      ],
    ]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "checkpoint-unverified" });
    expect(log.kinds).not.toContain("discover.recorded");
    expect(await page.locator("#banner").count()).toBe(0);
  });

  it("escalates when done names a handle no observation ever produced", async () => {
    const driver = new ScriptedDriver([[{ name: "done", input: { checkpoint: "o999n999" } }]]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "checkpoint-unverified", steps: 1 });
    expect(log.kinds).not.toContain("discover.recorded");
  });

  it("escalates when the checkpoint is present in the DOM but not rendered", async () => {
    // The case this target ships by the dozen, and the reason spec §7 calls
    // visibility gating "non-negotiable": a success node that exists and is
    // invisible. Both calls are in one turn on purpose — the handle is taken
    // from the observation this turn was handed, the click then hides the
    // element behind it, and the element is still stamped. So the count check
    // passes and only the rendered check can catch this.
    const driver = new HandleScript([
      [{ name: "click", input: { handle: "@Accounts Overview" } }],
      [
        { name: "click", input: { handle: "@Hide Banner" } },
        { name: "done", input: { checkpoint: "@Accounts Overview" } },
      ],
    ]);

    const { res, log } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "checkpoint-unverified" });
    expect(log.kinds).not.toContain("discover.recorded");
    // The element really is still there — so a check that only counted
    // matches would have called this a success.
    expect(await page.locator("#banner").count()).toBe(1);
  });
});

describe("discover — a broken harness and a broken model are different failures", () => {
  // `ModelDriver.next()` can fail two ways that look identical at the catch
  // site: the harness is broken (a script that ran out), or the model produced
  // something unusable. If the loop caught broadly and escalated, a test whose
  // script merely ran out would report a clean escalation and pass, proving
  // nothing about the stopping condition it names. These two tests fail if the
  // types are ever conflated.

  it("lets a script that ran out propagate rather than reporting it as an escalation", async () => {
    // maxSteps 5, script of 1: the loop asks for a second turn that is not
    // there. That is a bug in this test file, and it must look like one.
    const driver = new ScriptedDriver([[{ name: "observe", input: {} }]]);
    const log = new StubLogger();

    const thrown: unknown = await discover({
      page,
      goal: GOAL,
      driver,
      policy: CFG,
      log: log.asLogger(),
      budget: new Budget(1, RATE),
      maxSteps: 5,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DriverFault);
    expect(thrown).not.toBeInstanceOf(MalformedModelOutput);
    expect((thrown as Error).message).toMatch(/exhausted/i);
    expect(log.kinds).not.toContain("discover.escalated");
  });

  it("escalates when the driver reports the model's output as unusable", async () => {
    const driver: ModelDriver = {
      async next(): Promise<DriverTurn> {
        throw new MalformedModelOutput("the model replied with prose and no tool call");
      },
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    };

    const { res } = await run({ driver });

    expect(res).toMatchObject({ status: "escalated", reason: "model-output-unusable", steps: 0 });
    // Not the same thing as the model calling `stuck`: one has understood the
    // page and reported a dead end, the other has not answered the question.
    expect(res).not.toMatchObject({ reason: "model-stuck" });
  });

  const unusable: Array<[string, ScriptedCall[]]> = [
    ["an unknown tool name", [{ name: "teleport", input: { handle: "x" } }]],
    ["a selector smuggled alongside a handle", [{ name: "click", input: { handle: "o1n1", selector: "#acct" } }]],
    ["a turn with no calls at all", []],
    ["a handle that is in no observation", [{ name: "click", input: { handle: "o999n999" } }]],
  ];

  it.each(unusable)("escalates on %s", async (_label, calls) => {
    const { res, log } = await run({ driver: new ScriptedDriver([calls]) });

    expect(res).toMatchObject({ status: "escalated", reason: "model-output-unusable" });
    expect(log.kinds).not.toContain("discover.recorded");
  });
});

describe("discover — never a partial artifact", () => {
  // Spec §6: "Discovery never fails silently and never records a partial
  // artifact." Tested as its own property over every escalation trigger,
  // rather than as the negation of the happy path — the paths that reach an
  // escalation *after* several controls have already been proven are exactly
  // the ones where a half-built artifact could leak out, and they are the ones
  // a happy-path negation never visits.
  const scenarios: Array<[StopReason, () => Overrides]> = [
    [
      // `done` naming one of four identically-named buttons on a page with no
      // test ids: every candidate strategy resolves ambiguously, so
      // `proveControl` throws rather than emit a binding that would resolve to
      // an arbitrary one of them at replay. The run must escalate and record
      // nothing — a checkpoint that cannot be proven is not a checkpoint,
      // however confidently the model asserted `done`.
      "control-unprovable",
      () => ({
        driver: new HandleScript([
          [{ name: "navigate", input: { url: `${ORIGIN}/parabank/ambiguous.htm` } }],
          [{ name: "done", input: { checkpoint: "@2:Find Transactions" } }],
        ]),
      }),
    ],
    [
      "max-steps",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Mark" } }],
          [{ name: "click", input: { handle: "@Mark" } }],
        ]),
        maxSteps: 2,
      }),
    ],
    [
      "wall-clock",
      () => {
        let reading = 0;
        return {
          driver: new HandleScript([[{ name: "click", input: { handle: "@Mark" } }]]),
          wallClockMs: 1_000,
          now: () => reading++ * 600,
        };
      },
    ],
    [
      "dead-end",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Do Nothing" } }],
          [{ name: "click", input: { handle: "@Do Nothing" } }],
          [{ name: "click", input: { handle: "@Do Nothing" } }],
        ]),
      }),
    ],
    [
      "model-stuck",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Mark" } }],
          [{ name: "stuck", input: { reason: "cannot get further" } }],
        ]),
      }),
    ],
    [
      "policy-refusal",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Mark" } }],
          [{ name: "click", input: { handle: "@Clean" } }],
        ]),
      }),
    ],
    [
      "budget-exceeded",
      () => ({
        driver: new HandleScript([[{ name: "click", input: { handle: "@Mark" } }]], {
          inputTokens: 1_000,
          outputTokens: 100,
        }),
        budget: new Budget(0, RATE),
      }),
    ],
    [
      "checkpoint-unverified",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Mark" } }],
          [{ name: "done", input: { checkpoint: "o999n999" } }],
        ]),
      }),
    ],
    [
      "model-output-unusable",
      () => ({
        driver: new HandleScript([
          [{ name: "click", input: { handle: "@Mark" } }],
          [{ name: "click", input: { handle: "o999n999" } }],
        ]),
      }),
    ],
  ];

  it.each(scenarios)("records nothing when the run escalates with %s", async (reason, build) => {
    const { res, log } = await run(build());

    expect(res).toMatchObject({ status: "escalated", reason });
    // The result type has no artifact field on this branch; assert it at
    // runtime too, since an artifact could be attached by a loop that thought
    // "escalated with partial results" was a useful thing to return.
    expect(res).not.toHaveProperty("artifact");
    // And nothing was written anywhere: the logger is the loop's only sink, so
    // the absence of a `discover.recorded` event is the absence of a record.
    expect(log.kinds).not.toContain("discover.recorded");
    expect(log.kinds).toContain("discover.escalated");
  });

  it("covers every stop reason the loop can produce", async () => {
    // A table is only as good as its coverage, and a reason added later with
    // no row here would silently go untested. `control-unprovable` is the one
    // reason absent by construction: every control in these fixtures carries a
    // `data-testid`, so proving cannot fail on them — it is exercised against
    // real, unmarked ParaBank markup in tests/artifact/prove.test.ts, which
    // pins the throw this reason reports.
    const covered = new Set(scenarios.map(([reason]) => reason));
    const all: StopReason[] = [
      "max-steps",
      "wall-clock",
      "dead-end",
      "model-stuck",
      "policy-refusal",
      "budget-exceeded",
      "checkpoint-unverified",
      "model-output-unusable",
      "control-unprovable",
    ];
    expect(all.filter((r) => !covered.has(r))).toEqual([]);
  });
});
