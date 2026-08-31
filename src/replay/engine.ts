// src/replay/engine.ts
import type { Page } from "playwright";
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { RunLogger } from "../evidence/logger.js";
import { gate, type PolicyConfig } from "../policy/gate.js";
import { controlNamesFor } from "../surface/playwright-web/actor.js";
import { HANDLE_ATTR, locatorFor } from "../surface/playwright-web/resolver.js";
import { filterRendered } from "../observe/visibility.js";
import { resolveCorroborated, type Corroboration } from "./identity.js";
import type { Binding, Strategy } from "../surface/types.js";
import { detectWithDiagnostics, SEVEN_CONDITIONS, type ConditionDecl, type DetectedCondition } from "./conditions.js";
import { recover, type RecoveryDecl } from "./recover.js";
import type { Evidence, FailureKind, ReplayResult } from "./result.js";
import type { SessionProvider } from "../session/provider.js";

/**
 * How long a single action may take before it is called a failure. Playwright's
 * default is 30s per action; a long flow at that default can outlive any
 * sensible wall-clock expectation while never once consulting one. §7's fourth
 * resolution rule is "condition-based waits with explicit budgets", and an
 * unbounded action is neither.
 */
const DEFAULT_ACTION_BUDGET_MS = 10_000;

/**
 * What a run is expected to cost in wall-clock time, absent a caller-supplied
 * figure. Ten minutes to match spec §7's discovery wall clock — the same
 * order of magnitude expectation, on the same kind of run. Purely evidentiary
 * here: unlike discovery's `wallClockMs`, replay does not stop at this
 * figure — it is what the logged run summary is compared against, so a run
 * that blew past its expectation is a fact the trail carries rather than a
 * number nobody wrote down.
 */
const DEFAULT_WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;

export interface ReplayOptions {
  page: Page;
  artifact: CapabilityArtifact;
  args: Record<string, string>;
  policy: PolicyConfig;
  log: RunLogger;
  /** Declared runtime conditions. Defaults to spec §7's table. */
  conditions?: ConditionDecl[];
  /** Declared recoveries, keyed by the condition id they answer. */
  recoveries?: Record<string, RecoveryDecl>;
  actionBudgetMs?: number;
  /**
   * How many times a recoverable condition may be answered before the run
   * escalates. Bounded by construction — spec §7: an unbounded retry is a hang
   * wearing a costume.
   */
  maxRecoveryAttempts?: number;
  /**
   * How long a checkpoint may take to appear. A page that fills asynchronously
   * has not failed merely because it has not finished — §7 classes that as
   * transient slowness and allows one bounded re-wait.
   */
  checkpointBudgetMs?: number;
  /**
   * How long any *other* control may take to appear before the step naming it
   * is called a failure. Defaults to `actionBudgetMs`, on the reasoning that a
   * caller who has said how long an action may take has said how patient this
   * run is allowed to be.
   *
   * Only checkpoints waited before. Every step that names a control waits now,
   * which is what §7's "condition-based waits with explicit budgets" asks for
   * and what the checkpoint path was already doing alone: a control that is not
   * on the page *yet* is the transient-slowness case, and there is no reason
   * `extract` should be less patient than `checkpoint` about the same page.
   *
   * A note on what this is NOT justified by, because the first version of this
   * comment claimed it and the claim does not survive measurement. The
   * reference target fills its accounts table from an XHR, and it is tempting
   * to say the table is empty when `page.goto` resolves. It is not: `goto`
   * waits for `load`, and the table measures 12 rows by then. The wait earns
   * its place on the general principle, not on that application's behaviour,
   * and `tests/replay/engine.test.ts` covers it with a page that genuinely adds
   * a control late — which is the only honest way to show it is load-bearing.
   */
  controlBudgetMs?: number;
  /** Supplied when a declared recovery needs to re-authenticate. */
  session?: SessionProvider;
  /**
   * The clock the run summary's elapsed time is measured against, injectable
   * for the same reason `discover()` (`src/discover/loop.ts`) takes one: a
   * test proving a timing property must not sleep to prove it. Defaults to
   * `Date.now`.
   */
  now?: () => number;
  /** See `DEFAULT_WALL_CLOCK_BUDGET_MS`. */
  wallClockBudgetMs?: number;
}

/** `$name` — the same placeholder shape the recorder writes for a parameterised value. */
const PLACEHOLDER = /^\$([A-Za-z_]\w*)$/;

/**
 * Replay a recorded capability with no model in the loop.
 *
 * Three properties hold across every path below, and each is a property the
 * result alone cannot demonstrate — which is why the tests assert against the
 * page rather than the status.
 *
 * **Nothing is acted on before the gate allows it.** The verdict is taken from
 * the same `gate()` every other engine calls, keyed on the names read off the
 * resolved element rather than on anything the artifact claims about it.
 *
 * **Nothing is acted on that the chain does not agree about.** Resolution goes
 * through `resolveCorroborated`, not `resolveBinding`: every rung of a recorded
 * chain was independently proven at record time to name the *same* element, so
 * two rungs disagreeing now is evidence the surface moved. That is a failure
 * rather than a choice between two answers — and it is the whole reason this
 * phase exists, because record-time proving had no replay-time counterpart.
 *
 * **A run that stops, stops.** A business outcome ends the walk. The status
 * alone cannot show that; a step after the triggering one, left unexecuted, can.
 *
 * A fourth property holds across every path but is not demonstrated by any of
 * the three above: **the run writes down what it cost.** Replay spends no
 * model tokens, but every path — success, business outcome, escalation, or
 * failure — ends in a `replay.summary` event carrying elapsed time against
 * `wallClockBudgetMs`. It is logged once, from this outer wrapper, so no
 * return path inside `execute` below can omit it.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const now = opts.now ?? Date.now;
  const wallClockBudgetMs = opts.wallClockBudgetMs ?? DEFAULT_WALL_CLOCK_BUDGET_MS;
  const startedAt = now();
  const result = await execute(opts);
  const elapsedMs = now() - startedAt;
  opts.log.log({
    kind: "replay.summary",
    status: result.status,
    elapsedMs,
    wallClockBudgetMs,
    overBudget: elapsedMs > wallClockBudgetMs,
  });
  return result;
}

/** The walk itself. Factored out of `replay` so the summary above is logged exactly once, from a single return point, regardless of which of `execute`'s many internal returns produced the result. */
async function execute(opts: ReplayOptions): Promise<ReplayResult> {
  const { page, artifact, args, policy, log } = opts;
  const conditions = opts.conditions ?? SEVEN_CONDITIONS;
  const recoveries = opts.recoveries ?? {};
  const actionBudgetMs = opts.actionBudgetMs ?? DEFAULT_ACTION_BUDGET_MS;
  const checkpointBudgetMs = opts.checkpointBudgetMs ?? DEFAULT_ACTION_BUDGET_MS;
  const controlBudgetMs = opts.controlBudgetMs ?? actionBudgetMs;
  const { entryUrl, controls } = artifact.bindings;

  const evidence: Evidence = { runId: log.runId, logPath: log.path() };
  const outputs: Record<string, string> = {};
  /**
   * The most recent checkpoint that held. Session-expiry recovery re-verifies
   * it before resuming — resuming without re-verifying assumes the page came
   * back to where it was, and that assumption is what makes a resumed run act
   * on the wrong screen.
   */
  let lastCheckpoint: Strategy | undefined;

  // Argument *names* only. The values are the ones discovery refused to record
  // as literals precisely so a credential could not reach an artifact; logging
  // them here would undo that at the sink instead of in the file.
  log.log({ kind: "replay.start", capability: artifact.capability.id, entryUrl, args: Object.keys(args) });

  const fail = (stepId: string, expected: string, observed: string, classification: FailureKind): ReplayResult => {
    log.log({ kind: "replay.failed", stepId, expected, observed, classification });
    return { status: "failed", stepId, expected, observed, classification, evidence };
  };

  // Everything checkable without a browser is checked before one is opened.
  //
  // A step naming an unbound control, or a `$placeholder` with no argument, is
  // a request that was never runnable — no page can make it runnable, and every
  // action taken before discovering it is one taken for a run that was always
  // going to fail. Finding it here means a caller who got the arguments wrong
  // has changed nothing.
  for (const [index, step] of artifact.flow.steps.entries()) {
    if (step.kind === "navigate") continue;
    const id = step.kind === "act" ? `s${index + 1}:${step.action}:${step.control}` : `s${index + 1}:${step.kind}:${step.control}`;
    if (controls[step.control] === undefined) {
      return fail(id, `a binding for control "${step.control}"`, `the artifact binds no control named "${step.control}"`, "unreplayable");
    }
    if (step.kind === "act" && (step.action === "fill" || step.action === "select")) {
      if (resolveArg(step.value, args) === null) {
        return fail(id, `an argument for ${step.value}`, `no argument named "${step.value.slice(1)}" was supplied`, "unreplayable");
      }
    }
  }

  // The entry is an action like any other, and is gated like one. An artifact
  // that names an entry the caller's policy forbids is one that cannot legally
  // run for this caller — a verdict that belongs here, at replay, and not to
  // the schema that recorded it.
  const entryVerdict = gate(policy, { url: entryUrl, action: "navigate", controlNames: [] });
  log.log({ kind: "replay.gate", step: "entry", action: "navigate", verdict: entryVerdict });
  if (entryVerdict.decision !== "allow") {
    if (entryVerdict.decision === "escalate") {
      log.log({ kind: "replay.escalated", step: "entry", reason: entryVerdict.reason });
      return { status: "escalated", interventionId: `${log.runId}:entry`, reason: entryVerdict.reason, evidence };
    }
    return fail("entry", `navigate to ${entryUrl}`, entryVerdict.reason, "policy-refusal");
  }
  try {
    await page.goto(entryUrl, { timeout: actionBudgetMs });
  } catch (thrown) {
    return fail("entry", `navigate to ${entryUrl}`, (thrown as Error).message, "hard");
  }

  for (const [index, step] of artifact.flow.steps.entries()) {
    // Named, not numbered. `s2` tells whoever reads a failure nothing they did
    // not already have; `s2:click:find_button` tells them which step of which
    // recorded flow to go and look at, without opening the artifact.
    const stepId =
      step.kind === "act"
        ? `s${index + 1}:${step.action}:${step.control}`
        : step.kind === "navigate"
          ? `s${index + 1}:navigate`
          : `s${index + 1}:${step.kind}:${step.control}`;

    if (step.kind === "navigate") {
      const url = new URL(step.url, entryUrl).href;
      const verdict = gate(policy, { url, action: "navigate", controlNames: [] });
      log.log({ kind: "replay.gate", step: stepId, action: "navigate", verdict });
      if (verdict.decision === "escalate") {
        log.log({ kind: "replay.escalated", step: stepId, reason: verdict.reason });
        return { status: "escalated", interventionId: `${log.runId}:${stepId}`, reason: verdict.reason, evidence };
      }
      if (verdict.decision !== "allow") return fail(stepId, `navigate to ${url}`, verdict.reason, "policy-refusal");
      try {
        await page.goto(url, { timeout: actionBudgetMs });
      } catch (thrown) {
        return fail(stepId, `navigate to ${url}`, (thrown as Error).message, "hard");
      }
      const afterNav = await runDetection(stepId);
      if (afterNav !== null) return afterNav;
      continue;
    }

    // Every remaining step names a control, and a control the artifact does not
    // bind is not a thing to guess at.
    const binding = controls[step.control];
    if (binding === undefined) {
      return fail(stepId, `a binding for control "${step.control}"`, "the artifact binds no such control", "no-match");
    }

    // Every step that names a control gets a bounded chance for that control to
    // arrive before it is called absent. The wait is on Playwright's own
    // condition against a rung of the recorded chain — resolution then decides
    // identity over the *whole* chain, so waiting cannot become a second way to
    // pick an element: nothing here reads which element the wait settled on.
    //
    // It waits on the first rung that can be expressed as a locator rather than
    // on `chain[0]`, because an anchor rung is geometry rather than a selector
    // and has no Playwright condition to wait on. Chains are ordered by
    // record-time reliability and this target's are frequently anchor-first, so
    // keying the wait on `chain[0]` meant the controls most likely to need a
    // wait were the ones that never got one.
    const waitOn = binding.chain.find((rung) => rung.by !== "anchor");
    if (waitOn !== undefined) {
      await locatorFor(page, waitOn, args)
        .first()
        .waitFor({ state: "visible", timeout: step.kind === "checkpoint" ? checkpointBudgetMs : controlBudgetMs })
        .catch(() => undefined);
    }

    const corr = await resolveCorroborated(page, normaliseBinding(binding), args);
    log.log({
      kind: "replay.resolved",
      step: stepId,
      control: step.control,
      ok: corr.ok,
      ...(corr.ok ? { tier: corr.tier, agreed: corr.agreed } : { reason: corr.reason, disagreeingTiers: corr.disagreeingTiers ?? [] }),
    });
    if (!corr.ok) {
      // What was seen, in words. `no-match` names the failure kind; it does not
      // tell the person reading it what the page did, and that is the field's
      // whole job.
      const observed =
        step.kind === "checkpoint"
          ? `waited out the ${checkpointBudgetMs}ms checkpoint budget for "${step.control}" to be ${step.state} and it never was — ${describeResolution(corr, step.control)}`
          : describeResolution(corr, step.control);
      const classification: FailureKind = step.kind === "checkpoint" ? "hard" : corr.reason;
      return fail(stepId, `control "${step.control}" to resolve`, observed, classification);
    }

    const loc = page.locator(`[${HANDLE_ATTR}="${corr.handle}"]`);

    if (step.kind === "checkpoint") {
      // A checkpoint is verified, never asserted. `state: "visible"` is the only
      // state the recorder can produce, and this is what makes the artifact's
      // claim checkable rather than decorative.
      const rendered = (await filterRendered(await loc.all())).length === 1;
      log.log({ kind: "replay.checkpoint", step: stepId, control: step.control, state: step.state, held: rendered });
      if (!rendered) {
        return fail(stepId, `${step.control} to be ${step.state}`, "it resolved but is not rendered", "hard");
      }
      lastCheckpoint = binding.chain[0];
      const afterCheck = await runDetection(stepId);
      if (afterCheck !== null) return afterCheck;
      continue;
    }

    if (step.kind === "extract") {
      const value = ((await loc.textContent()) ?? "").trim() || (await loc.inputValue().catch(() => ""));
      outputs[step.as] = value;
      // The name of the output, never the value: an extracted value is the
      // caller's answer and may be exactly the sort of thing that must not sit
      // in a log.
      log.log({ kind: "replay.extract", step: stepId, control: step.control, as: step.as });
      continue;
    }

    // An action. Names come off the element, so a risk rule keyed on a control
    // name judges what is really there rather than what the artifact says.
    const controlNames = await controlNamesFor(loc);
    const verdict = gate(policy, { url: page.url(), action: step.action, controlNames });
    log.log({ kind: "replay.gate", step: stepId, action: step.action, control: step.control, controlNames, verdict });
    if (verdict.decision === "escalate") {
      log.log({ kind: "replay.escalated", step: stepId, reason: verdict.reason });
      return { status: "escalated", interventionId: `${log.runId}:${stepId}`, reason: verdict.reason, evidence };
    }
    if (verdict.decision !== "allow") {
      return fail(stepId, `to ${step.action} ${step.control}`, verdict.reason, "policy-refusal");
    }

    let value: string | undefined;
    if (step.kind === "act" && (step.action === "fill" || step.action === "select")) {
      const bound = resolveArg(step.value, args);
      if (bound === null) {
        // Typing a literal `$account` into a bank field is worse than stopping:
        // it is a value nobody chose, entered where a real one was meant.
        return fail(stepId, `an argument for ${step.value}`, "no such argument was supplied", "action-refused");
      }
      value = bound;
    }

    try {
      if (step.action === "click") await loc.click({ timeout: actionBudgetMs });
      else if (step.action === "fill") await loc.fill(value ?? "", { timeout: actionBudgetMs });
      else await loc.selectOption(value ?? "", { timeout: actionBudgetMs });
    } catch (thrown) {
      return fail(stepId, `to ${step.action} ${step.control}`, (thrown as Error).message, "hard");
    }
    log.log({ kind: "replay.acted", step: stepId, action: step.action, control: step.control });

    const after = await runDetection(stepId);
    if (after !== null) return after;
  }

  log.log({ kind: "replay.success", outputs: Object.keys(outputs) });
  return { status: "success", outputs, evidence };

  /**
   * Look for a declared condition, and record what the landmarks did even when
   * none fires.
   *
   * `detect` abstains when a landmark is ambiguous or absent — deliberately,
   * because a landmark that has gone broad no longer means what it meant, and a
   * business outcome reported on that evidence is a wrong *answer* rather than
   * an honest failure. But abstention is invisible in the result: the run
   * succeeds either way. So "condition absent" and "detector broken" are
   * written down separately, because an operator reading a run needs them told
   * apart and only one of them is drift.
   */
  async function runDetection(stepId: string): Promise<ReplayResult | null> {
    const { detected, ambiguous, unmatched } = await detectWithDiagnostics(page, conditions);
    log.log({ kind: "replay.detect", step: stepId, detected, ambiguous, unmatched });
    if (detected === null) return null;

    if (detected.class === "business") {
      // Not a failure. "No such account" is the answer the caller asked for,
      // and a contract that reports it as a crash makes every caller unwrap it.
      log.log({ kind: "replay.business_outcome", step: stepId, code: detected.code });
      return { status: "business_outcome", code: detected.code, message: detected.message, evidence };
    }

    if (detected.class === "recoverable") {
      // "Recoverable" describes the condition, not the situation. A condition
      // nobody declared an answer for is one this run cannot recover from, and
      // saying so is more useful than paging a human to read the same message.
      // Spec §7's own recoverable rows end at hard failure when the recovery is
      // exhausted; having none declared is that, with zero attempts.
      const decl = recoveryFor(detected);
      if (decl === undefined) {
        return fail(stepId, "no runtime condition, or a declared recovery for one", `${detected.code}: ${detected.message}`, "hard");
      }
      // A recovery reporting success is a claim about what it did, not about
      // what the page now shows. A session provider can refresh a token
      // perfectly and leave the login screen exactly where it was — and every
      // step after that would run against it. So the condition itself is the
      // test: recovery worked when the thing that triggered it is gone.
      const budget = opts.maxRecoveryAttempts ?? 1;
      let attempted = 0;
      for (let attempt = 1; attempt <= budget; attempt++) {
        const outcome = await recover(page, decl, {
          maxAttempts: 1,
          ...(opts.session === undefined ? {} : { session: opts.session }),
          policy,
        });
        attempted += outcome.tried;
        const still = (await detectWithDiagnostics(page, conditions)).detected;
        const cleared = still === null || still.id !== detected.id;
        log.log({ kind: "replay.recover", step: stepId, condition: detected.id, attempt, ...outcome, cleared });
        if (outcome.recovered && cleared) return null;
      }
      return fail(
        stepId,
        `to recover from ${detected.code}`,
        `${detected.code}: recovery ran ${attempted} time(s) and the condition was still present`,
        "hard",
      );
    }

    return fail(stepId, "no application error", detected.message, "hard");
  }

  /**
   * The recovery declared for a condition, if any.
   *
   * A caller who supplies a `SessionProvider` has declared an answer to session
   * expiry by supplying it — the provider *is* the recovery, and requiring a
   * second declaration alongside it would be ceremony. Everything else must be
   * declared explicitly, because there is no equivalent object that means
   * "and here is how to dismiss that dialog".
   */
  function recoveryFor(detected: DetectedCondition): RecoveryDecl | undefined {
    const declared = recoveries[detected.id];
    if (declared !== undefined) return declared;
    if (detected.id === "session-expiry" && opts.session !== undefined) {
      const decl = conditions.find((c) => c.id === "session-expiry");
      const checkpoint = lastCheckpoint ?? decl?.locate;
      if (checkpoint !== undefined && decl !== undefined) {
        return { kind: "session-expiry", condition: decl, checkpoint };
      }
    }
    return undefined;
  }
}

/**
 * Why a resolution failed, in the words of what the page did.
 *
 * `corr.reason` is a classification and belongs in `classification`; a person
 * reading `observed` wants to know what was actually seen. `chain-disagreement`
 * names both sides, because the whole value of the disagreement is knowing
 * which two rungs to go and compare.
 */
function describeResolution(corr: Extract<Corroboration, { ok: false }>, control: string): string {
  switch (corr.reason) {
    case "no-match":
      return `no rung of the chain for "${control}" resolved to anything on this page`;
    case "ambiguous":
      return `a rung of the chain for "${control}" matched several elements, and this never picks one of several`;
    case "fingerprint-mismatch":
      return `"${control}" resolved to an element that is no longer the kind of thing that was recorded`;
    case "chain-disagreement": {
      const others = (corr.disagreeingTiers ?? []).map((n) => `tier ${n}`).join(", ");
      return `the rungs for "${control}" disagreed about which element it is: tier ${corr.tier ?? "?"} named one element, ${others} named another`;
    }
  }
}

/** `$name` resolves from `args`; anything else is a literal the recorder wrote. */
function resolveArg(declared: string, args: Record<string, string>): string | null {
  const m = PLACEHOLDER.exec(declared);
  if (m === null) return declared;
  const name = m[1]!;
  return Object.prototype.hasOwnProperty.call(args, name) ? args[name]! : null;
}

/**
 * The schema's inferred binding and the resolver's `Binding` differ only in how
 * they spell an absent `fingerprint`: `exactOptionalPropertyTypes` treats
 * `fingerprint?: T` and `fingerprint: T | undefined` as different types. Drop
 * the key rather than pass `undefined`, so the two descriptions of one shape
 * stay one shape.
 */
function normaliseBinding(b: CapabilityArtifact["bindings"]["controls"][string]): Binding {
  const { fingerprint, ...rest } = b;
  return fingerprint === undefined ? (rest as Binding) : ({ ...rest, fingerprint } as Binding);
}
