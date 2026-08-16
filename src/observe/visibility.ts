// src/observe/visibility.ts
import type { Locator } from "playwright";

/**
 * Whether an element is actually rendered, evaluated inside the page.
 *
 * Written as one flat expression chain with no inner named bindings. `tsx`
 * transforms with esbuild `keepNames`, which rewrites a named inner function
 * into `__name(fn, "name")` where `__name` is a module-scope helper — and a
 * function serialised into the page is torn out of that scope, dying with
 * `ReferenceError: __name is not defined`. Same constraint, same reason and
 * same shape as `controlNamesOf` in actor.ts and the measurement callback in
 * `anchorResolve`. See tests/surface/evaluate-serialisation.test.ts, which
 * discovers this function via its call site below and checks the shipping
 * (esbuild `keepNames`) transform of its body in a scope as bare as the page's.
 *
 * Offscreen is deliberately NOT hidden: a control below the fold is real and
 * clickable after scrolling. What disqualifies an element is being
 * unrenderable, not being unscrolled — so this checks display, visibility,
 * opacity and box area, and stops there.
 *
 * This is the one predicate every resolver tier and the observer agree on.
 * Before this existed, ParaBank's hidden success/error nodes resolved at
 * tier 2 (css) and tier 0 (testid) — fingerprint and all — while tier 1
 * (role+name) rejected the same node, because accessible-name computation
 * already excludes it. The ladder disagreed with itself; this closes that.
 */
export function isRenderedIn(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return el.isConnected;
}

/**
 * Filters resolver candidates down to the ones actually rendered.
 *
 * One `evaluate` round trip per locator, run concurrently. Each call passes
 * `isRenderedIn` straight through as the page function rather than wrapping
 * it in another arrow: the text Playwright serialises is then exactly
 * `isRenderedIn`'s own self-contained body, and nothing reaches back into
 * this module's scope to do it. A wrapper that closed over the imported name
 * instead (`(el) => isRenderedIn(el)`) would ship an unresolvable reference —
 * the same class of defect this file exists to prevent — and the call site
 * has to live here, in the same module as the declaration, because that is
 * what lets `tests/surface/evaluate-serialisation.test.ts` resolve a bare
 * identifier argument to a checkable function body at all.
 */
export async function filterRendered(matches: Locator[]): Promise<Locator[]> {
  const rendered = await Promise.all(matches.map((loc) => loc.evaluate(isRenderedIn)));
  return matches.filter((_loc, i) => rendered[i]);
}
