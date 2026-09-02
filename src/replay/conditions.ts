// src/replay/conditions.ts
import type { Page } from "playwright";
import { resolveBinding } from "../surface/playwright-web/resolver.js";
import type { Strategy } from "../surface/types.js";

/**
 * Spec §7's table has three columns that matter here: what a condition
 * *means*, not how it was found or what to do about it (that is
 * `src/replay/recover.ts`'s job for the four `recoverable` rows).
 *
 *  - `business`    — a legitimate answer the flow can end on. Terminal, and
 *    not a failure: "no such account" is the caller's question, answered.
 *  - `recoverable` — an exceptional state the replay can plausibly clear on
 *    its own, bounded by `maxAttempts` (`recover.ts`).
 *  - `hard`        — reachable only as an outcome, never as a value declared
 *    directly on one of the seven rows below (see `SEVEN_CONDITIONS`): it is
 *    what a `recoverable` condition becomes once its bounded recovery is
 *    exhausted without clearing, not a detection category of its own.
 */
export type ConditionClass = "business" | "recoverable" | "hard";

/** What `detect` reports once a declared condition is confirmed present on the page. */
export interface DetectedCondition {
  id: string;
  class: ConditionClass;
  code: string;
  message: string;
}

/**
 * One row of the artifact's declared taxonomy. `message` is part of the
 * declaration, not text scraped off the page at detection time — the same
 * discipline `CheckpointStepSchema` applies to `state` (`src/artifact/schema.ts`):
 * a detector reports that the *shape* it was told to look for is there, and
 * the words a caller sees are the ones the artifact author chose, not
 * whatever happens to be rendered this run.
 *
 * `locate` is optional, and a row without one is a condition this target has no
 * verified landmark for. Two rows in `SEVEN_CONDITIONS` below go without:
 * `transient-slowness`, whose signal is a budget expiring rather than a node,
 * and `permission-denial`, which this application does not distinguish from any
 * other fault. Both notes are at the rows.
 */
export interface ConditionDecl {
  id: string;
  class: ConditionClass;
  code: string;
  message: string;
  locate?: Strategy;
}

/**
 * Whether a declared condition is confirmed present, checked in
 * fault-before-answer order and stopping at the first hit.
 *
 * ## Visibility-gating, and why this delegates rather than re-implements it
 *
 * Spec §7 makes this non-negotiable after finding that the target ships
 * hidden success *and* error nodes in its accessibility tree: a detector that
 * fires on a hidden "Account not found" reports a business outcome for a page
 * displaying nothing of the sort, and whatever acts on that result is acting
 * on an answer nobody ever saw.
 *
 * This function does not check visibility itself — it calls `resolveBinding`
 * (`src/surface/playwright-web/resolver.js`), the same choke point every
 * replay-time targeting decision goes through, and which already filters
 * every tier's candidates through `filterRendered` before deciding anything
 * (see the comment on that loop in resolver.ts). That is "the SAME predicate
 * the resolver uses" by construction rather than by two authors agreeing to
 * keep two copies in sync — there is only one copy, and this is not it.
 * Writing a second visibility check here, even one that meant to agree,
 * would be exactly the kind of fourth copy `tests/observe/visibility-drift.test.ts`
 * exists to catch if it ever drifted from the other three.
 *
 * ## Why "resolved" rather than "exactly one match" is the bar
 *
 * `resolveBinding`'s `ok: true` already means "exactly one rendered element
 * answers this", so an ambiguous or absent match both read as "not present"
 * here — a condition whose declared landmark now matches nothing, or matches
 * several things, is not confidently confirmed and this abstains rather than
 * guessing. That is a narrower bar than the codebase's "exactly one match, or
 * fail" for *acting* — this function only ever answers a yes/no question and
 * selects no element to click, fill or extract from, so there is no "which
 * one" to get wrong the way an action would.
 *
 * `fingerprintHolds` inside `resolveBinding` is a no-op here: no
 * `ConditionDecl` declares a fingerprint, so every rung's shape check passes
 * trivially and the only thing being asked is "does this exist, rendered".
 *
 * ## Why a business row can never outrank a non-business one
 *
 * See `orderedForDetection` below. First-match-wins is a tie-break between
 * rows of equal standing, and business rows do not have equal standing with
 * the rest: a `business` result is a claim that the call *succeeded* and is
 * carrying an answer, so it must not be produced while the page is also
 * showing evidence that it did not.
 */
export async function detect(page: Page, declared: ConditionDecl[]): Promise<DetectedCondition | null> {
  return (await detectWithDiagnostics(page, declared)).detected;
}

/**
 * What `detect` concluded, plus why each landmark that did not fire failed to.
 *
 * `detect` answers a yes/no question and that is all a caller deciding what to
 * do next needs. But "no condition is present" and "this detector no longer
 * works" are different facts, and the yes/no answer is identical for both — a
 * capability whose `record-not-found` landmark has drifted into matching two
 * nodes stops reporting that outcome, silently, and every run afterwards looks
 * like a clean pass.
 *
 * So the split is reported rather than inferred:
 *
 *  - `ambiguous` — the landmark resolved to more than one rendered element.
 *    Almost always means the selector has gone too broad to still mean what it
 *    meant, which is why abstaining is right and why it is worth saying so.
 *  - `unmatched` — the landmark matched nothing. Ordinary when the condition
 *    is simply absent, and indistinguishable from a landmark that has been
 *    removed from the page altogether, which is exactly why the engine logs it
 *    rather than deciding.
 *
 * Neither changes the verdict. This function only makes the abstention
 * visible; nothing here fires a condition that `detect` would not.
 */
export interface DetectionDiagnostics {
  detected: DetectedCondition | null;
  ambiguous: string[];
  unmatched: string[];
}

/**
 * The declared rows, reordered so that every non-`business` row is checked
 * before every `business` one, with declaration order preserved inside each
 * group.
 *
 * The two classes answer different questions and only one of them is a claim
 * about the *call*. A `recoverable` row says the application is in an
 * exceptional state; a `business` row says the application answered, and the
 * answer is this code. So when a fault landmark and an answer landmark are both
 * on the page, the fault is the only one of the two that can be true — an
 * application that has just rendered its own internal-error banner has not
 * answered anybody's question, and reporting `RECORD_NOT_FOUND` off the back of
 * it hands the caller a fabricated answer that nothing downstream can tell from
 * a real one. That is strictly worse than an honest failure, which is the same
 * reason `detect` abstains on an ambiguous landmark rather than guessing.
 *
 * Ordering is a *second* line, not the fix on its own: a business row whose
 * landmark points at markup that means something else is still wrong when it is
 * the only row that matches, which is why the table below carries the rule that
 * a business row's landmark must be verified to mean that outcome and nothing
 * else. This is what stops the next author's table from re-earning the same
 * defect by declaring their business rows first.
 */
function orderedForDetection(declared: ConditionDecl[]): ConditionDecl[] {
  return [...declared.filter((d) => d.class !== "business"), ...declared.filter((d) => d.class === "business")];
}

export async function detectWithDiagnostics(
  page: Page,
  declared: ConditionDecl[],
): Promise<DetectionDiagnostics> {
  const ambiguous: string[] = [];
  const unmatched: string[] = [];

  for (const decl of orderedForDetection(declared)) {
    if (decl.locate === undefined) continue;
    const res = await resolveBinding(page, { scope: [], chain: [decl.locate] }, {});
    if (res.ok) {
      return { detected: { id: decl.id, class: decl.class, code: decl.code, message: decl.message }, ambiguous, unmatched };
    }
    if (res.reason === "ambiguous") ambiguous.push(decl.id);
    else unmatched.push(decl.id);
  }

  return { detected: null, ambiguous, unmatched };
}

/**
 * Spec §7's runtime-conditions table, one row per declared condition —
 * 3 `business`, 4 `recoverable`, matching the table exactly. The mechanism
 * `detect` applies is uniform; this is the data half, and where it is
 * grounded in a real element on this target that is noted per row.
 *
 * ## A business row may not carry a placeholder landmark
 *
 * The rule this table did not have, and the one that let the original version
 * report ParaBank's internal-error banner as `RECORD_NOT_FOUND`: a
 * **business** row's landmark must be verified to mean that outcome *and
 * nothing else*, and ships without a `locate` when nothing on the target
 * qualifies. A recoverable row can afford an approximate landmark — the worst
 * it produces is a bounded recovery attempt and then an honest failure. A
 * business row cannot: it ends the run reporting that the application answered
 * and this is the answer, so a landmark that only *resembles* the outcome
 * manufactures a wrong answer, and a wrong answer is the one failure nothing
 * downstream can detect. `record-not-found` was pointed at `#errorContainer`
 * and `permission-denial` at a heading reading "Error!" — which are, on this
 * target, both halves of the same internal-error region
 * (`tests/fixtures/parabank/findtrans.html:202`, `transfer.html:116`), shown
 * for a 500 as readily as for anything else.
 *
 * Every `locate` below is now checked against this target rather than inferred:
 * against the captured markup under `tests/fixtures/parabank/` where a fixture
 * exists, and against the running container where one does not (the pages the
 * recorded capability actually walks have no fixture — see the per-row notes).
 * A capability recorded elsewhere would supply its own selectors; what this
 * table pins is that the taxonomy is complete, classified correctly, and that
 * no row here claims a meaning its landmark does not have.
 */
export const SEVEN_CONDITIONS: ConditionDecl[] = [
  {
    id: "validation-error",
    class: "business",
    code: "VALIDATION_ERROR",
    message: "The submitted value failed validation.",
    // tests/fixtures/parabank/transfer.html: `<p id="amount.errors" class="error"
    // style="display: none;">`, shown by the page's own script on a bad amount.
    locate: { tier: 2, by: "css", value: '[id="amount.errors"]' },
  },
  {
    id: "record-not-found",
    class: "business",
    code: "RECORD_NOT_FOUND",
    message: "No matching record was found.",
    /**
     * The application answering "there are none", in its own words and by its
     * own branch: on an empty result ParaBank shows `#noTransactions` and hides
     * `#transactionTable`. Verified against the running container — the account
     * activity page carries no fixture, because it is the page the recorded
     * capability walks and was captured as a binding rather than as markup.
     *
     * Both halves are in the selector on purpose. `#noTransactions` alone is
     * *shipped visible* in the activity page's markup and stays visible until
     * the page's first XHR returns, so a detector keyed on it fires during the
     * load of a perfectly ordinary page and a run that clicked through to an
     * account would report "no records" before it had asked anything. The
     * transaction table carries no inline style until jQuery hides it, so
     * requiring `display: none` there is what distinguishes the empty *answer*
     * from the empty *interval before* an answer.
     *
     * What this is deliberately NOT: `#errorContainer`, which the first version
     * of this row declared. That region is `<h1>Error!</h1><p>An internal error
     * has occurred and has been logged.</p>` (findtrans.html:202) and is shown
     * by the page's own handler on any non-404 response — the 404, which is the
     * empty answer, takes the other branch entirely (findtrans.html:238-241).
     * It belongs to `application-error` below, and it is there.
     */
    locate: {
      tier: 2,
      by: "css",
      value: '#accountActivity:has(table#transactionTable[style*="display: none"]) p#noTransactions',
    },
  },
  {
    id: "permission-denial",
    class: "business",
    code: "PERMISSION_DENIED",
    message: "The account is not permitted to perform this action.",
    // No `locate`, and the second row in this table to go without one. This
    // target has no landmark that means "not permitted": it answers an
    // unauthorised request with the same generic internal-error region as
    // anything else, whose only distinguishing text is the title "Error!". A
    // heading-named landmark was declared here and it matched that region on
    // both captured fixtures — classifying every server fault as a business
    // outcome. Under the rule at the head of this table a business row with
    // nothing verified to point at ships pointing at nothing, so a caller whose
    // application *does* distinguish the two declares it and this one abstains.
  },
  {
    id: "unexpected-dialog",
    class: "recoverable",
    code: "UNEXPECTED_DIALOG",
    message: "A dialog appeared that the recorded flow did not declare.",
    locate: { tier: 2, by: "css", value: '[role="dialog"]' },
  },
  {
    id: "session-expiry",
    class: "recoverable",
    code: "SESSION_EXPIRED",
    message: "The application returned a login screen where a checkpoint was expected.",
    // tests/fixtures/parabank/login.html: `<div id="loginPanel">` wrapping the
    // username/password form — the same page ParabankSessionProvider signs
    // into (src/session/playwright-state.ts).
    locate: { tier: 2, by: "css", value: "#loginPanel" },
  },
  {
    id: "transient-slowness",
    class: "recoverable",
    code: "TRANSIENT_SLOWNESS",
    message: "The expected checkpoint did not appear within its budget.",
    // No `locate`, deliberately. Every other row is a landmark that *appears*
    // — an error region, a dialog, a login form — but this one is the absence
    // of the checkpoint the flow was already waiting on, not a new node
    // anywhere on the page. This target's fixtures carry no loading/spinner
    // markup to point at (checked, not assumed), and inventing one would
    // declare a selector this detector could never honestly match. The
    // signal here is a budget expiring on a wait already in progress, which
    // is the caller's (the engine's, and `recover.ts`'s bounded re-wait)
    // concern rather than a landmark `detect` can look for. It stays in this
    // table because spec §7 still classifies it, and the classification test
    // below needs it counted.
  },
  {
    id: "application-error",
    class: "recoverable",
    code: "APPLICATION_ERROR",
    message: "The application displayed an internal error banner.",
    /**
     * All three ids this target spells its one internal-error region with, and
     * every page the replay can be on is covered by one of them: `#showError`
     * on the accounts overview and the transfer page
     * (`tests/fixtures/parabank/transfer.html:116`, referenced by
     * `src/e2e/phase1-smoke.ts`), `#errorContainer` on find-transactions
     * (`findtrans.html:202`), `#error` on account activity. All three ship
     * `display: none` and are revealed only by the page's own failure handler,
     * so the visibility gate does the rest; all three were confirmed present
     * on the running container, one per page, so the union cannot resolve
     * ambiguously.
     *
     * Two of them used to belong to business rows above. This is where the
     * honest classification of a stack trace lives: `recoverable`, so §7's
     * renavigate response is reachable, and never an answer.
     */
    locate: { tier: 2, by: "css", value: "#error, #showError, #errorContainer" },
  },
];
