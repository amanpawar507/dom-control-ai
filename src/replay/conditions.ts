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
 * `locate` is absent only for `transient-slowness` in `SEVEN_CONDITIONS`
 * below — see the note there for why that one condition has no landmark to
 * look for.
 */
export interface ConditionDecl {
  id: string;
  class: ConditionClass;
  code: string;
  message: string;
  locate?: Strategy;
}

/**
 * Whether a declared condition is confirmed present, checked in declaration
 * order and stopping at the first hit.
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

export async function detectWithDiagnostics(
  page: Page,
  declared: ConditionDecl[],
): Promise<DetectionDiagnostics> {
  const ambiguous: string[] = [];
  const unmatched: string[] = [];

  for (const decl of declared) {
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
 * These `locate` values are illustrative declarations of the *shape* each
 * condition takes, grounded where a fixture confirms the real markup
 * (`tests/fixtures/parabank/*.html`) and left as reasonable placeholders
 * where it does not — this phase has no live network access to verify
 * against the running container (see the phase constraints). A capability
 * recorded by a live discovery run would supply the actual selectors; what
 * this table pins is that the taxonomy is complete and classified correctly,
 * per the third test below, not that every selector has been checked against
 * a browser.
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
    // tests/fixtures/parabank/findtrans.html: `<div id="errorContainer"
    // style="display: none;">`, shown when a search comes back empty or fails.
    locate: { tier: 2, by: "css", value: "#errorContainer" },
  },
  {
    id: "permission-denial",
    class: "business",
    code: "PERMISSION_DENIED",
    message: "The account is not permitted to perform this action.",
    locate: { tier: 1, by: "role", role: "heading", name: "Error!" },
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
    // tests/fixtures/parabank/transfer.html: `<div id="showError" style="display:
    // none;">`, shown by the page's own `showError` handler on a failed XHR;
    // referenced in src/e2e/phase1-smoke.ts's own comment on the same element.
    locate: { tier: 2, by: "css", value: "#showError" },
  },
];
