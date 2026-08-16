// src/observe/snapshot.ts
import type { Page } from "playwright";

/**
 * The attribute an observation stamps, deliberately NOT the resolver's
 * `HANDLE_ATTR`. The two systems address elements for different reasons — the
 * resolver proves a recorded binding, an observation hands the model a
 * one-turn token — and sharing one attribute meant each silently clobbered the
 * other's stamps.
 */
export const OBS_ATTR = "data-dca-obs";

/**
 * Observation counter. Handles are qualified with it (`o7n3`), which is what
 * makes a stale handle fail instead of quietly hitting the wrong element.
 *
 * Module-level rather than per-page on purpose: a handle must not be
 * accidentally valid on a different page either, and a monotonic counter
 * across the process gives that for free.
 */
let epoch = 0;

/**
 * What the model sees, and only what the model sees.
 *
 * `handle` is the sole address a caller may use to act on this node — never a
 * selector, an id, a class, or a tag name. The model is handed `ObservedNode`
 * values and a typed action vocabulary (`click`, `fill`, …) that takes a
 * `handle`; it is never given anything it could paste into a locator, which
 * is what makes record-time proving (Task 6) meaningful — there is no
 * brittle string for the model to smuggle into a recorded binding, because
 * it was never in its hands to begin with.
 */
export interface ObservedNode {
  handle: string;
  role: string;
  name: string;
  value: string | null;
  editable: boolean;
}

export interface Observation {
  url: string;
  title: string;
  nodes: ObservedNode[];
  screenshot: string | null;
}

/**
 * Elements worth showing the model: things it can click, fill, or read as a
 * label. This is deliberately narrower than "every element with layout" —
 * dumping the whole DOM would drown a handful of real controls in structural
 * `div`s and `span`s and burn tokens doing it. Anything with an explicit
 * `role` is included regardless of tag, so an app that hand-rolls ARIA on a
 * `div` is still reachable.
 */
const OBSERVABLE_SELECTOR =
  'a[href], button, input, textarea, select, [role], [contenteditable=""], [contenteditable="true"]';

/**
 * Runs inside the page. Must not close over module scope — an evaluate
 * callback is serialised with `toString` and re-parsed in the page, where the
 * only scope is the page's own globals. `selector` and `attr` therefore
 * arrive as the evaluate *argument*, exactly as `anchorResolve` in
 * `resolver.ts` passes `HANDLE_ATTR` in rather than referencing the imported
 * constant from inside the callback — a closure over an import is a
 * `ReferenceError` in the browser, not a compile error here.
 *
 * The same constraint forbids inner *named* function bindings, not just
 * outside references: `tsx` runs every shipping entry point through esbuild
 * with `keepNames`, which rewrites `const norm = (v) => …` into
 * `const norm = __name((v) => …, "norm")`, and `__name` is a module-scope
 * helper the page has never heard of. This body stays flat — one loop, plain
 * `const`/`let` bindings holding values rather than functions — for exactly
 * the reason `anchorResolve`'s measurement callback does the same, and
 * `tests/surface/evaluate-serialisation.test.ts` applies the shipping
 * transform to this file and checks the result the same way it checks that
 * one.
 *
 * The visibility check inlined below is `isRenderedIn` from
 * `observe/visibility.ts`, copied rather than imported for the same reason:
 * a call site inside this callback would be a reference to another module's
 * top-level function, and an evaluate callback cannot reach it. The two
 * copies must stay identical — this is the same predicate every resolver
 * tier agrees on, so a node the resolver would refuse to resolve is never
 * shown to the model as something it can address.
 *
 * Handles are stamped in this same walk, immediately after an element is
 * accepted, closing the time-of-check/time-of-use gap a separate stamping
 * pass would reopen (see `stampHandle` in `resolver.ts`, which this follows).
 *
 * A handle is valid only for the observation that produced it, and that is
 * enforced here rather than asked of callers. Two things together make a
 * stale handle fail loudly instead of resolving to some other element, and
 * neither is sufficient alone:
 *
 *   1. Every stamp from a previous observation is cleared at the top of this
 *      same pass. Without it, an element that was observable last turn and is
 *      hidden or unobservable this turn would keep its old handle and still
 *      match.
 *   2. Handles carry the observation epoch (`o7n3`). Without it, clearing
 *      alone would let `n3` from the previous turn match whatever happens to
 *      be `n3` in this one — a different element, silently.
 *
 * The result needs no check at the call site, so there is no check anyone can
 * forget: a handle from an earlier epoch matches nothing, and the existing
 * exactly-one-match-or-fail path reports it. This is the same lesson as the
 * Phase 1 policy gate, which was keyed on a name the caller supplied and was
 * therefore safe only while every caller was honest.
 */
async function walk(page: Page, ep: number): Promise<ObservedNode[]> {
  return page.evaluate(
    ({ selector, attr, ep }: { selector: string; attr: string; ep: number }) => {
      const results: Array<{
        handle: string;
        role: string;
        name: string;
        value: string | null;
        editable: boolean;
      }> = [];
      let counter = 0;

      // Clear first, in this same pass — see point 1 above.
      for (const stale of Array.from(document.querySelectorAll(`[${attr}]`))) {
        stale.removeAttribute(attr);
      }

      for (const el of Array.from(document.querySelectorAll(selector))) {
        // Inlined from `isRenderedIn` — see the note above this function.
        const style = window.getComputedStyle(el);
        if (style.display === "none") continue;
        if (style.visibility === "hidden" || style.visibility === "collapse") continue;
        if (Number(style.opacity) === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (!el.isConnected) continue;

        const tag = el.tagName.toLowerCase();
        const contentEditableAttr = el.getAttribute("contenteditable");
        const isContentEditable =
          contentEditableAttr === "" ||
          contentEditableAttr === "true" ||
          (el as HTMLElement).isContentEditable === true;
        const inputType = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : "";
        // The set of input types that trigger an action rather than hold
        // data. `editable` (below) and `role` both key off this: a submit
        // button is not something the model "fills", however literally an
        // <input> it is.
        const isButtonish = inputType === "submit" || inputType === "button" || inputType === "reset" || inputType === "image";

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
          } else if (isContentEditable) role = "textbox";
          else role = tag;
        }

        // Name: aria-label, then an associated <label>, then trimmed text
        // content, then (only for a button-shaped input, which has no text
        // content of its own) its value.
        let name = (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
        if (name === "") {
          // Only form controls carry `.labels` at all — a bare `<a>` or
          // `<div role="button">` has it as `undefined`, not `null`, so both
          // have to be ruled out before `.length` is read.
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

        let value: string | null = null;
        if (tag === "input" && !isButtonish) value = (el as HTMLInputElement).value;
        else if (tag === "textarea") value = (el as HTMLTextAreaElement).value;
        else if (tag === "select") value = (el as HTMLSelectElement).value;
        else if (isContentEditable) value = el.textContent ?? "";

        const editable = (tag === "input" && !isButtonish) || tag === "textarea" || tag === "select" || isContentEditable;

        const handle = `o${ep}n${counter}`;
        counter += 1;
        el.setAttribute(attr, handle);

        results.push({ handle, role, name, value, editable });
      }

      return results;
    },
    { selector: OBSERVABLE_SELECTOR, attr: OBS_ATTR, ep },
  );
}

/**
 * One turn's worth of what the model can see: every addressable node, plus
 * enough page identity (`url`, `title`) to know where it is.
 *
 * The screenshot is opt-in and omitted by default — images dominate token
 * cost, and most turns need only the structural snapshot above. When asked
 * for, it is a jpeg at quality 60 rather than a lossless png, for the same
 * reason.
 */
export async function observe(page: Page, opts?: { screenshot?: boolean }): Promise<Observation> {
  epoch += 1;
  const nodes = await walk(page, epoch);

  let screenshot: string | null = null;
  if (opts?.screenshot === true) {
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    screenshot = buf.toString("base64");
  }

  return {
    url: page.url(),
    title: await page.title(),
    nodes,
    screenshot,
  };
}
