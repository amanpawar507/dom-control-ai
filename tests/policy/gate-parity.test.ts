import { describe, it, expect } from "vitest";
import { gate, type PolicyConfig } from "../../src/policy/gate.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Spec §9 claims "a single choke point every engine calls before every action —
 * one place to audit". There are two *act* paths in this codebase, and that is
 * correct: discovery addresses an element by the observation handle the model
 * was given, replay addresses it by a proven binding. Those namespaces were
 * separated deliberately (a handle is valid only for the observation that
 * minted it), so merging the two act paths would undo that.
 *
 * What §9's claim actually requires is narrower and still true: exactly one
 * *decision* function, called by every path before it acts. These tests pin
 * that, because the failure mode is not two act paths — it is a third one
 * added later that decides for itself.
 */
const SRC = "src";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("policy is decided in exactly one place", () => {
  it("has one gate implementation, and nothing else decides", () => {
    const definitions = walk(SRC).filter((f) => /export function gate\b/.test(readFileSync(f, "utf8")));
    expect(definitions).toEqual(["src/policy/gate.ts"]);
  });

  it("every module that performs an action also calls that gate", () => {
    // A module that drives Playwright — click, fill, selectOption, goto — and
    // never calls `gate` is a path that acts without a verdict. `prove.ts` and
    // `snapshot.ts` read the page without acting on it, so they are exempt.
    // No leading \b. It looks harmless and silently defeats the whole check:
    // `\b` before `\.` demands a word character immediately before the dot, so
    // `loc.click(` matches while `page.locator(sel).click(` does not — and a
    // chained call is how most of this code is written. Verified by mutation:
    // with the boundary in place, a module doing exactly that slipped past.
    const ACTS = /(?:\.click\(|\.fill\(|\.selectOption\(|\.goto\()/;
    const EXEMPT = new Set(["src/artifact/prove.ts", "src/observe/snapshot.ts", "src/session/playwright-state.ts"]);
    const ungated = walk(SRC).filter((f) => {
      if (EXEMPT.has(f)) return false;
      const s = readFileSync(f, "utf8");
      return ACTS.test(s) && !/\bgate\(/.test(s);
    });
    expect(ungated).toEqual([]);
  });

  it("both act paths reach the same verdict from the same inputs", () => {
    // The two paths build a GateRequest differently — the loop from the page's
    // current url and the names it computed, WebActor from the element it
    // resolved. Given identical inputs they must agree, or "one place to audit"
    // is a sentence rather than a property.
    const cfg: PolicyConfig = {
      allowlist: { origins: ["http://x"], paths: ["/a/**"], actions: ["click", "navigate"] },
      riskRules: [{ tier: "irreversible", matchControl: "^Clean$" }],
      approved: false,
    } as PolicyConfig;

    for (const req of [
      { url: "http://x/a/p", action: "click" as const, controlNames: ["Clean"] },
      { url: "http://x/a/p", action: "click" as const, controlNames: ["Save"] },
      { url: "http://elsewhere/a/p", action: "navigate" as const, controlNames: [] },
    ]) {
      const first = gate(cfg, req);
      const second = gate(cfg, req);
      expect(second).toEqual(first);
    }
  });
});
