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
    // A module that drives the page and never calls `gate` is a path that acts
    // without a verdict. `prove.ts`, `snapshot.ts` and the session provider
    // read or authenticate rather than act on the model's behalf, so they are
    // exempt — named individually, because an exemption pattern would quietly
    // grow to cover the next offender.
    //
    // Two things this got wrong the first time, both worth stating because
    // both made it report safety it was not providing:
    //
    // The verb list was four entries. `.press(`, `.check(`, `.uncheck(`,
    // `.dispatchEvent(`, `.setInputFiles(`, `.goBack(` and `keyboard.type` all
    // drive a page and all sailed past.
    //
    // And it searched raw source for `gate(`, so the word appearing in a
    // *comment* satisfied it. Comments are stripped first; a module now has to
    // actually call it.
    const ACTS =
      /(?:\.click\(|\.fill\(|\.selectOption\(|\.goto\(|\.press\(|\.check\(|\.uncheck\(|\.dispatchEvent\(|\.setInputFiles\(|\.goBack\(|\.goForward\(|keyboard\.type\()/;
    const EXEMPT = new Set([
      "src/artifact/prove.ts",
      "src/observe/snapshot.ts",
      "src/session/playwright-state.ts",
    ]);
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    const ungated = walk(SRC).filter((f) => {
      if (EXEMPT.has(f)) return false;
      const code = stripComments(readFileSync(f, "utf8"));
      return ACTS.test(code) && !/\bgate\(/.test(code);
    });
    expect(ungated).toEqual([]);
  });

  it("exempts only modules that genuinely do not act for the model", () => {
    // The exemption list above is the guard's one soft spot: anything added to
    // it stops being checked. This pins *why* each entry is there, so removing
    // a module's read-only character without removing its exemption is caught.
    //
    // What replaced the test that used to sit here: it called `gate` twice with
    // the same argument and asserted the results matched, which is true of any
    // pure function and exercised neither act path. A tautology in a file whose
    // subject is "prove the safety property" is worse than a gap, because it
    // reads as coverage.
    const forbidden = /(?:\.click\(|\.fill\(|\.selectOption\(|\.press\()/;
    for (const f of ["src/artifact/prove.ts", "src/observe/snapshot.ts"]) {
      const code = readFileSync(f, "utf8");
      expect(forbidden.test(code), `${f} is exempt but now acts on the page`).toBe(false);
    }
  });
});
