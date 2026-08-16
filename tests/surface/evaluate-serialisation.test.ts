// A function handed to `page.evaluate` — or to any of its siblings — does not run
// here. Playwright serialises it with `Function.prototype.toString` and re-parses
// it inside the page, where the only scope is the page's own globals. Anything
// the body reaches for from module scope is a `ReferenceError` in the browser,
// and it is neither a compile-time error nor something the rest of this suite can
// see, because the rest of this suite never crosses that boundary.
//
// The hazard is not hypothetical and it is not rare. `tsx` runs every shipping
// entry point through esbuild with `keepNames`, which rewrites
// `const norm = (v) => …` into `const norm = __name((v) => …, "norm")` while
// leaving `var __name = …` at module scope. It has bitten twice:
//
//   * `controlNamesOf` (actor.ts) killed `npm run smoke` on its first click;
//     fixed in 9ef199f.
//   * `anchorResolve`'s measurement callback (resolver.ts) killed tier 3 in
//     every `tsx` run for the whole of Phase 1, with five green vitest anchor
//     tests over it — vitest's transform does not set `keepNames`, so the tests
//     were exercising a different, clean body than the one that shipped.
//
// The guard 9ef199f shipped could not see the second one. It named a single file
// and extracted *top-level named functions*, which is structurally blind to an
// inline arrow passed straight to `evaluate` — precisely the shape that broke. A
// guard that cannot catch the second instance of the bug it was written for is
// not a guard, so this one is told nothing:
//
//   1. It walks all of `src/`, parses each module, and finds every call to a
//      Playwright API that serialises a callback into the page. Inline arrows,
//      inline function expressions and identifiers pointing at a named function
//      are all found, because the search is over call sites rather than over
//      declarations.
//   2. It applies the *shipping* transform (esbuild, `keepNames`) to each module
//      that has such a call, re-finds the same call sites in the output, and
//      takes exactly the text `toString` would hand the page — modifiers and any
//      `__name(…)` wrapper stripped, since `__name` returns the same function
//      object and never reaches the browser.
//   3. It checks each body two ways. Statically, TypeScript's own binder resolves
//      every free name against the browser platform library and nothing else, so
//      a reference to `__name`, to a module constant, or to an import is reported
//      wherever it sits in the body — including on branches no test executes.
//      Dynamically, the body is compiled and run in a `node:vm` context holding
//      the platform globals it legitimately uses and nothing more, which fails
//      with the browser's own error text.
//
// Adding a fifth in-page callback adds a case to each `it.each` below without
// anyone editing this file. Adding one with a nested named binding turns it red.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import ts from "typescript";

/** The shipping source. Everything under it is scanned; no file is named. */
const SRC_ROOT = "src";

/**
 * Playwright APIs that serialise a callback and run it inside the page, each with
 * the index of the argument that becomes in-page code. Anything not on this list
 * runs in Node and is none of this guard's business.
 */
const IN_PAGE_APIS = new Map<string, number>([
  ["evaluate", 0],
  ["evaluateHandle", 0],
  ["evaluateAll", 0],
  ["waitForFunction", 0],
  ["addInitScript", 0],
  ["$eval", 1],
  ["$$eval", 1],
]);

interface Callback {
  /** `src/…/resolver.ts:117 anchorResolve → page.evaluate(inline arrow)` */
  label: string;
  /** Exactly what `Function.prototype.toString` hands the page. */
  body: string;
}

function isFunctionNode(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
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

interface Site {
  call: ts.CallExpression;
  api: string;
  argIndex: number;
  enclosing: string;
}

/**
 * Every in-page call site in one module, in source order.
 *
 * Run over the TypeScript source it gives the site's identity — where it is and
 * what encloses it. Run over the transformed output it gives the body that
 * actually ships. Both walks are this same function, so the two lists correspond
 * positionally, and a divergence in length or API name is reported rather than
 * papered over.
 */
function findSites(sf: ts.SourceFile): Site[] {
  const sites: Site[] = [];
  const visit = (node: ts.Node, enclosing: string): void => {
    let scope = enclosing;
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      scope = node.name.text;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isFunctionNode(node.initializer)
    ) {
      scope = node.name.text;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const api = node.expression.name.text;
      const argIndex = IN_PAGE_APIS.get(api);
      if (argIndex !== undefined) sites.push({ call: node, api, argIndex, enclosing: scope });
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sf, "<module>");
  return sites;
}

/**
 * The text `toString` would produce for this function.
 *
 * `export` and `default` are dropped because they are not part of the function;
 * `async`, which is, is kept. The `__name(fn, "fn")` wrapper `keepNames` puts
 * around a named binding is unwrapped by the caller: `__name` returns the very
 * same function object, so the page receives `fn` and never sees the wrapper.
 */
function serialisedText(node: ts.Node, sf: ts.SourceFile): string {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const dropped = modifiers.filter(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  );
  const from = dropped.length === 0 ? node.getStart(sf) : Math.max(...dropped.map((m) => m.end));
  return sf.text.slice(from, node.end).trim();
}

function unwrapKeepNames(node: ts.Expression): ts.Node {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "__name"
  ) {
    const inner = node.arguments[0];
    if (inner !== undefined) return inner;
  }
  return node;
}

/** The function a bare identifier argument names, as it appears in the output. */
function resolveTopLevel(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (declaration.initializer === undefined) return null;
      return unwrapKeepNames(declaration.initializer);
    }
  }
  return null;
}

const callbacks: Callback[] = [];
/**
 * Sites the guard found but could not reduce to a body. These fail the inventory
 * test rather than being skipped: a callback this file cannot read is a callback
 * nothing is checking, which is the exact hole being closed.
 */
const unreadable: string[] = [];

for (const file of listSources(SRC_ROOT)) {
  const source = readFileSync(file, "utf8");
  const sourceSf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sourceSites = findSites(sourceSf);
  if (sourceSites.length === 0) continue;

  // The shipping transform. This is what `tsx` hands to Node, and therefore what
  // `toString` serialises at run time. Without `keepNames` the hazard is invisible.
  const js = transformSync(source, { loader: "ts", keepNames: true }).code;
  const outputSf = ts.createSourceFile(`${file}.js`, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const outputSites = findSites(outputSf);

  if (outputSites.length !== sourceSites.length) {
    unreadable.push(
      `${file}: found ${sourceSites.length} in-page call sites in the source but ` +
        `${outputSites.length} in the transformed output; the guard cannot pair them up`,
    );
    continue;
  }

  for (let i = 0; i < sourceSites.length; i++) {
    const site = sourceSites[i];
    const shipped = outputSites[i];
    if (site === undefined || shipped === undefined) continue;

    const line = sourceSf.getLineAndCharacterOfPosition(site.call.getStart(sourceSf)).line + 1;
    const where = `${file}:${line} ${site.enclosing} → .${site.api}(`;

    if (site.api !== shipped.api) {
      unreadable.push(`${where}…) does not line up with .${shipped.api}(…) in the transformed output`);
      continue;
    }

    const argument = shipped.call.arguments[shipped.argIndex];
    if (argument === undefined) {
      unreadable.push(`${where}…) has no argument at index ${shipped.argIndex}`);
      continue;
    }

    let target: ts.Node | null = null;
    let described: string;
    if (isFunctionNode(argument)) {
      target = argument;
      described = ts.isArrowFunction(argument) ? "inline arrow" : "inline function";
    } else if (ts.isIdentifier(argument)) {
      target = resolveTopLevel(outputSf, argument.text);
      described = argument.text;
      if (target === null || !isFunctionNode(target)) {
        unreadable.push(
          `${where}${argument.text}) names something this guard cannot resolve to a function ` +
            `declared in the same module — hoist it to a top-level function there so it can be checked`,
        );
        continue;
      }
    } else {
      unreadable.push(
        `${where}…) is passed a ${ts.SyntaxKind[argument.kind]} rather than a function. ` +
          `Whatever runs in the page has to be readable here, or it is running unchecked`,
      );
      continue;
    }

    callbacks.push({ label: `${where}${described})`, body: serialisedText(target, outputSf) });
  }
}

/**
 * One synthetic module per callback, type-checked against the browser platform
 * library and nothing else — no `@types/node`, no project files, no imports. Any
 * name the body does not bind itself and the platform does not supply comes back
 * as "Cannot find name", which is the static form of the browser's
 * `ReferenceError`. TypeScript's binder does the scope analysis, so shadowing,
 * destructuring, hoisting and nested functions are handled the way the engine
 * handles them rather than the way a regex would guess.
 */
const PROBE_DIR = "/dca-in-page-callback/";
const probes = new Map<string, string>();
callbacks.forEach((cb, i) => probes.set(`${PROBE_DIR}${i}.ts`, `export const probe = (\n${cb.body}\n);\n`));

const PROBE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
  noEmit: true,
  strict: false,
  noImplicitAny: false,
  skipLibCheck: true,
};

const probeHost = ts.createCompilerHost(PROBE_OPTIONS, true);
const readSourceFile = probeHost.getSourceFile.bind(probeHost);
probeHost.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
  const injected = probes.get(fileName);
  return injected === undefined
    ? readSourceFile(fileName, languageVersion, onError, shouldCreate)
    : ts.createSourceFile(fileName, injected, languageVersion, true, ts.ScriptKind.TS);
};
probeHost.fileExists = (fileName) => probes.has(fileName) || ts.sys.fileExists(fileName);
probeHost.readFile = (fileName) => probes.get(fileName) ?? ts.sys.readFile(fileName);

const probeProgram = ts.createProgram([...probes.keys()], PROBE_OPTIONS, probeHost);
const probeChecker = probeProgram.getTypeChecker();

/** Names the page cannot resolve, in the order they appear in the body. */
function unresolvedNames(index: number): string[] {
  const sf = probeProgram.getSourceFile(`${PROBE_DIR}${index}.ts`);
  if (sf === undefined) return ["<the guard failed to compile this callback at all>"];
  const names = probeProgram
    .getSemanticDiagnostics(sf)
    .filter((d) => ts.flattenDiagnosticMessageText(d.messageText, " ").startsWith("Cannot find name"))
    .map((d) => (d.start === undefined || d.length === undefined ? "?" : sf.text.slice(d.start, d.start + d.length)));
  return [...new Set(names)];
}

/**
 * Platform globals this body actually uses — every free identifier TypeScript
 * resolved into a lib file. Derived rather than listed, so a callback that starts
 * using `getComputedStyle` needs no edit here, and a callback that starts using
 * `__name` gets nothing.
 */
function platformGlobalsUsed(index: number): string[] {
  const sf = probeProgram.getSourceFile(`${PROBE_DIR}${index}.ts`);
  if (sf === undefined) return [];
  const used = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent: ts.Node | undefined = node.parent;
      const isMemberName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node) ||
          (ts.isQualifiedName(parent) && parent.right === node));
      if (!isMemberName) {
        const symbol = probeChecker.getSymbolAtLocation(node);
        const fromLib = symbol?.declarations?.some((d) =>
          probeProgram.isSourceFileDefaultLibrary(d.getSourceFile()),
        );
        if (fromLib === true) used.add(node.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return [...used];
}

/**
 * The intrinsics every realm has — `Object`, `Math`, `Set`, `JSON`, … A `vm`
 * context supplies these itself, and the page has them for the same reason, so
 * they are left alone rather than stubbed.
 */
const REALM_INTRINSICS = new Set<string>(
  vm.runInNewContext("Object.getOwnPropertyNames(globalThis)") as string[],
);

/**
 * Run the body in a scope as bare as the page's: the realm's own intrinsics, plus
 * a permissive stand-in for each platform global the body legitimately uses, and
 * nothing else. A module-scope reference resolves to nothing and throws the same
 * `ReferenceError`, with the same text, that the browser throws.
 *
 * Arguments are stand-ins too, so this reaches as far into the body as the
 * argument shapes allow and then stops. Coverage is *not* the point — the static
 * check above is path-independent and is what enforces the rule. The point is
 * that the failure this guard reports is the failure production reports.
 */
function referenceErrorFromPageScope(body: string, provided: string[]): string | null {
  let universal: object;
  universal = new Proxy(function stub() {}, {
    get(_target, key) {
      if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") return () => "";
      if (key === Symbol.iterator) return function* empty() {};
      return universal;
    },
    // Calls answer `null` rather than another stand-in, so a `while (x.next())`
    // shaped loop terminates instead of spinning this test forever.
    apply: () => null,
    construct: () => universal,
  });

  const sandbox: Record<string, unknown> = {};
  for (const name of provided) if (!REALM_INTRINSICS.has(name)) sandbox[name] = universal;

  const context = vm.createContext(sandbox);
  const fn = vm.runInContext(`(${body})`, context, { timeout: 5_000 }) as (...args: unknown[]) => unknown;
  try {
    fn(universal, universal, universal);
    return null;
  } catch (thrown) {
    // Anything else is the stand-in arguments running out of road, which says
    // nothing either way. Only an unresolved name is a finding.
    const error = thrown as { constructor?: { name?: string }; message?: string };
    return error?.constructor?.name === "ReferenceError" ? (error.message ?? "ReferenceError") : null;
  }
}

const cases = callbacks.map((cb, i) => [cb.label, i] as const);

describe("in-page callbacks", () => {
  // A discovery that quietly found nothing would pass every assertion below, so
  // the floor is asserted first. It is not a list of the callbacks — those are
  // discovered — it is a refusal to be satisfied by an empty inventory.
  it("are discovered across src/, and every one of them can be read", () => {
    expect(unreadable).toEqual([]);
    expect(callbacks.map((c) => c.label).join("\n")).toMatch(/\S/);
    expect(callbacks.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases)("%s references nothing the page cannot resolve", (label, index) => {
    // The whole finding is in the message: a name here is a `ReferenceError`
    // waiting for the first run that reaches that line in a browser.
    expect({ [label]: unresolvedNames(index) }).toEqual({ [label]: [] });
  });

  it.each(cases)("%s runs in a scope as bare as the page's", (label, index) => {
    const cb = callbacks[index];
    expect(cb).toBeDefined();
    const failure = referenceErrorFromPageScope(cb?.body ?? "", platformGlobalsUsed(index));
    expect({ [label]: failure }).toEqual({ [label]: null });
  });

  it("extracts the function that ships, not something adjacent to it", () => {
    // If the extraction ever grabs the wrong node, the checks above go on passing
    // while watching the wrong text. This pins one extracted body against
    // behaviour that `tests/surface/actor-element-risk.test.ts` verifies in a real
    // browser: if the two ever disagree, one of them is testing something other
    // than what ships.
    const named = callbacks.find((c) => c.body.startsWith("function controlNamesOf("));
    expect(named).toBeDefined();

    const controlNamesOf = new Function(`return (${named?.body ?? ""})`)() as (el: unknown) => string[];

    // `<button type="submit" name="action" value="CLEAN">Clean</button>`
    expect(
      controlNamesOf({
        tagName: "BUTTON",
        getAttribute: (a: string) => (a === "value" ? "CLEAN" : a === "type" ? "submit" : null),
        value: "CLEAN",
        textContent: "\n\t\t\t\t\t\t\tClean\n\t\t\t\t\t\t",
      }),
    ).toEqual(["Clean"]);

    // `<input type="submit" value="Shutdown">` — no text, and its value is its name.
    expect(
      controlNamesOf({
        tagName: "INPUT",
        getAttribute: (a: string) => (a === "type" ? "submit" : a === "value" ? "Shutdown" : null),
        value: "Shutdown",
        textContent: "",
      }),
    ).toEqual(["Shutdown"]);
  });
});
