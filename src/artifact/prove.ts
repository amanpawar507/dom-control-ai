// src/artifact/prove.ts
import type { Page } from "playwright";
import { OBS_ATTR, type ObservedNode } from "../observe/snapshot.js";
import { HANDLE_ATTR, resolveBinding } from "../surface/playwright-web/resolver.js";
import type { Binding, Strategy } from "../surface/types.js";

/**
 * Record-time proving: turn a handle the model touched during discovery into
 * a `Binding` every rung of which was actually confirmed, live, to resolve
 * to exactly one element on THIS page, right now — **and to resolve to the
 * element the model actually touched**, not merely to some single element.
 * That second half is the whole point, and it is the half this file shipped
 * without: a chain built from a plausible guess and never checked is a hope,
 * not a binding, and a chain checked only for uniqueness is a binding to
 * whatever happened to be unique. See `proveControl` below for the entry
 * point and `resolvesToTarget` for the check.
 *
 * `proveControl` takes the whole `ObservedNode` `observe()` produced for the
 * touched element, not a bare handle string. `node.handle` is the
 * *observation* handle — the `oNnM`-shaped token `observe()` stamps under
 * `OBS_ATTR` (`src/observe/snapshot.ts`), not the resolver's own
 * `HANDLE_ATTR`. The two are deliberately different attributes for different
 * purposes (see the comment on `OBS_ATTR`), and this file only ever reads
 * the former. A handle from a stale (earlier) observation matches nothing
 * under `OBS_ATTR` — `observe()` clears and renumbers on every call — so the
 * very first step below fails loudly instead of quietly resolving to
 * whatever now occupies that slot.
 *
 * `node.role` and `node.name` are also taken as given, not recomputed here.
 * `observe()`'s `walk` (`src/observe/snapshot.ts`) already computed both for
 * this exact element with its own role/name heuristic; re-deriving them by
 * hand in this file — in an evaluate callback that cannot import and call
 * `walk`'s logic — previously produced a second copy that silently drifted:
 * `walk` maps `contenteditable` to role `"textbox"` and this file's old copy
 * did not, so a `<div contenteditable>` computed role `"div"` here, which
 * Playwright rejects as an invalid ARIA role, and the tier-1 candidate was
 * discarded without a trace. Taking the caller's already-proven values
 * closes that gap by construction instead of adding the missing branch and
 * leaving two copies free to drift again.
 */

/**
 * Raw signals read off the stamped element, once — everything the candidate
 * generators below need. Nothing here is trusted as a targeting strategy by
 * itself; every field is turned into a `Strategy` guess and then proven (or
 * discarded) against the live page via `resolveBinding`, exactly the same
 * function replay will eventually use.
 */
interface RawFacts {
  tag: string;
  testid: string | null;
  classes: string[];
  attrs: { name: string | null; type: string | null; placeholder: string | null };
  parentTag: string | null;
  parentClasses: string[];
  anchor: { text: string; rel: "nearest-right" | "nearest-below" | "nearest-above" } | null;
}

/**
 * Runs inside the page via `Locator.evaluate`. Must not close over module
 * scope and must declare no inner *named* function bindings — `tsx` ships
 * every entry point through esbuild with `keepNames`, which rewrites a named
 * inner function into a call to a module-scope `__name` helper the page has
 * never heard of. See the identical constraint on `walk` in
 * `observe/snapshot.ts` and `anchorResolve` in
 * `surface/playwright-web/resolver.ts`, and
 * `tests/surface/evaluate-serialisation.test.ts`, which enforces it here too.
 * Everything below is therefore flat loops and `const`/`let` bindings that
 * hold values, never functions.
 *
 * Role and name are deliberately NOT computed here. `proveControl`'s caller
 * already has both, straight from `observe()`'s `ObservedNode`, and passes
 * them in — see the note on `proveControl` for why re-deriving them by hand
 * a second time is exactly the failure mode this file used to have.
 *
 * `anchor` is the one candidate that most needs explaining. It looks for the
 * nearest *preceding* text in reading order — first among the element's own
 * siblings, and only if none qualify there, exactly one level further out
 * among its parent's siblings — and stops. It does not walk further, and it
 * does not search the whole page. That bound is load-bearing, not an
 * implementation shortcut: `tests/fixtures/parabank/findtrans.html` carries
 * four "Find Transactions" buttons, each sitting right after a `<br>` with
 * nothing else in its own `<div>`. An unbounded nearest-text search (the
 * kind `anchorResolve` correctly performs at *replay* time, where the
 * anchor text is already fixed) would walk straight past that `<br>` and
 * find the previous section's heading — "Find by Amount", "Find by Date
 * Range", and so on — each of which turns out to uniquely geometrically
 * identify its neighbouring button. That would make every one of the four
 * buttons individually provable by a heading that is not, in any real
 * sense, its label. Stopping at the first sibling-or-one-hop-out node —
 * whatever it is, empty `<br>` included — refuses to manufacture a label
 * where the markup does not actually offer one, which is exactly the
 * outcome `tests/artifact/prove.test.ts` requires for this fixture: nothing
 * proves unique, on purpose, because nothing legitimately identifies one
 * button over the other three.
 *
 * A candidate found this way is skipped, not merely deprioritised, unless
 * geometry backs it: same row and to the left (`nearest-right`), or
 * column-aligned and above/below (`nearest-below`/`nearest-above`) using the
 * exact qualifying conditions `anchorResolve` itself uses, so a generated
 * guess is never offered as a strategy that the resolver's own geometry
 * would immediately reject.
 */
function readProvingFacts(el: Element): RawFacts {
  const tag = el.tagName.toLowerCase();
  const testid = el.getAttribute("data-testid");

  const classAttr = el.getAttribute("class") ?? "";
  const classes = classAttr.split(/\s+/).filter((c) => c !== "");

  const attrs = {
    name: el.getAttribute("name"),
    type: tag === "input" ? el.getAttribute("type") : null,
    placeholder: el.getAttribute("placeholder"),
  };

  const parent = el.parentElement;
  const parentTag = parent === null ? null : parent.tagName.toLowerCase();
  const parentClassAttr = parent === null ? "" : (parent.getAttribute("class") ?? "");
  const parentClasses = parentClassAttr.split(/\s+/).filter((c) => c !== "");

  // Whitespace and bare separator punctuation ("Label: <input>") are not a
  // label on their own; skip past them but stop at the first real node.
  const SKIP = /^[\s:;,.\-–—]*$/;

  let anchorNode: Node | null = null;
  let sib: Node | null = el.previousSibling;
  while (sib !== null) {
    if (sib.nodeType === 3 && SKIP.test(sib.textContent ?? "")) {
      sib = sib.previousSibling;
      continue;
    }
    anchorNode = sib;
    break;
  }

  if (anchorNode === null && parent !== null) {
    let outer: Node | null = parent.previousSibling;
    while (outer !== null) {
      if (outer.nodeType === 3 && SKIP.test(outer.textContent ?? "")) {
        outer = outer.previousSibling;
        continue;
      }
      anchorNode = outer;
      break;
    }
  }

  let anchor: RawFacts["anchor"] = null;
  if (anchorNode !== null) {
    const text = (anchorNode.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") {
      let labelRect: DOMRect;
      if (anchorNode.nodeType === 1) {
        labelRect = (anchorNode as Element).getBoundingClientRect();
      } else {
        const range = document.createRange();
        range.selectNodeContents(anchorNode);
        labelRect = range.getBoundingClientRect();
      }
      const elRect = el.getBoundingClientRect();
      const EPSILON = 0.5;
      const sameRow = elRect.top < labelRect.bottom && elRect.bottom > labelRect.top;
      const columnOverlap = elRect.left < labelRect.right && elRect.right > labelRect.left;
      const midY = elRect.top + elRect.height / 2;

      if (sameRow && labelRect.right <= elRect.left + EPSILON) {
        anchor = { text, rel: "nearest-right" };
      } else if (columnOverlap && midY > labelRect.bottom - EPSILON) {
        anchor = { text, rel: "nearest-below" };
      } else if (columnOverlap && midY < labelRect.top + EPSILON) {
        anchor = { text, rel: "nearest-above" };
      }
    }
  }

  return { tag, testid, classes, attrs, parentTag, parentClasses, anchor };
}

/** CSS identifier escaping (tag names, class names). Runs in Node, not the page — `CSS.escape` is a browser global and unavailable here. */
function escapeIdent(v: string): string {
  return v.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/** CSS quoted-attribute-value escaping. */
function escapeAttrValue(v: string): string {
  return v.replace(/[\\"]/g, "\\$&");
}

/**
 * Tier-2 candidates, weakest first, deliberately bounded to shallow,
 * class/attribute-based selectors — never an `id` (see the note on
 * `proveControl` for why) and never a positional ancestor chain
 * (`nth-child` all the way to `body`). A full ancestor path is unique for
 * *any* element by construction — it just spells out that element's own
 * position — so "prove it resolves uniquely" would pass trivially and mean
 * nothing, and the four `findtrans.html` buttons would each get a
 * "structural" strategy that is really just its own coordinates. Escalation
 * stops at one level of parent qualification; if that is not enough to
 * distinguish an element from its siblings, tier 2 legitimately has nothing
 * to offer, and the element must earn its binding some other way.
 */
function buildCssCandidates(facts: RawFacts): string[] {
  const candidates: string[] = [];
  const add = (v: string): void => {
    if (v !== "" && !candidates.includes(v)) candidates.push(v);
  };

  add(facts.tag);

  const ownWithClass =
    facts.classes.length > 0 ? `${facts.tag}.${facts.classes.map(escapeIdent).join(".")}` : facts.tag;
  if (facts.classes.length > 0) add(ownWithClass);

  if (facts.attrs.name !== null && facts.attrs.name !== "") {
    add(`${facts.tag}[name="${escapeAttrValue(facts.attrs.name)}"]`);
  }
  if (facts.attrs.type !== null && facts.attrs.type !== "") {
    add(`${facts.tag}[type="${escapeAttrValue(facts.attrs.type)}"]`);
  }
  if (facts.attrs.placeholder !== null && facts.attrs.placeholder !== "") {
    add(`${facts.tag}[placeholder="${escapeAttrValue(facts.attrs.placeholder)}"]`);
  }

  if (facts.parentTag !== null) {
    const parentPart =
      facts.parentClasses.length > 0
        ? `${facts.parentTag}.${facts.parentClasses.map(escapeIdent).join(".")}`
        : facts.parentTag;
    add(`${parentPart} > ${ownWithClass}`);
  }

  return candidates;
}

/**
 * Tests one strategy in isolation and answers the only question worth
 * answering: does this strategy resolve to exactly one element, **and is
 * that element the one the model touched**?
 *
 * The uniqueness half alone — which is all this function used to check — is
 * true and useless. "Exactly one element on this page matches this
 * strategy" and "that element is the control the model acted on" are
 * different statements, and only the second is what replay needs. Two
 * concrete ways the first can hold while the second fails, both demonstrated
 * against live markup:
 *
 *  - **Tier 1.** `walk`'s role/name heuristic (`observe/snapshot.ts`) and
 *    Playwright's accessible-name computation are two different functions.
 *    An `aria-hidden="true"` button named "Save" beside a real one is
 *    observed by `walk` (which has no `aria-hidden` clause) and excluded by
 *    `getByRole` (which does) — so the strategy generated *from the ghost*
 *    resolves, uniquely, to the real button. Both are `<button>`, so a `tag`
 *    fingerprint waves it through.
 *  - **Tier 3.** `readProvingFacts` above checks that the target *qualifies*
 *    for a relation; `anchorResolve` returns the *nearest* qualifier.
 *    Qualifying is not winning: a nearer same-tag element takes the match,
 *    and `accepts: [facts.tag]` guarantees the wrong element shares the
 *    target's tag, so the `tag` fingerprint can never catch this one.
 *
 * The comparison is by observation handle, not by locator equality. The
 * target carries `OBS_ATTR` (stamped by `observe()`, unique on the page —
 * `proveControl` checks that first), and `resolveBinding` reports the
 * `HANDLE_ATTR` stamp of whatever it landed on, so reading `OBS_ATTR` back
 * off that element and comparing strings is an identity test with no second
 * notion of "the same element" to get wrong.
 *
 * Everything failing — no match, ambiguous, a thrown error from a malformed
 * guess such as an invalid role string, a `HANDLE_ATTR` selector that
 * matches more than one element because the page cloned a stamped node — is
 * treated as "did not prove" rather than propagated. A bad guess must not
 * abort the search for a good one, and every one of those outcomes fails
 * closed: the candidate is rejected, never recorded.
 */
async function resolvesToTarget(page: Page, strategy: Strategy, obsHandle: string): Promise<boolean> {
  try {
    const res = await resolveBinding(page, { scope: [], chain: [strategy] }, {});
    if (!res.ok) return false;
    const landedOn = await page
      .locator(`[${HANDLE_ATTR}="${res.handle}"]`)
      .evaluate((el, attr) => el.getAttribute(attr), OBS_ATTR);
    return landedOn === obsHandle;
  } catch {
    return false;
  }
}

/**
 * Turns the `ObservedNode` the model touched into a `Binding` whose every
 * strategy was proven, live, to resolve to exactly one element on this page
 * *and* to resolve to this element — see `resolvesToTarget`, which is where
 * both halves are checked and where the second half used to be missing.
 *
 * Throws if `node.handle` does not match exactly one element under
 * `OBS_ATTR` — covering both a stale handle (from a prior, since-renumbered
 * observation) and a handle that was never stamped at all — and throws
 * again, separately, if every candidate strategy this function can generate
 * fails to resolve uniquely to that element. The second case is the one the
 * design exists to prevent: rather than emit a chain that might resolve
 * ambiguously, or cleanly onto some other control, the next time this page
 * is visited, `proveControl` refuses to produce a binding at all.
 *
 * Candidate generation deliberately excludes two shapes that would make
 * "proving" vacuous: an `id`-based CSS selector, and a full ancestor path.
 * Both would very likely resolve uniquely for almost anything — an `id` is
 * supposed to be document-unique, and an absolute path is unique to its
 * element by construction — which would turn the ambiguous-buttons case in
 * `findtrans.html` (each of the four "Find Transactions" buttons carries its
 * own `id`) into a false pass: a chain that "proves unique" today for a
 * reason that has nothing to do with anything a human, or the model, would
 * recognise as identifying that control, and everything to do with an
 * incidental attribute an id-per-button-happens-to-exist markup style
 * supplies for free. `data-testid` (tier 0) is the sanctioned way to give a
 * control a stable, automation-facing identity; an unmarked `id` borrowed
 * for the same purpose is not that contract, so this function does not treat
 * it as one.
 *
 * Ordering (see the task report for the full reasoning): `testid` first
 * whenever it survives, then anchor, then role, then css — a fixed
 * brittleness-based priority, not something `resolveBinding`'s `attempts`
 * can supply across tiers (a strategy that independently resolves always
 * wins immediately, with zero attempts, wherever it is placed in a probe
 * chain — `attempts` cannot rank two things that both win on the first
 * try). Within tier 2's own escalating family of selectors the first
 * candidate that proves — weakest first — is the one kept.
 */
export async function proveControl(page: Page, node: ObservedNode): Promise<Binding> {
  const loc = page.locator(`[${OBS_ATTR}="${node.handle}"]`);
  const count = await loc.count();
  if (count !== 1) {
    throw new Error(
      `proveControl: handle "${node.handle}" matches ${count} element(s) under ${OBS_ATTR} (expected exactly 1). ` +
        `A handle is valid only for the observation that produced it; this one is either stale or was never stamped.`,
    );
  }

  const facts = await loc.evaluate(readProvingFacts);
  const survivors: Strategy[] = [];

  if (facts.testid !== null && facts.testid !== "") {
    const s: Strategy = { tier: 0, by: "testid", value: facts.testid };
    if (await resolvesToTarget(page, s, node.handle)) survivors.push(s);
  }

  if (node.name !== "") {
    const s: Strategy = { tier: 1, by: "role", role: node.role, name: node.name };
    if (await resolvesToTarget(page, s, node.handle)) survivors.push(s);
  }

  // Weakest candidate first, and the first one that resolves *to this
  // element* is the one kept. This used to run the whole family as a single
  // combined chain and recover the winner from `attempts.length`, which was
  // neat and is no longer available: `resolveBinding` stops at the first rung
  // that resolves uniquely, so a weak selector landing uniquely on some other
  // element would end the chain there and hide the stronger candidate that
  // would have identified the target. Trying them one at a time costs a few
  // extra round trips at record time and cannot skip the right answer.
  for (const value of buildCssCandidates(facts)) {
    const s: Strategy = { tier: 2, by: "css", value };
    if (await resolvesToTarget(page, s, node.handle)) {
      survivors.push(s);
      break;
    }
  }

  if (facts.anchor !== null) {
    const s: Strategy = {
      tier: 3,
      by: "anchor",
      anchorText: facts.anchor.text,
      rel: facts.anchor.rel,
      accepts: [facts.tag],
    };
    if (await resolvesToTarget(page, s, node.handle)) survivors.push(s);
  }

  if (survivors.length === 0) {
    throw new Error(
      `proveControl: no candidate strategy resolves handle "${node.handle}" uniquely to the element it names ` +
        `on this page. Refusing to emit a binding that would resolve ambiguously — or to a different element — ` +
        `at replay time.`,
    );
  }

  const RANK: Record<0 | 1 | 2 | 3, number> = { 0: 0, 3: 1, 1: 2, 2: 3 };
  survivors.sort((a, b) => RANK[a.tier] - RANK[b.tier]);

  // Record a fingerprint so resolution rule 3 — "fingerprint and stability
  // must both hold" — is something an artifact actually carries rather than a
  // rule that holds because nothing tests it. Without this every binding this
  // phase produces skips the check entirely at replay.
  //
  // `tag` only, deliberately. A fingerprint answers "is this the kind of thing
  // I recorded" — it catches a binding that now resolves to a `div` where it
  // recorded an `input`, which is the structural drift worth catching. It is
  // NOT a record-identity check and NOT a business-range assertion.
  //
  // `matches` is left unset rather than inferred from the element's current
  // text. Phase 1 shipped an inferred currency fingerprint that rejected
  // negative balances, so a legitimately overdrawn account was reported as a
  // resolution failure and an operator was sent to debug a targeting problem
  // that did not exist. Guessing a format class from one observed value
  // reproduces that defect by construction: the one sample is always
  // consistent with itself. A caller who knows the format can set `matches`
  // deliberately; the recorder will not invent one.
  return { scope: [], chain: survivors, fingerprint: { tag: facts.tag } };
}
