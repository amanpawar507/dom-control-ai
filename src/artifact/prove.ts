// src/artifact/prove.ts
import type { Page } from "playwright";
import { OBS_ATTR } from "../observe/snapshot.js";
import { resolveBinding } from "../surface/playwright-web/resolver.js";
import type { Binding, Strategy } from "../surface/types.js";

/**
 * Record-time proving: turn a handle the model touched during discovery into
 * a `Binding` every rung of which was actually confirmed, live, to resolve
 * to exactly one element on THIS page, right now. That confirmation is the
 * whole point — a chain built from a plausible guess and never checked is a
 * hope, not a binding. See `proveControl` below for the entry point.
 *
 * `handle` here is an *observation* handle — the `oNnM`-shaped token
 * `observe()` stamps under `OBS_ATTR` (`src/observe/snapshot.ts`), not the
 * resolver's own `HANDLE_ATTR`. The two are deliberately different
 * attributes for different purposes (see the comment on `OBS_ATTR`), and
 * this file only ever reads the former. A handle from a stale (earlier)
 * observation matches nothing under `OBS_ATTR` — `observe()` clears and
 * renumbers on every call — so the very first step below fails loudly
 * instead of quietly resolving to whatever now occupies that slot.
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
  role: string;
  name: string;
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
 * Role and name are computed with the same priority order `observe()` uses
 * (aria-label, then associated `<label>`s, then trimmed text content) so a
 * tier-1 guess reflects what the model actually saw when it acted, not a
 * different heuristic that happens to live in a different file. The two
 * copies cannot be merged into one shared function — an evaluate callback
 * cannot call out to another module — so, as elsewhere in this codebase,
 * they are kept independently and deliberately close in shape.
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

  const inputType = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : "";
  const isButtonish =
    inputType === "submit" || inputType === "button" || inputType === "reset" || inputType === "image";

  let role = el.getAttribute("role");
  if (role === null) {
    if (tag === "a") role = "link";
    else if (tag === "button") role = "button";
    else if (tag === "textarea") role = "textbox";
    else if (tag === "select") role = (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    else if (tag === "input") {
      if (isButtonish) role = "button";
      else if (inputType === "checkbox") role = "checkbox";
      else if (inputType === "radio") role = "radio";
      else if (inputType === "range") role = "slider";
      else role = "textbox";
    } else role = tag;
  }

  let name = (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
  if (name === "") {
    const labels = (el as HTMLInputElement).labels;
    if (labels !== null && labels !== undefined && labels.length > 0) {
      let joined = "";
      for (const label of Array.from(labels)) joined += ` ${label.textContent ?? ""}`;
      name = joined.replace(/\s+/g, " ").trim();
    }
  }
  if (name === "") name = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (name === "" && tag === "input" && isButtonish) {
    name = ((el as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim();
  }

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

  return { tag, testid, role, name, classes, attrs, parentTag, parentClasses, anchor };
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
 * Tests one strategy in isolation — the same shape of call
 * `tests/artifact/prove.test.ts` uses to re-check every rung of the
 * returned chain. A strategy survives only if it resolves `ok: true` here;
 * anything else (no match, ambiguous, or a thrown error from a malformed
 * guess such as an invalid role string) is treated as "does not prove
 * unique" rather than propagated, because a bad guess must not abort the
 * search for a good one.
 */
async function provesUnique(page: Page, strategy: Strategy): Promise<boolean> {
  try {
    const res = await resolveBinding(page, { scope: [], chain: [strategy] }, {});
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Turns a handle the model touched into a `Binding` whose every strategy was
 * proven, live, to resolve to exactly one element on this page.
 *
 * Throws if `handle` does not match exactly one element under `OBS_ATTR` —
 * covering both a stale handle (from a prior, since-renumbered observation)
 * and a handle that was never stamped at all — and throws again, separately,
 * if every candidate strategy this function can generate fails to resolve
 * uniquely. The second case is the one the design exists to prevent: rather
 * than emit a chain that might resolve ambiguously the next time this page
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
 * try). `attempts.length` is used instead where it is actually informative:
 * choosing among tier 2's own escalating family of selectors, run as one
 * combined chain so the resolver's own bookkeeping — not a second one this
 * function would otherwise have to keep by hand — says how many weaker
 * guesses were tried before one stuck.
 */
export async function proveControl(page: Page, handle: string): Promise<Binding> {
  const loc = page.locator(`[${OBS_ATTR}="${handle}"]`);
  const count = await loc.count();
  if (count !== 1) {
    throw new Error(
      `proveControl: handle "${handle}" matches ${count} element(s) under ${OBS_ATTR} (expected exactly 1). ` +
        `A handle is valid only for the observation that produced it; this one is either stale or was never stamped.`,
    );
  }

  const facts = await loc.evaluate(readProvingFacts);
  const survivors: Strategy[] = [];

  if (facts.testid !== null && facts.testid !== "") {
    const s: Strategy = { tier: 0, by: "testid", value: facts.testid };
    if (await provesUnique(page, s)) survivors.push(s);
  }

  if (facts.name !== "") {
    const s: Strategy = { tier: 1, by: "role", role: facts.role, name: facts.name };
    if (await provesUnique(page, s)) survivors.push(s);
  }

  const cssCandidates = buildCssCandidates(facts);
  if (cssCandidates.length > 0) {
    const chain: Strategy[] = cssCandidates.map((value) => ({ tier: 2, by: "css", value }));
    try {
      const res = await resolveBinding(page, { scope: [], chain }, {});
      // Every candidate in this family shares tier 2, so `attempts.length`
      // (the count of rungs tried and rejected before the winner) is exactly
      // the winner's own index in `chain` — the resolver's bookkeeping
      // doubles as the answer to "which candidate string won" for free.
      if (res.ok) {
        const winner = chain[res.attempts.length];
        if (winner !== undefined) survivors.push(winner);
      }
    } catch {
      // A malformed candidate (should not happen given the escaping above,
      // but this boundary fails closed rather than aborting the search).
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
    if (await provesUnique(page, s)) survivors.push(s);
  }

  if (survivors.length === 0) {
    throw new Error(
      `proveControl: no candidate strategy resolves handle "${handle}" to a unique element on this page. ` +
        `Refusing to emit a binding that would resolve ambiguously at replay time.`,
    );
  }

  const RANK: Record<0 | 1 | 2 | 3, number> = { 0: 0, 3: 1, 1: 2, 2: 3 };
  survivors.sort((a, b) => RANK[a.tier] - RANK[b.tier]);

  return { scope: [], chain: survivors };
}
