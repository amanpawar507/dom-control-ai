// The visibility predicate exists three times — `isRenderedIn`
// (observe/visibility.ts) and two verbatim copies inlined into `page.evaluate`
// callbacks (`walk` in observe/snapshot.ts, `anchorResolve` in
// surface/playwright-web/resolver.ts). The copies are not laziness: an evaluate
// callback is serialised with `toString` and re-parsed in the page, where a
// call to another module's function is a `ReferenceError`
// (tests/surface/evaluate-serialisation.test.ts is the guard for that). So the
// duplication is forced, and the three have to be kept in agreement by
// something.
//
// What kept them in agreement was three behavioural tables — one per copy,
// each with a case for each clause. That covers clause *removal*: zero the
// `opacity` clause in any one copy and exactly one test goes red, in a
// different file each time. It structurally cannot cover clause *addition*,
// and the phase-2 review demonstrated it: adding an `aria-hidden` clause to
// `visibility.ts` alone left all 253 tests green, with the canonical predicate
// and its two copies then disagreeing about what exists and nothing in the
// suite saying so.
//
// That is the direction that matters. The whole of Critical 1 in that review
// was caused by `walk` and Playwright's role engine disagreeing about
// `aria-hidden`, so the next edit anyone makes to this predicate is a clause
// addition — the one case the behavioural tables are blind to.
//
// This test closes it from the other side: it reads the shipping source,
// finds every copy of the predicate by the marker they all share
// (`window.getComputedStyle`), extracts each copy's rejection clauses, and
// requires the sets to be equal. Adding a clause to one copy fails here until
// it is added to all of them; so does removing one, so does altering one. It
// is told nothing — no file is named and no clause is listed — so a fourth
// copy is checked the day it appears.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC_ROOT = "src";

interface Copy {
  /** `src/observe/snapshot.ts:130 (window.getComputedStyle)` */
  label: string;
  /**
   * Every condition under which this copy rejects an element, normalised so
   * that two copies written with different local variable names compare equal.
   */
  clauses: string[];
}

function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The innermost function containing `node`, or `undefined` at top level. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (isFunctionLike(n)) return n;
  }
  return undefined;
}

/**
 * Every statement of `fn`'s body in source order, without descending into
 * functions nested inside it.
 *
 * The bound matters: `anchorResolve`'s evaluate callback ends with a
 * `[...picked].map((el) => …)` whose parameter shadows the element identifier,
 * and reading its `if`s as though they belonged to the predicate would compare
 * a stamping routine against a visibility check.
 */
function statementsOf(fn: ts.Node): ts.Node[] {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body === undefined || !ts.isBlock(body)) return [];
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    if (isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/**
 * Whether `name` appears in `node`, not counting appearances inside a nested
 * function — where it is a different binding wearing the same spelling.
 *
 * `anchorResolve` ends with `[...picked].map((el) => …)`, whose parameter is
 * also called `el`. Counting that as a mention of the predicate's element made
 * the whole stamping routine read as a visibility clause.
 */
function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionLike(n)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The name a `const x = <init>` binds, when the initializer satisfies `match`. */
function bindingFor(statements: ts.Node[], match: (init: ts.Expression) => boolean): string | undefined {
  for (const node of statements) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (node.initializer === undefined || !ts.isIdentifier(node.name)) continue;
    if (match(node.initializer)) return node.name.text;
  }
  return undefined;
}

const printer = ts.createPrinter({ removeComments: true });

/**
 * A clause reduced to the form two independently written copies share:
 * local names replaced by their role, `as` casts and parentheses removed,
 * whitespace collapsed.
 *
 * Parenthesis removal is the one lossy step, and it is applied identically to
 * every copy, so it can only ever make two clauses compare *equal* that a
 * stricter reading would separate — never the reverse. That is the safe
 * direction for a guard whose failure mode is a missed disagreement rather
 * than a spurious one, and it is what lets `return el.isConnected` in the
 * canonical compare equal to `if (!el.isConnected) continue` in a copy.
 */
function normalise(expr: ts.Expression, file: ts.SourceFile, names: Record<string, string>): string {
  let text = printer.printNode(ts.EmitHint.Unspecified, expr, file);
  for (const [from, to] of Object.entries(names)) {
    text = text.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return text
    .replace(/\bas\s+[A-Za-z_$][\w$.<>[\]]*/g, "")
    .replace(/[()\s]/g, "");
}

function copiesIn(path: string): Copy[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const found: Copy[] = [];

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    if (!ts.isCallExpression(node)) return;
    const callee = printer.printNode(ts.EmitHint.Unspecified, node.expression, file);
    if (callee !== "window.getComputedStyle") return;

    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const label = `${path}:${line}`;

    const target = node.arguments[0];
    expect(target, `${label}: getComputedStyle with no argument`).toBeDefined();
    expect(
      target !== undefined && ts.isIdentifier(target),
      `${label}: this guard reads the predicate's element through a plain identifier; ` +
        `rewrite the call as getComputedStyle(el) or teach this test the new shape`,
    ).toBe(true);
    const elVar = (target as ts.Identifier).text;

    const fn = enclosingFunction(node);
    expect(fn, `${label}: getComputedStyle outside any function`).toBeDefined();
    if (fn === undefined) return;
    const statements = statementsOf(fn);

    const styleVar = bindingFor(statements, (init) => init === node);
    expect(
      styleVar,
      `${label}: the computed style must be bound to a local (const style = window.getComputedStyle(el))`,
    ).toBeDefined();

    const rectVar = bindingFor(
      statements,
      (init) =>
        ts.isCallExpression(init) &&
        printer.printNode(ts.EmitHint.Unspecified, init.expression, file) === `${elVar}.getBoundingClientRect`,
    );

    const names: Record<string, string> = { [elVar]: "el" };
    if (styleVar !== undefined) names[styleVar] = "style";
    if (rectVar !== undefined) names[rectVar] = "rect";
    const roles = Object.values(names);

    const clauses: string[] = [];
    for (const statement of statements) {
      if (!ts.isIfStatement(statement)) continue;
      if (!roles.some((_r, i) => mentions(statement.expression, Object.keys(names)[i]!))) continue;
      clauses.push(normalise(statement.expression, file, names));
    }

    // A canonical predicate ends `return el.isConnected` rather than rejecting
    // in an `if`; a copy inside a loop ends `if (!el.isConnected) continue`.
    // Same clause, two shapes, because one returns a verdict and the other
    // skips an element. Negating the trailing return puts them in one form.
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body !== undefined && ts.isBlock(body)) {
      const last = body.statements[body.statements.length - 1];
      if (
        last !== undefined &&
        ts.isReturnStatement(last) &&
        last.expression !== undefined &&
        Object.keys(names).some((n) => mentions(last.expression!, n))
      ) {
        clauses.push(`!${normalise(last.expression, file, names)}`);
      }
    }

    found.push({ label, clauses });
  };

  visit(file);
  return found;
}

describe("the visibility predicate's three copies", () => {
  const copies = listSources(SRC_ROOT).flatMap(copiesIn);

  it("is found in more than one place, or this guard is checking nothing", () => {
    // The failure this pins is the guard's own: a refactor that moved or
    // renamed the predicate could leave `copies` empty or singular, and a
    // set-equality assertion over one element passes for free. Three is what
    // ships today; more is fine and each new one is checked.
    expect(copies.map((c) => c.label).join("\n")).toBeTruthy();
    expect(copies.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects on exactly the same conditions in every copy", () => {
    // The assertion the behavioural tables cannot make. They pin each copy
    // against a list of cases, so a clause nobody wrote a case for — an
    // *added* one — is invisible to all three. This compares the copies to
    // each other, so an addition to one is a disagreement with the other two
    // whether or not anyone thought to write a case for it.
    //
    // Order is deliberately not compared: `anchorResolve` checks `isConnected`
    // before box area and the other two check it after, which the phase-2
    // review confirmed is behaviourally inert (a disconnected element has a
    // zero rect in Chromium). Membership is the property that has to hold.
    const [first, ...rest] = copies;
    expect(first).toBeDefined();
    if (first === undefined) return;

    const canonical = [...first.clauses].sort();
    expect(canonical.length, `${first.label} contributed no clauses at all`).toBeGreaterThan(0);

    for (const copy of rest) {
      expect(
        [...copy.clauses].sort(),
        `${copy.label} does not reject on the same conditions as ${first.label}. ` +
          `All copies of this predicate must agree clause for clause — a node one of them ` +
          `would refuse must never be handed to the model, or resolved by another tier, as though it existed.`,
      ).toEqual(canonical);
    }
  });
});
