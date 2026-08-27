// src/replay/identity.ts
import type { Page } from "playwright";
import { HANDLE_ATTR, resolveBinding } from "../surface/playwright-web/resolver.js";
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
 * A rung that no longer resolves at all — no match, or several matches — is
 * drift, and it is recorded as uncorroborating, not as a refusal. Nothing
 * about a rung that says nothing suggests a *different* element, and refusing
 * on it would kill a capability over a harmless markup change while buying no
 * safety. Only two rungs that both resolve, to genuinely different elements,
 * is `chain-disagreement`.
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
  /** The first rung that matched several elements, if any — reported only when nothing resolved. */
  let firstAmbiguous: number | null = null;

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

    // `no-match` and `ambiguous` are both "this rung named no single element".
    // Neither is evidence of a *different* element: one lost the element, the
    // other lost the ability to tell it from its neighbours. Both are recorded
    // as uncorroborating and the walk continues.
    if (res.reason === "ambiguous") firstAmbiguous ??= strategy.tier;
  }

  const strongest = resolved[0];
  if (strongest === undefined) {
    // Nothing resolved. Ambiguity outranks absence in the report because it is
    // the more specific finding: the element is plausibly still on the page and
    // a strategy stopped distinguishing it, which is a different repair from
    // "it is gone".
    return firstAmbiguous === null
      ? { ok: false, reason: "no-match" }
      : { ok: false, reason: "ambiguous", tier: firstAmbiguous };
  }

  if (new Set(resolved.map((r) => r.handle)).size > 1) {
    // Every rung that resolved is named, not just the first contradicting
    // pair. No rung is privileged — the chain is ordered by record-time
    // brittleness, not by authority — so a majority agreeing among a split set
    // confers no trust, and reporting only the outliers would imply the
    // remainder had been vindicated.
    return { ok: false, reason: "chain-disagreement", disagreeingTiers: resolved.map((r) => r.tier) };
  }

  // The rungs agree on a handle; confirm the handle still names exactly one
  // element. It normally does — `HANDLE_ATTR` is stamped read-before-write on
  // one element at a time — but a page that clones a stamped node (a re-rendered
  // row, a duplicated table body) leaves two elements carrying one handle, and
  // then the string equality above compares equal for two *different* elements
  // and the agreement is fiction. The actor performs the same one-or-fail count
  // before acting; doing it here too is what makes this function's own answer
  // true rather than merely safe downstream.
  const count = await page.locator(`[${HANDLE_ATTR}="${strongest.handle}"]`).count();
  if (count !== 1) return { ok: false, reason: "ambiguous", tier: strongest.tier };

  // The reported tier is the first rung in chain order that resolved. The chain
  // is ordered by record-time reliability (`proveControl`'s `RANK`), so that is
  // the strongest surviving strategy rather than an artefact of iteration.
  return { ok: true, handle: strongest.handle, tier: strongest.tier, agreed: resolved.length };
}
