// src/surface/playwright-web/resolver.ts
import type { Locator, Page } from "playwright";
import {
  scopeKey,
  type Attempt,
  type Binding,
  type Fingerprint,
  type Handle,
  type Resolution,
  type Strategy,
} from "../types.js";
import { filterRendered } from "../../observe/visibility.js";

/** Every strategy the resolver can turn into a plain Playwright locator. */
type LocatableStrategy = Exclude<Strategy, { by: "anchor" }>;

/**
 * Attribute used to pin a resolved element across the evaluate boundary.
 *
 * Exported because the actor has to find its way back to a resolved element by
 * this attribute and nothing else. Duplicating the literal there would put the
 * resolver's output contract in two places, and a silent divergence would look
 * like "the element vanished" rather than "the two halves disagree".
 */
export const HANDLE_ATTR = "data-dca-handle";

/**
 * A placeholder is `$` followed by an identifier — leading letter or underscore.
 * Digits are deliberately excluded so ordinary currency text (`Total: $100`, which
 * is everywhere in a banking UI) is literal content rather than an unbound
 * placeholder that would now throw.
 */
const PLACEHOLDER = /\$([A-Za-z_]\w*)/g;

/**
 * An unbound placeholder must never reach a locator. Left as a literal it produces
 * a selector or anchor text that silently matches nothing — or worse, something
 * unintended — and the caller cannot tell that outcome apart from a legitimately
 * absent element. At a targeting boundary the only safe failure is a loud one.
 */
function subst(text: string, args: Record<string, string>, where: string): string {
  return text.replace(PLACEHOLDER, (_whole, key: string) => {
    const value = args[key];
    if (value === undefined) {
      throw new Error(`Unbound placeholder "$${key}" in ${where}`);
    }
    return value;
  });
}

function describe(s: Strategy, field: string): string {
  return `tier ${s.tier} ${s.by} strategy (${field})`;
}

/**
 * Anchor strategies never reach here — `resolveBinding` routes them to
 * `anchorResolve`, which needs geometry rather than a selector. The parameter
 * type makes that unreachability a compile-time fact, so the switch is total
 * over exactly the three selector-shaped strategies.
 */
function locatorFor(page: Page, s: LocatableStrategy, args: Record<string, string>): Locator {
  switch (s.by) {
    case "testid":
      return page.locator(`[data-testid="${subst(s.value, args, describe(s, "value"))}"]`);
    case "role":
      return page.getByRole(s.role as Parameters<Page["getByRole"]>[0], {
        name: subst(s.name, args, describe(s, "name")),
        exact: true,
      });
    case "css":
      return page.locator(subst(s.value, args, describe(s, "value")));
  }
}

/**
 * Read-before-write, so re-resolving the same element yields the same handle.
 *
 * This logic is duplicated verbatim inside `anchorResolve`'s `page.evaluate`. It has
 * to be: an evaluate callback is serialised and cannot close over module scope. The
 * two copies must stay identical.
 */
async function stampHandle(loc: Locator): Promise<Handle> {
  return loc.evaluate((el, attr) => {
    const existing = el.getAttribute(attr);
    if (existing !== null) return existing;
    const id = `h${Math.random().toString(36).slice(2, 10)}`;
    el.setAttribute(attr, id);
    return id;
  }, HANDLE_ATTR);
}

/**
 * Tier 3: anchor-relative resolution. Find the anchor's text, then the nearest
 * accepted control in the declared direction — `nearest-right` on the same
 * visual row, or `nearest-below`/`nearest-above` in the same visual column.
 * Geometry, not markup — this is the tier that survives unassociated labels.
 * `nearest-below` exists because ParaBank's own login form needs it: measured
 * live, the `Username` label sits at y=287-302 and its input at y=305-323,
 * same x — stacked, not side by side, so `nearest-right` cannot reach it.
 *
 * The anchor box is measured from the *text node* with a DOM Range rather than
 * from an element locator. `page.locator('text="X"')` returns the smallest
 * *element* containing the text, which for a bare text node among sibling
 * elements (`<div>Between <input> and <input></div>`) is the whole container:
 * a full-width box that makes "to the right" unsatisfiable and "same row"
 * meaningless. A Range around the text node measures the glyphs themselves.
 *
 * All measurement happens inside a single `page.evaluate` so anchor and
 * candidate rectangles share one coordinate space and one layout pass. That
 * callback is serialised into the page and must therefore stay free of *any*
 * named inner binding, not merely of module references — see the note beside
 * `EPSILON`, and `tests/surface/evaluate-serialisation.test.ts`, which enforces
 * it for every callback this codebase sends into a page.
 *
 * The winners are stamped with their handle *in that same evaluate*, and the handle
 * strings — not indices — come back out. Returning an index would mean re-deriving
 * the element with `page.locator(selector).nth(i)`, which assumes Playwright's CSS
 * engine enumerates in the same order as `document.querySelectorAll`. It does not:
 * Playwright pierces open shadow roots and `querySelectorAll` does not, so a single
 * accepted control inside a shadow root shifts the lists out of correspondence and
 * `.nth(i)` silently returns an element other than the one measured — exactly the
 * wrong-element resolution this component exists to prevent. Stamping in-page also
 * closes the time-of-check/time-of-use window that a lazy locator would reopen.
 */
async function anchorResolve(
  page: Page,
  s: Extract<Strategy, { by: "anchor" }>,
  args: Record<string, string>,
): Promise<Locator[]> {
  const anchorText = subst(s.anchorText, args, describe(s, "anchorText"));
  const selector = s.accepts.join(",");
  if (anchorText.trim() === "" || selector === "") return [];

  const handles = await page.evaluate(
    ({
      anchorText,
      selector,
      attr,
      rel,
    }: {
      anchorText: string;
      selector: string;
      attr: string;
      rel: "nearest-right" | "nearest-below" | "nearest-above";
    }): string[] => {
      // Sub-pixel slack for float comparison of layout coordinates.
      const EPSILON = 0.5;
      // Whitespace normalisation is written out at both use sites rather than
      // factored into a `norm` helper. An inner *named* binding is precisely
      // what esbuild's `keepNames` rewrites — `const norm = __name((v) => …,
      // "norm")` — and `__name` is a module-scope helper the page has never
      // heard of, so the serialised body dies with `ReferenceError: __name is
      // not defined`. Same constraint, same reason and same shape as
      // `controlNamesOf` in actor.ts.
      const target = anchorText.replace(/\s+/g, " ").trim();

      const anchors: DOMRect[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.nodeValue ?? "").replace(/\s+/g, " ").trim() !== target) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) anchors.push(rect);
      }
      if (anchors.length === 0) return [];

      const candidates = Array.from(document.querySelectorAll(selector));
      const picked = new Set<Element>();

      for (const a of anchors) {
        // Collect every qualifying control, then take the minimum in a second
        // pass. Selecting during the scan would make the outcome depend on
        // iteration order whenever two candidates are equally near.
        //
        // `primary` is the ranking distance for the declared relation — the
        // rightward gap for `nearest-right`, the vertical gap for
        // `nearest-below`/`nearest-above`. `secondary` breaks a primary-distance
        // tie for the below/above relations (horizontal offset from the anchor);
        // it is fixed at 0 for `nearest-right`, which ranks on the single gap it
        // always has.
        const qualified: Array<{ el: Element; primary: number; secondary: number }> = [];
        for (const el of candidates) {
          // Inlined from `isRenderedIn` in observe/visibility.ts — an evaluate
          // callback cannot close over module scope, so the two copies must stay
          // identical. Before this fold-in, this gate only rejected zero-area
          // elements, so a `visibility:hidden` or `opacity:0` control with real
          // layout area still qualified as a tier-3 candidate while tiers 0-2
          // (via `filterRendered`) rejected the same node — the ladder
          // disagreeing with itself, exactly what the shared predicate exists to
          // close everywhere else.
          const style = window.getComputedStyle(el);
          if (style.display === "none") continue;
          if (style.visibility === "hidden" || style.visibility === "collapse") continue;
          if (Number(style.opacity) === 0) continue;
          if (!el.isConnected) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;

          if (rel === "nearest-right") {
            const sameRow = b.top < a.bottom && b.bottom > a.top;
            const toTheRight = b.left >= a.right - EPSILON;
            if (!sameRow || !toTheRight) continue;
            qualified.push({ el, primary: b.left - a.right, secondary: 0 });
          } else if (rel === "nearest-below") {
            const midY = b.top + b.height / 2;
            const overlapsColumn = b.left < a.right && b.right > a.left;
            const isBelow = midY > a.bottom - EPSILON;
            if (!overlapsColumn || !isBelow) continue;
            qualified.push({ el, primary: b.top - a.bottom, secondary: Math.abs(b.left - a.left) });
          } else {
            const midY = b.top + b.height / 2;
            const overlapsColumn = b.left < a.right && b.right > a.left;
            const isAbove = midY < a.top + EPSILON;
            if (!overlapsColumn || !isAbove) continue;
            qualified.push({ el, primary: a.top - b.bottom, secondary: Math.abs(b.left - a.left) });
          }
        }
        if (qualified.length === 0) continue;

        // "Nearest" is a total order only while the primary distances differ.
        // Equidistant controls — nested, overlapping, or absolutely positioned —
        // are a genuine tie, and picking the first would be first-of-many by
        // another name.
        let minPrimary = Number.POSITIVE_INFINITY;
        for (const q of qualified) if (q.primary < minPrimary) minPrimary = q.primary;
        const nearest = qualified.filter((q) => q.primary - minPrimary <= EPSILON);

        if (nearest.length === 1) {
          picked.add(nearest[0]!.el);
          continue;
        }

        // The primary distance ties — break it on the secondary key. Every
        // winner still tied after that is kept, so the chain reports
        // `ambiguous` through its normal path rather than this function
        // guessing on the caller's behalf.
        let minSecondary = Number.POSITIVE_INFINITY;
        for (const q of nearest) if (q.secondary < minSecondary) minSecondary = q.secondary;
        for (const q of nearest) if (q.secondary - minSecondary <= EPSILON) picked.add(q.el);
      }

      // One control per anchor occurrence. If the anchor text itself occurs in
      // several places and they point at different controls, the caller sees
      // more than one match and reports ambiguity — as it must.
      //
      // Duplicated from `stampHandle`; an evaluate callback cannot close over module
      // scope. The two copies must stay identical.
      return [...picked].map((el) => {
        const existing = el.getAttribute(attr);
        if (existing !== null) return existing;
        const id = `h${Math.random().toString(36).slice(2, 10)}`;
        el.setAttribute(attr, id);
        return id;
      });
    },
    { anchorText, selector, attr: HANDLE_ATTR, rel: s.rel },
  );

  return handles.map((h) => page.locator(`[${HANDLE_ATTR}="${h}"]`));
}

async function fingerprintHolds(loc: Locator, fp: Fingerprint | undefined): Promise<boolean> {
  if (!fp) return true;
  if (fp.tag) {
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    if (tag !== fp.tag.toLowerCase()) return false;
  }
  if (fp.matches) {
    const text = (await loc.textContent().catch(() => null)) ?? "";
    // Form controls have no text content; their observable value is what a
    // fingerprint is actually about.
    const probe = text.trim() !== "" ? text : await loc.inputValue().catch(() => "");
    if (!new RegExp(fp.matches).test(probe.trim())) return false;
  }
  // `fp.stableForMs` is deliberately not enforced here. Settle-waiting belongs to
  // the actor's wait budget; this layer must never sleep. Declared, not yet honoured.
  return true;
}

export async function resolveBinding(
  page: Page,
  binding: Binding,
  args: Record<string, string>,
): Promise<Resolution> {
  // Frame and shadow descent is Phase 2 work, owned by the observer along with
  // element identity. Until then a scoped binding cannot be honoured — and the
  // wrong response to that is to resolve against the top document anyway, which
  // is what accepting-and-ignoring `scope` amounted to: a binding naming a frame
  // that does not exist came back `{ok:true, tier:2, handle}`, pointing at an
  // element in a document it never asked about.
  //
  // This throws rather than returning `{ok:false}` because the two say different
  // things. A resolution failure means "the element was not there"; this means
  // "this binding cannot be replayed by this resolver at all", which no amount
  // of retrying or falling through the chain will change. Same reasoning as the
  // unbound-placeholder throw above.
  if (binding.scope.length > 0) {
    throw new Error(
      `Binding declares scope "${scopeKey(binding.scope)}", but frame and shadow descent are not implemented ` +
        `(Phase 2). Refusing to resolve against the top document instead.`,
    );
  }

  let sawAmbiguous: { tier: number; count: number } | null = null;
  // Every rung tried before the one that wins, in order. The winning rung
  // itself is never pushed here — it is reported through `tier`, not `attempts`.
  const attempts: Attempt[] = [];

  for (const strategy of binding.chain) {
    // Tier 3 (`anchorResolve`) already filters for rendering as part of its own
    // geometry pass. Tiers 0-2 filter here, in the same place their candidate
    // list is otherwise finished — before the ambiguity/uniqueness check runs
    // below — so a hidden node is rejected identically at every tier instead
    // of surviving at some and not others. See `isRenderedIn`.
    const matches =
      strategy.by === "anchor"
        ? await anchorResolve(page, strategy, args)
        : await filterRendered(await locatorFor(page, strategy, args).all());

    if (matches.length === 0) {
      attempts.push({ tier: strategy.tier, reason: "no-match" });
      continue;
    }
    if (matches.length > 1) {
      sawAmbiguous ??= { tier: strategy.tier, count: matches.length };
      attempts.push({ tier: strategy.tier, reason: "ambiguous" });
      continue; // never pick one — try the next strategy
    }

    const only = matches[0]!;
    if (!(await fingerprintHolds(only, binding.fingerprint))) {
      return { ok: false, reason: "fingerprint-mismatch", tier: strategy.tier };
    }

    // For an anchor match this is a no-op read: the element was already stamped
    // in-page, and read-before-write returns that same handle.
    return { ok: true, tier: strategy.tier, handle: await stampHandle(only), attempts };
  }

  if (sawAmbiguous) {
    return { ok: false, reason: "ambiguous", tier: sawAmbiguous.tier, count: sawAmbiguous.count };
  }
  return { ok: false, reason: "no-match" };
}
