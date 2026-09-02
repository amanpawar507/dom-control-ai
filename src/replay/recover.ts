// src/replay/recover.ts
import type { Locator, Page } from "playwright";
import { detect, type ConditionDecl } from "./conditions.js";
import { gate, type PolicyConfig } from "../policy/gate.js";
import type { AuthenticatedContext, SessionProvider } from "../session/provider.js";
import { controlNamesFor } from "../surface/playwright-web/actor.js";
import { HANDLE_ATTR, resolveBinding } from "../surface/playwright-web/resolver.js";
import type { Strategy } from "../surface/types.js";

/**
 * What one bounded recovery attempt sequence produced.
 *
 * `checkpointReverified` is present only for `session-expiry` — the one
 * recovery kind spec §7 says must "refresh, re-verify last checkpoint,
 * resume". It is set on every return path out of that branch (never left
 * `undefined`), so a caller can never read an absent field as "probably
 * fine": either the checkpoint was confirmed on the live page, or the field
 * says `false` and `recovered` agrees with it. See `recover`'s doc comment
 * for why those two are never allowed to disagree.
 */
export interface RecoveryOutcome {
  tried: number;
  recovered: boolean;
  checkpointReverified?: boolean;
}

export interface RecoveryOptions {
  /** Bound on how many recovery attempts are made. Not a suggestion — see `recover`. */
  maxAttempts: number;
  /** Required for `dismiss` and `renavigate`, which act on the page and must be gated. */
  policy?: PolicyConfig;
  /** Required for `session-expiry`. */
  session?: SessionProvider;
  /**
   * The context to hand `SessionProvider.refresh()`. Optional because this
   * module does not own or persist one across a run — see the note on
   * `PLACEHOLDER_AUTH_CONTEXT` below for what happens when it is absent.
   */
  authContext?: AuthenticatedContext;
}

/**
 * One row of spec §7's runtime-conditions table, `recoverable` half — the
 * data a bounded recovery needs beyond what `ConditionDecl` already declares.
 *
 *  - `dismiss`        — "Unexpected dialog": click the declared dismiss
 *    control, bounded by `maxAttempts`.
 *  - `renavigate`      — "Application error": go back to a known-good URL
 *    once; if the banner persists, recovery has failed and the caller
 *    classifies it hard.
 *  - `rewait`          — "Transient slowness": one bounded re-wait for the
 *    checkpoint the flow was already waiting on, then give up.
 *  - `session-expiry`  — "Session expiry": refresh the session, re-verify
 *    the last checkpoint, resume — and never resume without that
 *    re-verification succeeding.
 *
 * Every variant carries the `ConditionDecl` that triggered recovery so a
 * caller (and this module's own dismiss/renavigate branches) can ask
 * `detect` whether it has cleared, rather than recovery inventing its own
 * separate notion of "fixed".
 */
export type RecoveryDecl =
  | { kind: "dismiss"; condition: ConditionDecl; dismiss: Strategy }
  | { kind: "renavigate"; condition: ConditionDecl; url: string }
  | { kind: "rewait"; condition: ConditionDecl; checkpoint: Strategy; waitBudgetMs: number }
  | { kind: "session-expiry"; condition: ConditionDecl; checkpoint: Strategy };

const DEFAULT_ACTION_BUDGET_MS = 10_000;

/**
 * Session-expiry recovery calls `SessionProvider.refresh(ctx)`, and this
 * module has no `ctx` of its own to hand it — it does not own or persist an
 * `AuthenticatedContext` across a run, only the engine that acquired one
 * initially does (Task 6, out of scope here). Absent `opts.authContext`, this
 * placeholder is passed instead.
 *
 * That is safe only because of what `refresh()`'s contract actually is:
 * "return a freshly authenticated context", not "diff against what you are
 * handed". `ParabankSessionProvider.refresh` (`src/session/playwright-state.ts`)
 * is the one implementation in this tree and its `_ctx` parameter is unused —
 * it re-authenticates from scratch every time. Nothing in this module reads
 * or trusts this placeholder's contents; it exists only to satisfy the
 * parameter `SessionProvider.refresh` requires.
 *
 * What this module does NOT do: apply the refreshed `AuthenticatedContext`
 * back onto `page`'s live browser context. A `Page` cannot have its context's
 * storage state replaced in place — only the `BrowserContext` it belongs to
 * can, and this module is handed a `Page`, not a context. Wiring the
 * refreshed context onto the live browser session, if the target needs that
 * before the checkpoint will actually re-render, is the caller's job.
 */
const PLACEHOLDER_AUTH_CONTEXT: AuthenticatedContext = {
  storageState: "{}",
  acquiredAt: new Date(0).toISOString(),
};

/**
 * Whether `checkpoint` resolves to exactly one rendered element right now.
 * The verdict every branch below trusts, including the one Playwright's own
 * `waitFor` blocks ahead of in `waitForCheckpoint` — that call only decides
 * *when* to re-run this, never *whether* the checkpoint holds.
 */
async function checkpointHolds(page: Page, checkpoint: Strategy): Promise<boolean> {
  const res = await resolveBinding(page, { scope: [], chain: [checkpoint] }, {});
  return res.ok;
}

/** A locator broad enough to block on, never used as the pass/fail verdict itself. */
function looseLocatorFor(page: Page, s: Strategy): Locator {
  switch (s.by) {
    case "testid":
      return page.locator(`[data-testid="${s.value}"]`);
    case "role":
      return page.getByRole(s.role as Parameters<Page["getByRole"]>[0], { name: s.name, exact: true });
    case "css":
      return page.locator(s.value);
    case "anchor":
      throw new Error("recovery checkpoints do not support anchor strategies");
  }
}

/**
 * "One bounded re-wait" (§7, transient slowness): give the checkpoint a real
 * but bounded chance to appear, then answer once, definitively.
 *
 * Blocks on Playwright's own `waitFor`, not on a `setTimeout` poll loop in
 * this module — the codebase's existing pattern for a bounded, condition-based
 * wait (`settle()` in `src/discover/loop.ts` does the same with
 * `waitForLoadState`). `state: "attached"` rather than `"visible"` is
 * deliberate: `waitFor` here is only a blocking primitive that says "something
 * worth re-checking may have changed", not the verdict — the verdict is always
 * `checkpointHolds`, the same resolveBinding-backed, visibility-gated check
 * every other decision in this module makes. A checkpoint that attaches but
 * renders hidden must still fail on the real check, not pass because
 * Playwright's own (different) visibility notion was satisfied first.
 *
 * The `.catch(() => undefined)` on the wait is deliberate too: a timeout here
 * is the expected outcome on every attempt that does not recover, not an
 * error — `checkpointHolds` runs either way and is what actually answers.
 */
async function waitForCheckpoint(page: Page, checkpoint: Strategy, waitBudgetMs: number): Promise<boolean> {
  if (await checkpointHolds(page, checkpoint)) return true;
  await looseLocatorFor(page, checkpoint)
    .first()
    .waitFor({ state: "attached", timeout: waitBudgetMs })
    .catch(() => undefined);
  return checkpointHolds(page, checkpoint);
}

/**
 * Resolve and click the declared dismiss control, gated the same way every
 * other click in this codebase is (`tests/policy/gate-parity.test.ts` scans
 * for exactly this — a module that clicks without calling `gate` fails that
 * guard on sight).
 *
 * A dismiss control that does not resolve, or that the gate refuses, is not
 * an error here: it simply means this attempt did nothing, and the caller's
 * post-attempt `detect` call will find the condition unchanged and try again
 * — or stop, once `maxAttempts` is spent. Throwing instead would turn a
 * recovery that legitimately made no progress into a crash.
 *
 * `policy` is checked only once there is something to gate — a dismiss
 * control that never resolves needs no `PolicyConfig` at all, because
 * nothing is ever about to be clicked. Requiring one unconditionally would
 * make every caller supply a policy even for a declaration whose dismiss
 * target simply is not on this page.
 */
async function attemptDismiss(page: Page, policy: PolicyConfig | undefined, dismiss: Strategy): Promise<void> {
  const res = await resolveBinding(page, { scope: [], chain: [dismiss] }, {});
  if (!res.ok) return;
  if (policy === undefined) {
    throw new Error("dismiss recovery requires a PolicyConfig to gate the click");
  }
  const loc = page.locator(`[${HANDLE_ATTR}="${res.handle}"]`);
  const controlNames = await controlNamesFor(loc);
  const verdict = gate(policy, { url: page.url(), action: "click", controlNames });
  if (verdict.decision !== "allow") return;
  await loc.click({ timeout: DEFAULT_ACTION_BUDGET_MS }).catch(() => undefined);
}

/** Gated navigation back to a known-good URL. Same non-throwing-on-refusal reasoning as `attemptDismiss`. */
async function attemptRenavigate(page: Page, policy: PolicyConfig, url: string): Promise<void> {
  const verdict = gate(policy, { url, action: "navigate", controlNames: [] });
  if (verdict.decision !== "allow") return;
  await page.goto(url, { timeout: DEFAULT_ACTION_BUDGET_MS }).catch(() => undefined);
}

/**
 * Attempt bounded recovery from a declared runtime condition.
 *
 * ## Bounded is not a suggestion
 *
 * The `while` loop below has exactly one exit besides success: `tried` has
 * reached `opts.maxAttempts`. There is no path through this function that
 * retries past that count, for any recovery kind — an unbounded retry is a
 * hang wearing a costume, and the bound is what keeps a replay that meets a
 * condition it cannot clear a *failure*, in finite time, rather than a
 * process nobody remembers is still running.
 *
 * ## Session-expiry never resumes on an unverified checkpoint
 *
 * Spec §7's response for session expiry is "refresh, re-verify last
 * checkpoint, resume" — three steps, not two. Resuming without the middle one
 * assumes the page came back to where it was, and that assumption is exactly
 * what makes a resumed run act on the wrong screen: a session refresh can
 * succeed (a new cookie, a 200 response) while the page the caller still
 * holds is showing something else entirely — a different account, a partial
 * render, the login form again because the refresh itself landed somewhere
 * unexpected.
 *
 * So `recovered` and `checkpointReverified` are never allowed to disagree for
 * this kind: `recovered: true` is returned *only* on the branch that also
 * sets `checkpointReverified: true`, and every other exit from this branch —
 * including the bound being spent — reports `checkpointReverified: false`
 * explicitly, never left `undefined` for a caller to misread as "probably
 * fine". A caller that resumes only when `recovered` is true can therefore
 * never resume on an unverified checkpoint; there is no code path that
 * returns the one without the other.
 */
export async function recover(page: Page, decl: RecoveryDecl, opts: RecoveryOptions): Promise<RecoveryOutcome> {
  let tried = 0;

  while (tried < opts.maxAttempts) {
    tried++;

    switch (decl.kind) {
      case "dismiss": {
        await attemptDismiss(page, opts.policy, decl.dismiss);
        if ((await detect(page, [decl.condition])) === null) return { tried, recovered: true };
        break;
      }

      case "renavigate": {
        if (opts.policy === undefined) {
          throw new Error("renavigate recovery requires a PolicyConfig to gate the navigation");
        }
        await attemptRenavigate(page, opts.policy, decl.url);
        if ((await detect(page, [decl.condition])) === null) return { tried, recovered: true };
        break;
      }

      case "rewait": {
        if (await waitForCheckpoint(page, decl.checkpoint, decl.waitBudgetMs)) {
          return { tried, recovered: true };
        }
        break;
      }

      case "session-expiry": {
        if (opts.session === undefined) {
          throw new Error("session-expiry recovery requires a SessionProvider");
        }
        await opts.session.refresh(opts.authContext ?? PLACEHOLDER_AUTH_CONTEXT).catch(() => undefined);
        if (await checkpointHolds(page, decl.checkpoint)) {
          return { tried, recovered: true, checkpointReverified: true };
        }
        // Re-verification failed. Do not resume: fall through to the next
        // attempt if the bound allows one, and if this was the last, the
        // return below reports both fields false rather than leaving
        // `checkpointReverified` unset.
        break;
      }
    }
  }

  return decl.kind === "session-expiry"
    ? { tried, recovered: false, checkpointReverified: false }
    : { tried, recovered: false };
}
