// src/replay/identity.ts
import type { Page } from "playwright";
import { resolveBinding } from "../surface/playwright-web/resolver.js";
import type { Binding, Handle } from "../surface/types.js";

/**
 * The outcome of resolving a binding at replay time, where "resolved" means
 * every rung that still works agrees about which element it names.
 *
 * `agreed` is the number of rungs that resolved and matched. It is reported
 * rather than merely asserted because 1 and 2 are genuinely different
 * situations and only the caller can decide what to do about the difference:
 * `agreed: 1` is "nothing contradicted this", `agreed: 2` is "two
 * independently-proven strategies confirmed each other". A single-rung chain
 * can only ever produce the former and refusing it would make the common case
 * unreplayable, so the count carries the distinction instead of the verdict.
 *
 * On `chain-disagreement`, `disagreeingTiers` names the rungs whose element
 * differs from a single **reference rung** — the first rung in chain order
 * that resolved — and `tier` names that reference. The field exists to say
 * which rungs are worth going to look at, so it lists the ones that
 * contradict, not every rung that resolved: naming them all would report the
 * reference as disagreeing with itself and leave the reader nothing to act on.
 *
 * The reference is arbitrary but deterministic, and it is deliberately not a
 * majority: a two-rung chain — the common shape — has no majority to have, so
 * inventing one would work only where the answer is least needed and would
 * imply the outvoted rung had been proven wrong. It has not been. When rungs
 * disagree, no element here is trustworthy, whatever the split; the reference
 * is a coordinate for reading the report, not a verdict about which rung is
 * right.
 */
export type Corroboration =
  | { ok: true; handle: Handle; tier: number; agreed: number }
  | {
      ok: false;
      reason: "no-match" | "ambiguous" | "fingerprint-mismatch" | "chain-disagreement";
      tier?: number;
      disagreeingTiers?: number[];
    };

/**
 * Replay-time element identity, established by corroboration among the rungs
 * of the chain rather than by trusting the first one that resolves.
 *
 * ## The hole this closes
 *
 * At record time (`src/artifact/prove.ts`) every strategy in a chain was
 * verified twice over: it resolved to exactly one element, **and** that
 * element was the one the model actually touched, compared by the
 * observation handle `observe()` had stamped on it. Both halves matter —
 * `resolvesToTarget` documents two concrete ways a strategy resolves
 * uniquely to the *wrong* element — so a recorded chain is a set of
 * independently-proven statements that all named one element.
 *
 * Replay has no such comparison available. There is no observation handle to
 * check against, because there is no model in the loop and nothing was
 * touched yet; the only guard `resolveBinding` applies is the `tag`
 * fingerprint, and tier 3 defeats that by construction — `accepts: [tag]`
 * guarantees that a wrong element found by anchor geometry carries the right
 * tag. So a binding that resolved correctly when recorded could resolve
 * somewhere else at replay, be acted on, and leave no trace of it.
 *
 * ## The evidence the artifact already holds
 *
 * Each rung was *separately* proven to name the same element. That is the
 * missing comparison, recovered from data already in the artifact: if two
 * rungs now resolve to **different** elements, the surface has drifted since
 * recording and neither answer can be trusted — one of them is wrong and
 * nothing here can say which. The chain stops being a fallback ladder and
 * becomes a corroboration set. No new recorded field, no new schema.
 *
 * ## Why the walk is exhaustive
 *
 * **Do not "optimise" this back into stopping at the first rung that
 * resolves, or at the first two that agree.** Early exit is what makes
 * disagreement invisible: the rung that would have contradicted the answer is
 * the rung that never runs. The cost of the full walk is a few extra locator
 * round trips per control. Replay is not latency-critical — it has no model
 * in the loop, which is where the time actually went — and determinism is the
 * product this function exists to sell. Trading it for round trips is not a
 * trade this component is allowed to make.
 *
 * ## What is drift and what is disagreement
 *
 * A rung that no longer matches anything is drift, and it is recorded as
 * uncorroborating rather than as a refusal. Nothing about a rung that says
 * nothing suggests a *different* element, and refusing on it would kill a
 * capability over a harmless markup change while buying no safety.
 *
 * An **ambiguous** rung is judged on its match set rather than on the fact of
 * its ambiguity, which is why `Resolution` carries the candidate handles. If
 * the element the rest of the chain agreed on is among them, the rung has
 * lost its discriminating power and contradicts nothing: drift, exactly like
 * a rung that stopped matching. If it is absent, that rung now points
 * somewhere else entirely and is disagreement — treating it as drift would be
 * a downgrade path, where the surface only has to make a contradicting rung
 * ambiguous rather than uniquely wrong to turn a refusal into a shrug. A rung
 * whose candidates are unreported cannot be judged either way and is left as
 * drift; the resolver reports them for every ambiguous outcome, so that is a
 * defensive branch, not a route anything currently takes.
 *
 * Identity is compared by the resolver's own `HANDLE_ATTR` stamp, which is
 * written read-before-write: re-resolving one element yields the same handle
 * string, and two elements never share one. That makes the comparison a
 * string equality with no second notion of "the same element" available to get
 * wrong — the same technique `resolvesToTarget` uses at record time, of which
 * this function is the mirror.
 *
 * Throws rather than returning `ok: false` for a binding this resolver cannot
 * honour at all (a declared scope, an unbound placeholder). Those are
 * `resolveBinding`'s own throws and they are deliberately not caught: "this
 * binding cannot be replayed by this resolver" is a different statement from
 * "the element was not there", and flattening the first into the second would
 * disguise a structural gap as ordinary drift.
 */
export async function resolveCorroborated(
  page: Page,
  binding: Binding,
  args: Record<string, string>,
): Promise<Corroboration> {
  // The fingerprint belongs to the binding, not to whichever rung wins, so
  // every rung is checked against it. Spread rather than assigned because
  // `exactOptionalPropertyTypes` distinguishes an absent key from one holding
  // `undefined`, and `Fingerprint | undefined` is not assignable to `?:`.
  const fingerprint = binding.fingerprint === undefined ? {} : { fingerprint: binding.fingerprint };

  /** Every rung that resolved to exactly one element, in chain order. */
  const resolved: Array<{ tier: number; handle: Handle }> = [];
  /**
   * Every rung that matched several elements, with the handles it was torn
   * between. Kept rather than counted because whether the agreed element is
   * among those candidates is what separates drift from disagreement.
   */
  const ambiguous: Array<{ tier: number; candidates: Handle[] | undefined }> = [];

  for (const strategy of binding.chain) {
    // One rung at a time. `resolveBinding` takes a whole binding and walks the
    // chain itself, stopping at the first success — which is exactly the
    // behaviour this function exists to replace, so it is handed a
    // single-rung chain and used purely as "resolve this one strategy".
    const res = await resolveBinding(page, { scope: binding.scope, chain: [strategy], ...fingerprint }, args);

    if (res.ok) {
      resolved.push({ tier: strategy.tier, handle: res.handle });
      continue;
    }

    if (res.reason === "fingerprint-mismatch") {
      // This rung resolved to an element that is not the *kind* of thing that
      // was recorded. That is drift of a sort no further evidence can excuse:
      // an element with the wrong tag is necessarily a different element from
      // one with the right tag, so continuing the walk could only turn a
      // definite refusal into a differently-named one. Returning here mirrors
      // `resolveBinding`, which fails loudly on a mismatch instead of
      // searching harder — see the note on `Attempt` in `surface/types.ts`.
      return { ok: false, reason: "fingerprint-mismatch", tier: strategy.tier };
    }

    // Neither `no-match` nor `ambiguous` names a single element, so neither can
    // corroborate anything and the walk continues either way. They part company
    // afterwards: an ambiguous rung has a match set, and a match set can be
    // checked against the agreed element (below), while a rung that matched
    // nothing has nothing to check.
    if (res.reason === "ambiguous") ambiguous.push({ tier: strategy.tier, candidates: res.candidates });
  }

  // The reference rung: the first in chain order that resolved. The chain is
  // ordered by record-time reliability (`proveControl`'s `RANK`), so that is
  // the strongest surviving strategy rather than an artefact of iteration —
  // and it is the coordinate every disagreement below is reported against.
  //
  // Its handle is safe to compare as an identity because `resolveBinding`
  // guarantees a handle it returns names exactly one element; it refuses rather
  // than reporting `ok: true` for a handle two elements answer to. That
  // guarantee is load-bearing here — the comparisons below are string equality
  // — and it is deliberately not re-checked in this file. A property every
  // caller re-checks is a property nobody owns.
  const reference = resolved[0];
  if (reference === undefined) {
    // Nothing resolved. Ambiguity outranks absence in the report because it is
    // the more specific finding: the element is plausibly still on the page and
    // a strategy stopped distinguishing it, which is a different repair from
    // "it is gone".
    const first = ambiguous[0];
    return first === undefined
      ? { ok: false, reason: "no-match" }
      : { ok: false, reason: "ambiguous", tier: first.tier };
  }

  const contradicting = resolved.filter((r) => r.handle !== reference.handle).map((r) => r.tier);
  if (contradicting.length > 0) {
    return {
      ok: false,
      reason: "chain-disagreement",
      tier: reference.tier,
      disagreeingTiers: contradicting,
    };
  }

  // The rungs that resolved agree. Now the ambiguous ones: a match set that
  // does not contain the agreed element is a rung pointing somewhere else, not
  // a rung that has gone vague, and it contradicts the answer exactly as a
  // uniquely-resolving rung would. Checked after the resolved rungs so a
  // definite contradiction is always reported in preference to this one.
  const elsewhere = ambiguous
    .filter((a) => a.candidates !== undefined && !a.candidates.includes(reference.handle))
    .map((a) => a.tier);
  if (elsewhere.length > 0) {
    return { ok: false, reason: "chain-disagreement", tier: reference.tier, disagreeingTiers: elsewhere };
  }

  return { ok: true, handle: reference.handle, tier: reference.tier, agreed: resolved.length };
}
