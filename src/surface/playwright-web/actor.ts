import type { Locator, Page } from "playwright";
import type { Action } from "../types.js";
import { gate, type GateVerdict, type PolicyConfig } from "../../policy/gate.js";
import { controlNameEvidence } from "../../policy/risk.js";
import type { RunLogger } from "../../evidence/logger.js";
import { HANDLE_ATTR } from "./resolver.js";

/**
 * The gate said no, and no is final. Distinct from `PolicyEscalation` because
 * the two have different destinations: a refusal ends the attempt, an
 * escalation parks it for a human. Collapsing them into one error type would
 * make an irreversible action indistinguishable from a forbidden one at the
 * catch site, which is the distinction the policy exists to draw.
 */
export class PolicyRefusal extends Error {
  constructor(public readonly reason: string) {
    super(`policy refused: ${reason}`);
    this.name = "PolicyRefusal";
  }
}

/** The gate wants a human. The action was not performed. */
export class PolicyEscalation extends Error {
  constructor(public readonly reason: string) {
    super(`policy escalated: ${reason}`);
    this.name = "PolicyEscalation";
  }
}

/**
 * Action types that land on a specific element. Each one needs a handle before
 * it can be classified at all: there is no element to read, so there is nothing
 * to classify, and the only remaining input would be the caller's own claim.
 * `extract` is absent because it is a read with no effect, and `navigate`
 * because it is judged by destination rather than by element.
 */
const TARGETED = new Set(["click", "fill", "select", "upload"]);

/**
 * Budget for the single round-trip that reads a control's name. The element was
 * stamped by the resolver moments earlier, so this is not a readiness wait — it
 * is a bound on how long a wrong answer can take to arrive.
 */
const NAME_BUDGET_MS = 5_000;

/**
 * Runs inside the page. Must not close over module scope — an evaluate callback
 * is serialised with `toString` and re-parsed in the page, where the only scope
 * is the page's own globals. A reference to anything outside this function is a
 * `ReferenceError` in the browser, not a compile error here.
 *
 * That constraint reaches further than it looks: it forbids *inner named
 * functions* too. `tsx` runs the CLI through esbuild with `keepNames`, which
 * rewrites `const norm = (v) => …` into `const norm = __name((v) => …, "norm")`
 * — and `__name` is a module-scope helper. The first version of this function
 * had two such helpers and died with `ReferenceError: __name is not defined` on
 * the first click of a real run, while every test stayed green because vitest's
 * transform does not set `keepNames`. Hence the flat, helper-free shape below,
 * and `tests/surface/evaluate-serialisation.test.ts`, which applies the shipping
 * transform and calls the result in a scope as bare as the page's.
 *
 * Returns every name the element goes by, most authoritative first, because
 * `classifyRisk` matches over the set. Two decisions are load-bearing:
 *
 *  - A `<button>`'s name is its text, never its `value`. ParaBank's own admin
 *    control is `<button name="action" value="CLEAN">Clean</button>`: reading
 *    `value` would produce "CLEAN" and quietly miss a rule written for "Clean".
 *    An `<input type="submit">`, by contrast, has no text and its `value` *is*
 *    its name — which is how "Shutdown" is spelled on that same page.
 *  - A text input's `value` is never read. That is user data, not a name, and it
 *    would put a typed password into a risk decision and into the evidence.
 */
export function controlNamesOf(el: Element): string[] {
  const candidates: Array<string | null | undefined> = [];

  candidates.push(el.getAttribute("aria-label"));

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const ids = labelledBy.split(/\s+/);
    let joined = "";
    for (let i = 0; i < ids.length; i++) {
      const target = document.getElementById(ids[i] ?? "");
      if (target !== null) joined += ` ${target.textContent ?? ""}`;
    }
    candidates.push(joined);
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") {
      candidates.push((el as HTMLInputElement).value);
    }
  }
  if (tag === "input" || tag === "img" || tag === "area") candidates.push(el.getAttribute("alt"));

  const labels = (el as HTMLInputElement).labels;
  if (labels) {
    for (let i = 0; i < labels.length; i++) candidates.push(labels[i]?.textContent);
  }

  candidates.push(el.textContent);
  candidates.push(el.getAttribute("title"));

  // Normalised and de-duplicated in one pass, because a helper here would be a
  // named binding and named bindings are what the transform rewrites.
  const names: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const name = (candidates[i] ?? "").replace(/\s+/g, " ").trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Every name the element behind `loc` goes by, read off the page.
 *
 * Exported so the discovery loop (`src/discover/loop.ts`) can gate on what a
 * control actually is without carrying its own copy of `controlNamesOf`. The
 * `evaluate` call has to live *here*, in the same module as the function it
 * serialises: `tests/surface/evaluate-serialisation.test.ts` resolves a bare
 * identifier argument only against top-level declarations of the module the
 * call site sits in, so `loc.evaluate(controlNamesOf)` written from another
 * file is a callback the guard cannot read — and it fails closed on that,
 * which is correct. One call site, one definition, both checked.
 *
 * The loop needs this rather than `ObservedNode.name` because the gate's risk
 * classification is monotone in the name set: `observe()` computes one name by
 * a first-match priority, while this returns every name the element answers
 * to, and a rule written against any of them then fires. `<button
 * title="Clean">Purge everything</button>` is the shape that distinguishes
 * them, and it is the shape the irreversible rule exists for.
 */
export async function controlNamesFor(loc: Locator): Promise<string[]> {
  return loc.evaluate(controlNamesOf, undefined, { timeout: NAME_BUDGET_MS });
}

/**
 * The single place where an intent becomes a real browser effect.
 *
 * Every path to a side effect runs `gate` first and throws on anything short of
 * `allow`, so the policy is a choke point rather than a convention: there is no
 * method here that touches the page without having asked. The verdict is logged
 * before it is acted on, so the evidence records the decision even when the
 * decision is to do nothing.
 *
 * What the gate is asked *about* is read from the page, not from the caller. An
 * earlier version classified risk from a `controlName` string passed alongside
 * the action, which made the safety property depend on every call site being
 * honest about what it was clicking — enforcement by convention, at the one
 * boundary where convention is not enough.
 */
export class WebActor {
  constructor(
    private readonly page: Page,
    private readonly cfg: PolicyConfig,
    private readonly log: RunLogger,
  ) {}

  /**
   * The verdict this actor would reach for an action, without performing it.
   * Exposed so a caller can probe a control it must not touch — the admin
   * `Clean` button being the case this phase cares about. Asking reads the
   * element's name and nothing else; it never acts.
   *
   * A navigate is judged against where it is going; everything else against
   * where the page already is, because that is the page the effect lands on.
   *
   * `claimedName` is what the caller believes it is acting on. It is passed to
   * the gate *in addition to* the element's own names, never instead of them,
   * so it can only make the verdict stricter (see `classifyRisk`). A caller that
   * lies, or says nothing at all, cannot talk the gate down.
   */
  async verdictFor(action: Action, claimedName: string | null): Promise<GateVerdict> {
    return (await this.judge(action, claimedName)).verdict;
  }

  /**
   * The verdict together with the names it was reached from. `act` needs both —
   * one to obey and one to record — and reading the element twice would be a
   * second round-trip whose answer could differ from the one that was judged.
   */
  private async judge(
    action: Action,
    claimedName: string | null,
  ): Promise<{ verdict: GateVerdict; names: string[] | null; url: string }> {
    const url = action.type === "navigate" ? (action.url ?? this.page.url()) : this.page.url();
    const named = await this.namesFor(action, claimedName);
    if (!named.ok) return { verdict: { decision: "refuse", reason: named.reason }, names: null, url };
    return {
      verdict: gate(this.cfg, { url, action: action.type, controlNames: named.names }),
      names: named.names,
      url,
    };
  }

  /**
   * Every name the gate should judge this action by.
   *
   * Failing here is a refusal rather than a throw because "I could not work out
   * what this is" is a policy answer, not a crash: the action does not happen,
   * and the reason says why. Fail-closed is the only safe direction — the
   * alternative is classifying an unknown element from a caller's label, which
   * is the hazard being closed.
   */
  private async namesFor(
    action: Action,
    claimedName: string | null,
  ): Promise<{ ok: true; names: string[] } | { ok: false; reason: string }> {
    const claimed = (claimedName ?? "").trim();

    if (action.handle === undefined) {
      if (TARGETED.has(action.type)) {
        return {
          ok: false,
          reason: `${action.type} requires "handle" before its risk can be classified`,
        };
      }
      return { ok: true, names: claimed === "" ? [] : [claimed] };
    }

    const loc = this.page.locator(`[${HANDLE_ATTR}="${action.handle}"]`);
    // Exactly one or fail, on the same terms as the resolver. `count()` is a
    // point-in-time read with no auto-retry, so a stale handle is reported as
    // what it is instead of being waited on.
    const count = await loc.count();
    if (count !== 1) {
      return {
        ok: false,
        reason: `handle "${action.handle}" matches ${count} elements, so the control cannot be identified`,
      };
    }

    const names = [...(await controlNamesFor(loc))];
    if (claimed !== "" && !names.includes(claimed)) names.push(claimed);
    return { ok: true, names };
  }

  async act(action: Action, claimedName: string | null): Promise<void> {
    const { verdict, names, url } = await this.judge(action, claimedName);
    // Both are recorded: what the caller said it was acting on, and what the
    // gate actually judged. A caller whose label disagrees with the element is
    // then visible in the evidence rather than invisible in it.
    //
    // What "what the gate judged" may say in a file is `controlNameEvidence`'s
    // decision, not this one's — the names read off an element can be its
    // contents, and this log line was one of the three putting them on disk
    // verbatim. Judged on the same url the verdict was reached from, so the two
    // cannot disagree about which rules were even eligible to fire.
    const evidence = controlNameEvidence(url, action.type, names ?? [], this.cfg.riskRules);
    this.log.log({
      kind: "gate",
      action: action.type,
      claimedName,
      ...evidence,
      verdict,
    });

    if (verdict.decision === "refuse") throw new PolicyRefusal(verdict.reason);
    if (verdict.decision === "escalate") throw new PolicyEscalation(verdict.reason);

    switch (action.type) {
      case "navigate":
        await this.page.goto(this.required(action.url, "navigate", "url"));
        break;
      case "click":
        await this.target(action).click();
        break;
      case "fill":
        await this.target(action).fill(this.required(action.value, "fill", "value"));
        break;
      case "select":
        await this.target(action).selectOption(this.required(action.value, "select", "value"));
        break;
      case "extract":
        // Reading is not an effect. The gate still ran, so an extract from a
        // disallowed origin is refused above; there is nothing to do here.
        break;
      case "upload":
        // Unreachable while `upload` stays out of the allowlist, which refuses
        // it above. Kept so the switch is total over ActionType and so adding
        // `upload` to an allowlist fails loudly instead of silently no-opping.
        throw new PolicyRefusal("upload is not implemented");
    }

    this.log.log({
      kind: "acted",
      action: action.type,
      claimedName,
      ...evidence,
      url: this.page.url(),
    });
  }

  /**
   * Handles come from the resolver, which stamps `HANDLE_ATTR` in-page. Going
   * back through the attribute rather than holding a Playwright locator is what
   * keeps the actor ignorant of how the element was found: tier 0 and tier 3
   * arrive here identically.
   */
  private target(action: Action): Locator {
    const handle = this.required(action.handle, action.type, "handle");
    return this.page.locator(`[${HANDLE_ATTR}="${handle}"]`);
  }

  /**
   * An `Action` is structurally permissive — every field but `type` is optional,
   * because different action types need different fields. That makes a missing
   * field a runtime concern, and the only safe response at an effect boundary is
   * to refuse rather than to substitute a default: `page.goto(undefined)` or
   * `fill("")` would be an unintended effect, not a no-op.
   */
  private required(value: string | undefined, action: string, field: string): string {
    if (value === undefined) throw new PolicyRefusal(`${action} requires "${field}"`);
    return value;
  }
}
