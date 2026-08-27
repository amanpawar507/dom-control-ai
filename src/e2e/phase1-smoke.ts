import { chromium, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { ParabankSessionProvider } from "../session/playwright-state.js";
import { HANDLE_ATTR, resolveBinding } from "../surface/playwright-web/resolver.js";
import { PolicyRefusal, WebActor } from "../surface/playwright-web/actor.js";
import { RunLogger } from "../evidence/logger.js";
import type { GateVerdict, PolicyConfig } from "../policy/gate.js";
import type { Binding, Resolution } from "../surface/types.js";

const BASE = "http://localhost:8081/parabank";

/**
 * Pinned, not inherited. Tier 3 resolves by comparing rendered rectangles, and
 * an unpinned viewport makes "the nearest accepted control to the right, on the
 * same row" a function of whatever window the run happened to get. 1280x800
 * clears ParaBank's fixed ~980px layout without reflow, so a run on one machine
 * is a run on any other.
 */
const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Every wait in this run is a condition with a budget. No sleeps: a sleep is
 * either too short (flake) or too long (slow), and it never tells you which.
 *
 * These budgets are not decoration. `resolveBinding` never waits — its
 * `locator.all()` is a point-in-time snapshot with no auto-retry — so every
 * readiness condition in this composition has to be supplied here by the
 * caller. A control that is merely "usually there by now" is a control that
 * resolves to `no-match` on a slow day.
 */
const NAV_BUDGET_MS = 20_000;
const RENDER_BUDGET_MS = 20_000;

/**
 * One definition, used by the binding that enforces it and by the test that
 * asserts the extracted value. Two copies of a regex are two things to forget
 * to change together.
 *
 * The sign is part of the pattern because a bank balance is legitimately
 * signed: ParaBank's own formatter emits `-$2300.00`, and the fixture's first
 * account is overdrawn. A fingerprint's job is to catch "I resolved the wrong
 * element", not to assert a business range — rejecting a valid negative balance
 * would report `fingerprint-mismatch` for a resolution that was exactly right,
 * sending the next reader to debug a selector that has no bug.
 */
export const CURRENCY_FINGERPRINT = "^-?\\$[\\d,]+\\.\\d{2}$";

/** The balance cell, named once so the readiness wait and the binding cannot drift apart. */
const BALANCE_CELL = "#accountTable tbody tr:first-child td:nth-child(2)";

const CFG: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  approved: true,
};

export interface Control {
  binding: Binding;
  /**
   * The precondition for resolving this control, as a locator the caller waits
   * on. It deliberately mirrors the binding's primary strategy: the question a
   * readiness wait answers is "is the thing I am about to target present yet",
   * and any coarser signal answers a different question. Keeping the two next
   * to each other is what stops them drifting.
   */
  ready: (page: Page) => Locator;
}

/**
 * Bindings, verified against the live container's markup rather than inferred
 * from an accessibility tree.
 *
 * The tier-0 strategy on `first_balance` is not filler: ParaBank ships no
 * `data-testid`, so it matches nothing on every run and the chain degrades to
 * tier 2. That fall-through is behaviour under test, and `tests/e2e/phase1.test.ts`
 * pins the resulting tier so deleting the tier-0 rung fails a test.
 */
const CONTROLS = {
  nav_overview: {
    binding: {
      scope: [],
      chain: [{ tier: 1, by: "role", role: "link", name: "Accounts Overview" }],
    },
    ready: (page) => page.getByRole("link", { name: "Accounts Overview", exact: true }),
  },
  first_balance: {
    binding: {
      scope: [],
      chain: [
        { tier: 0, by: "testid", value: "overview-total-balance" },
        { tier: 2, by: "css", value: BALANCE_CELL },
      ],
      // What this catches is a column-type shift: an account number (`12345`), a
      // date, or the `tfoot` footnote all fail to look like currency. It gives
      // no row-identity discrimination — a different account's balance matches
      // this pattern identically — and it is not meant to. Picking the right row
      // is the selector's job; confirming the cell holds the right *kind* of
      // value is the fingerprint's.
      fingerprint: { matches: CURRENCY_FINGERPRINT },
    },
    ready: (page) => page.locator(BALANCE_CELL),
  },
  admin_clean: {
    binding: {
      scope: [],
      chain: [{ tier: 1, by: "role", role: "button", name: "Clean" }],
    },
    ready: (page) => page.getByRole("button", { name: "Clean", exact: true }),
  },
} satisfies Record<string, Control>;

export interface SmokeResult {
  runId: string;
  evidencePath: string;
  checkpointReached: boolean;
  balance: string | null;
  /** Tier that actually resolved each control, in the order they were resolved. */
  tiersUsed: number[];
  tiersByControl: Record<string, number>;
  refusedForeignNavigation: boolean;
  refusalReason: string | null;
  urlAfterRefusal: string;
  cleanButtonVerdict: GateVerdict["decision"];
  /**
   * The same probe against the same resolved handle, with the caller saying
   * nothing about the control and then saying something wrong about it. These
   * are the fields that make "the gate is keyed on the element" falsifiable
   * against the live page: a gate keyed on the caller's label answers `allow`
   * for both, and would have dropped the database had the probe been an `act`.
   */
  cleanButtonVerdictUnlabelled: GateVerdict["decision"];
  cleanButtonVerdictMislabelled: GateVerdict["decision"];
  cleanControlTier: number;
  /**
   * What the tier-0 rung of `first_balance` does on its own, against this page.
   * `tiersByControl` alone cannot show degradation — the tier it reports is the
   * winning strategy's declared number, which stays 2 whether or not a tier-0
   * rung was ever tried. Pairing that with this field is what makes "the chain
   * fell through tier 0 and landed on tier 2" an assertable claim.
   */
  tier0Outcome: string;
  /**
   * The tiers each control's chain declares, in the order the chain declares
   * them. The isolated probe above says a rung misses; this says where the rung
   * sits. Both are needed, because a chain reordered to try the brittle CSS
   * selector before the stable test id resolves at the same tier, reports the
   * same isolated `no-match`, and is strictly worse — it inverts the ladder's
   * premise while looking identical in every other field here. Fixed chain
   * order is a resolution rule, so it is reported and pinned like one.
   */
  chainTiers: Record<string, number[]>;
}

/** Resolution failures are terminal here; a smoke run that guesses proves nothing. */
function must(control: string, res: Resolution): Extract<Resolution, { ok: true }> {
  if (!res.ok) {
    const detail = [
      res.tier !== undefined ? `tier ${res.tier}` : null,
      res.count !== undefined ? `${res.count} matches` : null,
    ]
      .filter((d) => d !== null)
      .join(", ");
    throw new Error(`${control} did not resolve: ${res.reason}${detail ? ` (${detail})` : ""}`);
  }
  return res;
}

/**
 * Wait for the control to exist, then resolve it — in that order, and never one
 * without the other.
 *
 * `.first()` on the readiness locator is positional, but it is only a wait:
 * Playwright's strict mode would throw on a multi-match `waitFor`, and any real
 * ambiguity is still caught a line later by `resolveBinding`, which refuses to
 * pick among matches. The targeting decision stays exactly-one-or-fail.
 *
 * The wait's timeout is renamed on the way out. A control that is genuinely
 * absent fails here rather than at `must()`, and Playwright's own message says
 * only that a `locator.waitFor` exceeded 20000ms — no control, no page, nothing
 * an operator can act on at 3am. The underlying error is kept as `cause`, so
 * naming the control costs no detail.
 *
 * Exported for `tests/smoke/readiness.test.ts`. This renaming lives on a path a
 * passing run never takes, so without a test that drives the failure directly,
 * dropping the try/catch would go unnoticed by a green suite.
 */
export async function resolveWhenReady(
  page: Page,
  name: string,
  control: Control,
): Promise<Extract<Resolution, { ok: true }>> {
  try {
    await control.ready(page).first().waitFor({ state: "attached", timeout: RENDER_BUDGET_MS });
  } catch (cause) {
    throw new Error(
      `${name} never became ready: nothing matched its readiness locator on ${page.url()} within ${RENDER_BUDGET_MS}ms`,
      { cause },
    );
  }
  return must(name, await resolveBinding(page, control.binding, {}));
}

/**
 * The Phase 1 exit criterion, executed. Logs in through the session provider,
 * walks to Accounts Overview, reads a balance, is refused when it tries to
 * leave the allowlist, and asks the gate about the admin `Clean` button without
 * touching it. No model is consulted at any point: every binding is written
 * down ahead of time and every decision comes from the policy.
 *
 * Note what this run deliberately does *not* prove: that the actor refuses to
 * click an escalated control. Proving that here would mean calling `act()` on
 * `Clean` against a live database — you cannot test a guard by firing the thing
 * it guards. That branch is proved container-free in `tests/surface/actor.test.ts`.
 */
export async function runPhase1Smoke(): Promise<SmokeResult> {
  const runId = `phase1-${Date.now()}`;
  const log = new RunLogger(runId);
  const tiersUsed: number[] = [];
  const tiersByControl: Record<string, number> = {};

  const record = (control: string, res: Extract<Resolution, { ok: true }>): void => {
    tiersUsed.push(res.tier);
    tiersByControl[control] = res.tier;
    log.log({ kind: "resolved", control, tier: res.tier, handle: res.handle });
  };

  log.log({ kind: "run.start", target: BASE, viewport: `${VIEWPORT.width}x${VIEWPORT.height}` });

  // Credentials live and die inside the provider. What comes back is a storage
  // state — a session cookie — and nothing here ever writes it anywhere.
  const provider = new ParabankSessionProvider(BASE);
  const session = await provider.acquire("parabank", "local");
  log.log({ kind: "session.acquired", acquiredAt: session.acquiredAt });

  const storageState = JSON.parse(session.storageState) as NonNullable<
    BrowserContextOptions["storageState"]
  >;

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState, viewport: VIEWPORT });
    const page = await ctx.newPage();
    const actor = new WebActor(page, CFG, log);

    await actor.act({ type: "navigate", url: `${BASE}/index.htm` }, null);

    const nav = await resolveWhenReady(page, "nav_overview", CONTROLS.nav_overview);
    record("nav_overview", nav);
    await actor.act({ type: "click", handle: nav.handle }, "Accounts Overview");

    // Arriving is not the same as being ready. The overview's heading is
    // server-rendered and visible before any account data exists — the table
    // body is filled by a later XHR — so the URL settles first and the data
    // condition is waited on separately, inside resolveWhenReady.
    await page.waitForURL(/overview\.htm/, { timeout: NAV_BUDGET_MS });

    const bal = await resolveWhenReady(page, "first_balance", CONTROLS.first_balance);
    record("first_balance", bal);

    // Run the chain's own tier-0 rung in isolation, so the fall-through is
    // observed rather than assumed. Reading the rung out of the live chain (not
    // a copy) is deliberate: delete it and this throws, which is the point —
    // a ladder nobody can prove degraded is a ladder nobody would notice losing.
    const tier0 = CONTROLS.first_balance.binding.chain.find((s) => s.tier === 0);
    if (tier0 === undefined) {
      throw new Error("first_balance has no tier-0 rung left to degrade past");
    }
    const tier0Probe = await resolveBinding(page, { scope: [], chain: [tier0] }, {});
    const tier0Outcome = tier0Probe.ok ? `resolved at tier ${tier0Probe.tier}` : tier0Probe.reason;

    // Read off the same live objects the run resolved through, so the declared
    // order cannot be pinned in the test while the chain says something else.
    const chainTiers: Record<string, number[]> = Object.fromEntries(
      Object.entries(CONTROLS).map(([name, c]) => [name, c.binding.chain.map((s) => s.tier)]),
    );
    log.log({
      kind: "chain.probe",
      control: "first_balance",
      rung: 0,
      outcome: tier0Outcome,
      chainTiers,
    });

    // Read back from the page, not asserted into existence. A hardcoded `true`
    // would make the test that reads this field unfalsifiable. The heading check
    // earns its place *here*, after the data arrived: the page hides
    // `#showOverview` and shows `#showError` when the accounts XHR fails, so a
    // visible heading at this point means the overview panel is the one showing.
    const checkpointReached =
      new URL(page.url()).pathname.endsWith("/overview.htm") &&
      (await page.getByRole("heading", { name: "Accounts Overview", exact: true }).isVisible()) &&
      (await page.locator("#accountTable tbody tr").count()) > 0;
    log.log({ kind: "checkpoint", name: "accounts-overview", url: page.url(), reached: checkpointReached });

    const balance =
      (await page.locator(`[${HANDLE_ATTR}="${bal.handle}"]`).textContent())?.trim() ?? null;
    log.log({ kind: "extracted", control: "first_balance", value: balance });

    // Leaving the allowlist. The gate has to stop this before Playwright is
    // asked to go anywhere, so the URL afterwards is the proof, not the throw.
    const urlBeforeRefusal = page.url();
    let refusedForeignNavigation = false;
    let refusalReason: string | null = null;
    try {
      await actor.act({ type: "navigate", url: "https://example.com/" }, null);
    } catch (e) {
      if (e instanceof PolicyRefusal) {
        refusedForeignNavigation = true;
        refusalReason = e.reason;
      } else {
        throw e;
      }
    }
    const urlAfterRefusal = page.url();
    if (urlAfterRefusal !== urlBeforeRefusal) {
      throw new Error("the refused navigation moved the page; the gate ran too late");
    }

    // The admin `Clean` button drops the database. Resolving it is terminal like
    // every other control — if it cannot be found, this run fails rather than
    // reporting a verdict about a control that is not there. Then the gate is
    // asked, and that is where it stops: `act()` is never called with it.
    await actor.act({ type: "navigate", url: `${BASE}/admin.htm` }, null);
    const cleanRes = await resolveWhenReady(page, "admin_clean", CONTROLS.admin_clean);
    record("admin_clean", cleanRes);

    // The handle *is* the input that matters: the verdict is derived from the
    // element it points at, and the label alongside it can only make the answer
    // stricter. So the same probe is run three times against the same resolved
    // button, telling the gate the truth, telling it nothing, and telling it
    // something false. All three must escalate, because the button is the
    // button whichever of those the caller says.
    const cleanAction = { type: "click", handle: cleanRes.handle } as const;
    const cleanVerdict = await actor.verdictFor(cleanAction, "Clean");
    const cleanVerdictUnlabelled = await actor.verdictFor(cleanAction, null);
    const cleanVerdictMislabelled = await actor.verdictFor(cleanAction, "Accounts Overview");
    log.log({
      kind: "gate.probe",
      control: "Clean",
      verdict: cleanVerdict,
      unlabelled: cleanVerdictUnlabelled,
      mislabelled: cleanVerdictMislabelled,
      clicked: false,
    });

    const result: SmokeResult = {
      runId,
      evidencePath: log.path(),
      checkpointReached,
      balance,
      tiersUsed,
      tiersByControl,
      refusedForeignNavigation,
      refusalReason,
      urlAfterRefusal,
      cleanButtonVerdict: cleanVerdict.decision,
      cleanButtonVerdictUnlabelled: cleanVerdictUnlabelled.decision,
      cleanButtonVerdictMislabelled: cleanVerdictMislabelled.decision,
      cleanControlTier: cleanRes.tier,
      tier0Outcome,
      chainTiers,
    };
    log.log({ kind: "run.summary", ...result });
    return result;
  } finally {
    // release() before close() would be the safer order once release revokes
    // anything; today it is a documented no-op, and closing the browser first
    // is what frees the machine if release ever starts to block.
    try {
      await browser.close();
    } finally {
      await provider.release(session);
    }
  }
}
