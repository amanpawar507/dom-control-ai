// src/replay/result.ts

/**
 * What a replay writes down about itself, whatever the outcome. Threaded
 * through every result shape below rather than optional, so a caller can
 * always find the run that produced an answer without special-casing the
 * shape it came back as.
 *
 * Deliberately thin. `RunLogger` (`src/evidence/logger.ts`) owns the actual
 * append-only trail and is the only thing that can forge `runId` or `at` on
 * an entry; this is a pointer back into that trail, not a second copy of it.
 */
export interface Evidence {
  /** The id `RunLogger` was constructed with for this run. */
  runId: string;
  /** Where the full evidence trail for this run can be read back — `RunLogger.path()`. */
  logPath: string;
}

/**
 * Why a `failed` result is `failed`, named so an operator reading the result
 * — not the source — knows what kind of thing to go look at.
 *
 * The first four mirror `Corroboration["reason"]` in `src/replay/identity.ts`
 * one for one: those are the ways a control's binding can fail to name a
 * usable element, and a failed replay step is very often exactly that
 * corroboration coming back `ok: false`. Naming them identically here, rather
 * than folding them into one generic "resolution failed", is what lets a
 * caller map a `Corroboration` straight onto a `classification` with no
 * translation table to keep in sync.
 *
 *  - `no-match`             — nothing on the page answers the binding at all.
 *  - `ambiguous`             — more than one element does, and this codebase
 *    never takes the first of several.
 *  - `fingerprint-mismatch`  — something resolved, but is not the *kind* of
 *    thing the recording proved (§7's fingerprint rule).
 *  - `chain-disagreement`   — two independently-proven rungs now resolve to
 *    *different* elements: the surface drifted since recording, and neither
 *    answer can be trusted (Task 2's corroboration).
 *
 * Three more, belonging to replay rather than to resolution:
 *
 *  - `policy-refusal`  — `gate()` refused the action outright. Distinct from
 *    `escalated` below: an escalation is parked for a human because the risk
 *    is irreversible; a refusal has no human waiting on the other end of it —
 *    the allowlist or the approval gate said no, flatly, and there is nothing
 *    left to hand off.
 *  - `action-refused`  — the control resolved, the gate allowed it, and the
 *    page refused the action anyway (detached between resolving and acting,
 *    something covering it, the click timing out).
 *  - `hard`             — a condition declared hard in the artifact fired
 *    (`src/replay/conditions.ts`), or a recoverable one exhausted its bounded
 *    recovery (`src/replay/recover.ts`) without clearing.
 */
export type FailureKind =
  /**
   * The artifact cannot replay with these arguments, and that was knowable
   * without touching the page: a step names a control nothing binds, or a
   * recorded `$placeholder` has no argument to fill it. Distinct from every
   * kind below, which describe a *page* that did not behave — this one says the
   * request was never runnable, and no browser needed to prove it.
   */
  | "unreplayable"
  | "no-match"
  | "ambiguous"
  | "fingerprint-mismatch"
  | "chain-disagreement"
  | "policy-refusal"
  | "action-refused"
  | "hard";

/**
 * The four shapes a replay can end in, exactly as spec §7 declares them.
 *
 * ## Why a business outcome is not a failure
 *
 * "No such account" is the answer the caller asked for, not a crash — the
 * capability ran to completion and reported a legitimate business state. A
 * result type that made a caller unwrap `business_outcome` the way it unwraps
 * `failed` (a try/catch, a `.isErr()`) would make every caller write the same
 * unwrapping to get at an answer that was never an error, so the two are
 * siblings under `status` rather than one being a special case of the other.
 * `business_outcome` therefore carries `code` and `message` — the same shape
 * as a successful lookup that came back empty — and nothing about it implies
 * the run is a failure to inspect a stack trace for.
 *
 * ## Why `failed` cannot omit `observed`
 *
 * A `failed` result that stated only what it expected would tell an operator
 * what should have been true and nothing about what actually was — which
 * leaves them re-running the replay by hand to find out. `expected` and
 * `observed` are both required for exactly that reason: the difference
 * between them is the entire diagnostic, and a type that let one be dropped
 * would let a caller construct a failure report with half its content
 * missing and no compiler complaint.
 *
 * `TOut` defaults to `Record<string, string>` — every `extract` step's value
 * is text read off the page (`src/artifact/schema.ts`'s `ExtractStepSchema`),
 * so that is the shape a replay's declared outputs actually take absent a
 * caller who wants to narrow it further.
 */
export type ReplayResult<TOut = Record<string, string>> =
  | { status: "success"; outputs: TOut; evidence: Evidence }
  | { status: "business_outcome"; code: string; message: string; evidence: Evidence }
  | { status: "escalated"; interventionId: string; reason: string; evidence: Evidence }
  | {
      status: "failed";
      stepId: string;
      expected: string;
      observed: string;
      classification: FailureKind;
      evidence: Evidence;
    };
