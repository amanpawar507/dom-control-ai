// The live composition: the recorded capability, this target's policy, this
// target's runtime conditions, and an authenticated browser to run them in.
//
// It lives in src/ rather than under scripts/ for the reason
// src/e2e/phase1-smoke.ts does: a runner that only exists as a script is a
// runner the test suite cannot import, and then the thing demonstrated by hand
// and the thing asserted by tests are two different code paths.
//
// Nothing here puts a model in the loop. Replay's whole claim is that it does
// not need one, and this module is where that claim meets a real bank UI.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { RunLogger } from "../evidence/logger.js";
import type { PolicyConfig } from "../policy/gate.js";
import { SEVEN_CONDITIONS, type ConditionDecl } from "../replay/conditions.js";
import { replay } from "../replay/engine.js";
import { loadCapability } from "../replay/load.js";
import type { ReplayResult } from "../replay/result.js";
import { ParabankSessionProvider } from "../session/playwright-state.js";
import type { Strategy } from "../surface/types.js";

export const BASE = "http://localhost:8081/parabank";

/**
 * The capability Phase 2 recorded against this same container, addressed by the
 * coordinates `capabilities/<product>/<id>/<version>.json` stores it under.
 *
 * The id is an ugly truncation of the recorded goal, from before capability ids
 * were caller-supplied. It is deliberately not renamed: the file lives at that
 * path, and a prettier constant here would only orphan it.
 */
export const PRODUCT = "parabank";
export const CAPABILITY_ID = "record_the_first_account_number_listed_in_the_ac";
export const CAPABILITY_VERSION = 1;

/**
 * The one input the recorded flow parameterises: the transaction-type dropdown
 * on an account's activity page. The recorder wrote `$combobox_all_credit_debit`
 * rather than the literal it saw, so a replay must supply a value — that is the
 * artifact's parameterisation working, not a gap in it.
 *
 * The live dropdown offers exactly `All`, `Credit` and `Debit`.
 */
export const TYPE_ARGUMENT = "combobox_all_credit_debit";

/** Pinned for the same reason every other run in this project pins it: tier 3 compares rendered rectangles. */
const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * What a replay of this capability is allowed to do on this target.
 *
 * Identical in shape to the policy the discovery run carried (`scripts/discover.mts`),
 * and `approved` is false for the same reason: the artifact's own
 * `capability.status` is `draft`, so nothing about it has been approved by a
 * human and a policy claiming otherwise would be a lie told to the gate. The
 * recorded flow touches a link, a dropdown and a submit button — none of them
 * guarded — so the run never depends on that flag being true; the money-moving
 * controls ParaBank puts in the navigation of every authenticated page stay
 * refused, and `Clean`/`Shutdown`/`Admin Page` stay irreversible, for a replay
 * that wanders as much as for a model that does.
 */
export const POLICY: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [
    { tier: "irreversible", matchControl: "^(Clean|Shutdown|Admin Page)$" },
    {
      tier: "guarded",
      matchControl: "^(Transfer Funds|Bill Pay|Request Loan|Open New Account|Update Contact Info|Log Out)$",
    },
  ],
  approved: false,
};

/**
 * Where each of spec §7's conditions actually shows up on the two pages this
 * capability walks, verified against the live container rather than inferred.
 *
 * `SEVEN_CONDITIONS` says so itself: its `locate` values are grounded in the
 * fixtures under `tests/fixtures/parabank/` where a fixture exists and are
 * reasonable placeholders where none does, and "a capability recorded by a live
 * discovery run would supply the actual selectors". This is that supply. The
 * taxonomy — the ids, classes, codes and messages — is not restated here; it is
 * mapped over below, so this table can change where a condition *is* without
 * ever changing what a condition *means*.
 *
 * `null` means the condition has no landmark on this target and is declared
 * undetectable here rather than pointed at something that only resembles it.
 */
const LIVE_LANDMARKS: Record<string, Strategy | null> = {
  /**
   * The application answering "there are none", in its own words and by its own
   * branch: on an empty result ParaBank shows `#noTransactions` and hides
   * `#transactionTable`.
   *
   * Both halves are in the selector on purpose. `#noTransactions` alone is
   * *shipped visible* in the activity page's markup and stays visible until the
   * page's first XHR returns, so a detector keyed on it fires during the load
   * of a perfectly ordinary page — measured against the live container, not
   * feared — and a run that clicked through to an account would report "no
   * records" before it had asked anything. The transaction table carries no
   * inline style until jQuery hides it, so requiring `display: none` there is
   * what distinguishes the empty *answer* from the empty *interval before* an
   * answer.
   */
  "record-not-found": {
    tier: 2,
    by: "css",
    value: '#accountActivity:has(table#transactionTable[style*="display: none"]) p#noTransactions',
  },
  /**
   * ParaBank's own error regions: `#error` on the activity page, `#showError` on
   * the accounts overview. Both ship `display: none` and are revealed only by
   * the page's own failure handler, so the visibility gate does the rest.
   */
  "application-error": { tier: 2, by: "css", value: "#error, #showError" },
  /**
   * No landmark on this target, and deliberately not the one `SEVEN_CONDITIONS`
   * carries. That row locates a heading reading "Error!" — which on ParaBank is
   * the *generic* title of both error regions above, shown for a 500 as readily
   * as for anything else. Declaring it here would classify every server fault as
   * a business-class permission denial, and `detect` stops at the first row that
   * matches, so it would win over the honest classification below it. A wrong
   * answer beats no answer nowhere in this codebase.
   */
  "permission-denial": null,
};

/**
 * Spec §7's seven conditions, relocated onto this target. Derived from
 * `SEVEN_CONDITIONS` rather than rewritten, so the taxonomy has exactly one
 * definition and this file cannot quietly drop a row from it.
 */
export const PARABANK_CONDITIONS: ConditionDecl[] = SEVEN_CONDITIONS.map((decl) => {
  if (!Object.prototype.hasOwnProperty.call(LIVE_LANDMARKS, decl.id)) return decl;
  const landmark = LIVE_LANDMARKS[decl.id];
  // `exactOptionalPropertyTypes`: an absent `locate` and one holding `undefined`
  // are different types, so the key is dropped rather than assigned.
  const { locate: _replaced, ...rest } = decl;
  return landmark === null || landmark === undefined ? rest : { ...rest, locate: landmark };
});

/** The recorded artifact, read off disk and validated on the way in. */
export function loadRecordedCapability(root: string = process.cwd()): CapabilityArtifact {
  return loadCapability(root, PRODUCT, CAPABILITY_ID, CAPABILITY_VERSION);
}

export interface ReplayRun {
  result: ReplayResult;
  /**
   * The page the run left behind, still open. Returned because the interesting
   * assertions about a replay are about the *page* — a status of `success` is
   * equally consistent with a flow that did nothing — and a page closed by the
   * runner is a page no test can question.
   */
  page: Page;
  runId: string;
  logPath: string;
}

export interface ReplayRunOptions {
  args: Record<string, string>;
  runId?: string;
  /**
   * Run against the fresh page before the engine opens the entry URL — the only
   * hook there is, because the engine navigates to `bindings.entryUrl` itself.
   * It is how a test installs a route: this phase's hard-failure case has to
   * move the surface, and rewriting a served response is the way to do that
   * without touching the fixture database every other phase depends on.
   */
  prepare?: (page: Page) => Promise<void>;
  /** Close the page as soon as the result is in hand. For runs nobody will interrogate. */
  closePage?: boolean;
}

export interface ParabankTarget {
  run(opts: ReplayRunOptions): Promise<ReplayRun>;
  close(): Promise<void>;
}

/**
 * A browser holding one authenticated ParaBank session, able to replay the
 * recorded capability repeatedly.
 *
 * The session is acquired once and every run gets a fresh page from the same
 * context. That is not a shortcut: spec §5 says capabilities never
 * authenticate, and the artifact's `entryUrl` is `overview.htm`, which answers
 * 500 to an unauthenticated request. So a session is a precondition of replay
 * on this target rather than a step in it, and `ParabankSessionProvider` — the
 * one module in this codebase that ever sees a credential — is what supplies
 * it. What crosses back is a storage state: a session cookie, no credential.
 *
 * A fresh *page* per run, rather than a fresh context, is what makes the
 * stability harness honest: each run reloads the entry from the network and
 * re-resolves every control from scratch, while the login is paid for once.
 */
export async function openParabankTarget(
  opts: { evidenceDir?: string; base?: string } = {},
): Promise<ParabankTarget> {
  const base = opts.base ?? BASE;
  const artifact = loadRecordedCapability();
  const session = await new ParabankSessionProvider(base).acquire(PRODUCT, "local");

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({
      viewport: VIEWPORT,
      storageState: JSON.parse(session.storageState),
    });
  } catch (thrown) {
    await browser?.close();
    throw thrown;
  }
  const ctx = context;
  const br = browser;

  let sequence = 0;
  return {
    async run(runOpts: ReplayRunOptions): Promise<ReplayRun> {
      sequence += 1;
      const runId = runOpts.runId ?? `replay-e2e-${Date.now()}-${sequence}`;
      const log = opts.evidenceDir === undefined ? new RunLogger(runId) : new RunLogger(runId, opts.evidenceDir);
      const page = await ctx.newPage();
      if (runOpts.prepare !== undefined) await runOpts.prepare(page);

      const result = await replay({
        page,
        artifact,
        args: runOpts.args,
        policy: POLICY,
        log,
        conditions: PARABANK_CONDITIONS,
      });

      if (runOpts.closePage === true) await page.close();
      return { result, page, runId, logPath: log.path() };
    },
    async close(): Promise<void> {
      await br.close();
    },
  };
}

/**
 * The fixture database every phase depends on, read straight from ParaBank's
 * own REST service.
 *
 * Checked rather than asserted in prose: a run that had reached the admin
 * console's `Clean` button would leave this account gone or reset, so reading
 * the exact seeded value back is what makes "we never went near admin"
 * falsifiable. Same check `scripts/discover.mts` ends on, and the same value.
 */
export const SEED_ACCOUNT = "12345";
export const SEED_BALANCE = "-2300.00";

export async function readSeedAccount(base: string = BASE): Promise<string> {
  const res = await fetch(`${base}/services/bank/accounts/${SEED_ACCOUNT}`);
  return res.text();
}

export async function seedAccountIsIntact(base: string = BASE): Promise<boolean> {
  return (await readSeedAccount(base)).includes(`<balance>${SEED_BALANCE}</balance>`);
}
