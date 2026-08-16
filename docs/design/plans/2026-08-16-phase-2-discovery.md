# Phase 2 — Observer and Discovery Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An LLM drives a real UI once over a typed tool vocabulary and emits a proven capability artifact, with every loop behaviour testable without spending API credit.

**Architecture:** The loop never calls Anthropic directly. It calls a `ModelDriver` seam with three implementations — `ScriptedDriver` (fixed tool sequences, zero cost, used by every loop test), `CassetteDriver` (replays one recorded transcript, guards the real wire shape), and `AnthropicDriver` (the SDK tool runner, the only thing that spends money). The model addresses opaque handles and never writes a locator; when it calls `done`, record-time proving converts each handle it touched into a binding whose tier chain was proven to resolve uniquely on the recording surface.

**Tech Stack:** TypeScript ESM (NodeNext), Playwright 1.56+, Zod 4, Vitest 3, `@anthropic-ai/sdk` (new in this phase), Node 25.

**Spec:** `docs/design/specs/2026-08-15-capability-recorder-design.md` — §4 (artifact), §6 (discovery loop), §7 (determinism), §9 (safety). The plan argues from the spec; read both.

**Prior phase:** `docs/design/2026-08-16-phase-1-decision-record.md` — §7 lists the deferrals this phase closes.

## Global Constraints

- **Budget is a hard constraint, not a preference.** Total available Anthropic credit is **$5**. Only Task 12 may make a live API call. Every other task is verified with `ScriptedDriver` or `CassetteDriver`. If you believe a task needs a live call, report BLOCKED and say why — do not spend.
- Model for discovery is **`claude-sonnet-5`**. Do not use Opus.
- `npm test` must stay **container-free** and must make **zero network calls**. Currently 100 tests. Container and network work lives in `npm run test:e2e`.
- Any function serialized into the page (`page.evaluate` and friends) must pass `tests/surface/evaluate-serialisation.test.ts`. No inner named bindings — the guard discovers callbacks by AST and will find yours.
- Exactly one match, or fail. Never `[0]` on a multi-match.
- Condition-based waits with explicit budgets. No sleeps.
- No credential, session token, or `;jsessionid=` value in any log, evidence file, fixture, test, or cassette.
- The model never sees a locator, a CSS selector, or a URL outside the allowlist. It sees opaque handles only.
- **Never click `Clean` or `Shutdown`** on ParaBank admin — they destroy the fixture database. Probe verdicts only.
- `tsc --noEmit` clean.

---

## File Structure

```
src/observe/
  visibility.ts   isRendered predicate, shared by observer AND resolver
  snapshot.ts     semantic snapshot: opaque handles, roles, names, values
src/artifact/
  schema.ts       Zod schemas for the three artifact blocks
  prove.ts        handle -> binding whose chain was proven unique
src/discover/
  tools.ts        the typed tool vocabulary
  driver.ts       ModelDriver seam + ScriptedDriver + CassetteDriver
  budget.ts       token and cost ceiling, aborts before overspend
  loop.ts         the loop, policy hook, stopping conditions
  anthropic.ts    AnthropicDriver — the only file that spends money
```

---

### Task 1: Shared visibility predicate

Closes a Phase 1 deferral: tiers 0–2 have no visibility filter, so a hidden node resolves at tier 2 and is rejected at tier 1 — the ladder disagrees with itself. ParaBank ships hidden success and error nodes in the accessibility tree, so this is load-bearing for both the observer and every future detector.

**Files:**
- Create: `src/observe/visibility.ts`
- Modify: `src/surface/playwright-web/resolver.ts` (apply the filter at tiers 0–2)
- Test: `tests/observe/visibility.test.ts`

**Interfaces:**
- Produces: `export function isRenderedIn(el: Element): boolean` — runs inside the page, must be free of inner named bindings.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { isRenderedIn } from "../../src/observe/visibility.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`
    <div id="shown">visible</div>
    <div id="dnone" style="display:none">hidden by display</div>
    <div id="vhidden" style="visibility:hidden">hidden by visibility</div>
    <div id="opacity" style="opacity:0">hidden by opacity</div>
    <div id="zero" style="width:0;height:0;overflow:hidden">zero area</div>
    <div id="offscreen" style="position:absolute;left:-9999px">offscreen</div>
  `);
});
afterAll(async () => { await browser.close(); });

const check = (id: string) =>
  page.locator(`#${id}`).evaluate(isRenderedIn);

describe("isRenderedIn", () => {
  it("accepts a plainly visible element", async () => {
    expect(await check("shown")).toBe(true);
  });

  it.each([
    ["dnone", "display:none"],
    ["vhidden", "visibility:hidden"],
    ["opacity", "opacity:0"],
    ["zero", "zero area"],
  ])("rejects %s (%s)", async (id) => {
    expect(await check(id)).toBe(false);
  });

  it("accepts an offscreen element, which is rendered but scrolled away", async () => {
    // Deliberate: offscreen is not the same as hidden. A control below the
    // fold is real and clickable after scrolling; treating it as hidden
    // would make long forms undiscoverable.
    expect(await check("offscreen")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/observe/visibility.test.ts`
Expected: FAIL — cannot resolve `src/observe/visibility.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * Whether an element is actually rendered, evaluated inside the page.
 *
 * Written as one flat expression chain with no inner named bindings.
 * `tsx` transforms with esbuild `keepNames`, which rewrites a named inner
 * function into `__name(fn, "name")` where `__name` is a module-scope
 * helper — and a function serialised into the page is torn out of that
 * scope. See tests/surface/evaluate-serialisation.test.ts.
 *
 * Offscreen is deliberately NOT hidden: a control below the fold is real.
 * What disqualifies an element is being unrenderable, not being unscrolled.
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/observe/visibility.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Apply the filter to resolver tiers 0–2**

In `src/surface/playwright-web/resolver.ts`, every candidate list produced by a tier-0, tier-1 or tier-2 strategy must be filtered through `isRenderedIn` before the exactly-one-match check runs. Read the existing tier-3 path first — it already filters — and match its placement so all four tiers agree.

- [ ] **Step 6: Add the regression test that the ladder now agrees with itself**

Add to `tests/surface/resolver.test.ts`, using the existing ParaBank fixture that carries a hidden node:

```ts
it("rejects a hidden node at tier 2, matching tier 1's behaviour", async () => {
  // Phase 1 shipped a ladder that disagreed with itself here: tier 1 rejected
  // the hidden success node and tier 2 accepted it, fingerprint and all.
  const res = await resolveBinding(
    page,
    { scope: [], chain: [{ tier: 2, by: "css", value: "#showResult h1" }] },
    {},
  );
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 7: Run the full suite and the serialisation guard**

Run: `npm test`
Expected: all pass, including `evaluate-serialisation` discovering `visibility.ts`'s callback.

- [ ] **Step 8: Commit**

```bash
git add src/observe/visibility.ts tests/observe/visibility.test.ts src/surface/playwright-web/resolver.ts tests/surface/resolver.test.ts
git commit -m "feat(observe): one visibility predicate, shared by every tier"
```

---

### Task 2: Resolution records the rungs it tried

Closes a Phase 1 deferral. `Resolution` reports the winning strategy's declared tier and nothing about the rungs that missed, so degradation is inferred rather than observed. Task 6 (record-time proving) needs this, and Phase 3 drift detection wants it.

**Files:**
- Modify: `src/surface/types.ts`, `src/surface/playwright-web/resolver.ts`
- Test: `tests/surface/resolver.test.ts`

**Interfaces:**
- Produces: `export interface Attempt { tier: number; reason: "no-match" | "ambiguous" | "fingerprint-mismatch" }`; the `ok: true` branch of `Resolution` gains `attempts: Attempt[]` listing every rung tried *before* the winner, in order.

- [ ] **Step 1: Write the failing test**

```ts
it("records the rungs that missed before the one that won", async () => {
  const res = await resolveBinding(page, {
    scope: [],
    chain: [
      { tier: 0, by: "testid", value: "not-present-anywhere" },
      { tier: 2, by: "css", value: "#accountTable tbody tr:first-child td:nth-child(2)" },
    ],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.tier).toBe(2);
  expect(res.attempts).toEqual([{ tier: 0, reason: "no-match" }]);
});

it("reports an empty attempt list when the first rung wins", async () => {
  const res = await resolveBinding(page, {
    scope: [],
    chain: [{ tier: 1, by: "role", role: "link", name: "Accounts Overview" }],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.attempts).toEqual([]);
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run tests/surface/resolver.test.ts -t "rungs"`
Expected: FAIL — `attempts` does not exist on the resolution type.

- [ ] **Step 3: Widen the type**

In `src/surface/types.ts`:

```ts
export interface Attempt {
  tier: number;
  reason: "no-match" | "ambiguous" | "fingerprint-mismatch";
}

export type Resolution =
  | { ok: true; tier: number; handle: Handle; attempts: Attempt[] }
  | { ok: false; reason: "no-match" | "ambiguous" | "fingerprint-mismatch"; tier?: number; count?: number };
```

- [ ] **Step 4: Accumulate attempts in the chain walk**

In `resolveBinding`, push an `Attempt` each time a rung fails, and pass the accumulated array into the success return. Do not include the winning rung.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass. Existing tests that construct a successful `Resolution` literal may need `attempts: []` added — that is expected, not a regression.

- [ ] **Step 6: Commit**

```bash
git add src/surface/types.ts src/surface/playwright-web/resolver.ts tests/surface/resolver.test.ts
git commit -m "feat(surface): record which rungs were tried, not just which won"
```

---

### Task 3: Anchor relations below and above

Closes a Phase 1 deferral. `nearest-right` is the only relation implemented, and ParaBank's login form stacks its label above the field (anchor y=287–302, field y=305–323, same x) — measured live. Recording the login flow is impossible without this.

**Files:**
- Modify: `src/surface/types.ts` (widen `rel`), `src/surface/playwright-web/resolver.ts`
- Test: `tests/surface/resolver.test.ts`

**Interfaces:**
- Produces: `rel: "nearest-right" | "nearest-below" | "nearest-above"` on the tier-3 strategy.

- [ ] **Step 1: Write the failing test against the real login fixture**

```ts
it("resolves a field below its label, the ParaBank login shape", async () => {
  // Measured on the live page: the Username label sits at y=287-302 and its
  // input at y=305-323, same x. nearest-right cannot reach it.
  await page.goto(fileUrl("tests/fixtures/parabank/login.html"));
  const res = await resolveBinding(page, {
    scope: [],
    chain: [{ tier: 3, by: "anchor", anchorText: "Username", rel: "nearest-below", accepts: ["input"] }],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const name = await page.locator(`[data-dca-handle="${res.handle}"]`).getAttribute("name");
  expect(name).toBe("username");
});
```

Note: the Phase 1 record found `login.html` loads no stylesheets, so its blocks stack vertically — which is exactly the geometry `nearest-below` needs. This fixture works offline for this relation.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/surface/resolver.test.ts -t "below its label"`
Expected: FAIL — `nearest-below` is not an accepted `rel`.

- [ ] **Step 3: Implement both relations**

Widen the `rel` union in `src/surface/types.ts`. In `anchorResolve`, the candidate predicate currently requires same-row and to-the-right. Add:

- `nearest-below`: candidate's vertical midpoint is greater than the anchor's bottom, and their horizontal ranges overlap. Rank by vertical gap, then horizontal offset.
- `nearest-above`: mirror of below.

Keep the existing distance-tie behaviour: two candidates equidistant is `ambiguous`, never a pick. Write the predicate with no inner named bindings — the serialisation guard covers this callback.

- [ ] **Step 4: Add the tie test for the new relation**

```ts
it("refuses to choose between two equidistant fields below an anchor", async () => {
  await page.goto(fileUrl("tests/fixtures/synthetic/geometry.html"));
  const res = await resolveBinding(page, {
    scope: [],
    chain: [{ tier: 3, by: "anchor", anchorText: "Amount", rel: "nearest-below", accepts: ["input"] }],
  }, {});
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.reason).toBe("ambiguous");
});
```

You will need to add a below-tie pair to `tests/fixtures/synthetic/geometry.html`. That file is hand-authored and marked non-captured; adding to it is expected.

- [ ] **Step 5: Run the suite and the serialisation guard**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/surface/types.ts src/surface/playwright-web/resolver.ts tests/surface/resolver.test.ts tests/fixtures/synthetic/geometry.html
git commit -m "feat(surface): anchor relations for fields below and above their label"
```

---

### Task 4: Semantic snapshot with opaque handles

What the model sees. It must never contain a selector, and it must not contain hidden nodes.

**Files:**
- Create: `src/observe/snapshot.ts`
- Test: `tests/observe/snapshot.test.ts`

**Interfaces:**
- Consumes: `isRenderedIn` from Task 1.
- Produces:

```ts
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
export async function observe(
  page: Page,
  opts?: { screenshot?: boolean },
): Promise<Observation>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { observe } from "../../src/observe/snapshot.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pathToFileURL(resolve("tests/fixtures/parabank/login.html")).href);
});
afterAll(async () => { await browser.close(); });

describe("observe", () => {
  it("returns the two login inputs as editable nodes", async () => {
    const obs = await observe(page);
    const editable = obs.nodes.filter((n) => n.editable);
    expect(editable.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every node an opaque handle that is not a selector", async () => {
    const obs = await observe(page);
    for (const n of obs.nodes) {
      expect(n.handle).toMatch(/^n\d+$/);
    }
  });

  it("leaks no selector, id, class or tag name anywhere in the payload", async () => {
    // The model must address handles and never write a locator. If the
    // snapshot carries a selector, the model can copy it, and the whole
    // record-time-proving guarantee is bypassed.
    const obs = await observe(page);
    const blob = JSON.stringify(obs.nodes);
    for (const forbidden of ["#", "input[", "customer.", "class=", "<"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("omits a hidden node", async () => {
    await page.evaluate(() => {
      const d = document.createElement("button");
      d.textContent = "SecretlyHiddenControl";
      d.style.display = "none";
      document.body.appendChild(d);
    });
    const obs = await observe(page);
    expect(obs.nodes.some((n) => n.name.includes("SecretlyHiddenControl"))).toBe(false);
  });

  it("omits the screenshot unless asked, because images dominate token cost", async () => {
    expect((await observe(page)).screenshot).toBeNull();
    expect((await observe(page, { screenshot: true })).screenshot).toBeTypeOf("string");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/observe/snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Walk the DOM inside one `page.evaluate`, filtering with `isRenderedIn`, and for each interactive or labelled element emit `{handle, role, name, value, editable}`. Stamp the handle onto the element as `data-dca-handle` **inside the same evaluate** so there is no time-of-check gap — Phase 1 established this pattern in `resolver.ts`; read `stampHandle` and follow it.

Handles are sequential (`n0`, `n1`, …) per observation. Role comes from the element's `role` attribute or its tag's implicit role. Name comes from `aria-label`, then associated label text, then trimmed text content, then `value` for buttons. `editable` is true for `input`, `textarea`, `select`, and `contenteditable`.

Take the screenshot with `page.screenshot({ type: "jpeg", quality: 60 })` and base64 it, only when `opts.screenshot` is true.

No inner named bindings in the evaluate callback.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/observe/snapshot.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/observe/snapshot.ts tests/observe/snapshot.test.ts
git commit -m "feat(observe): semantic snapshot addressed by opaque handles"
```

---

### Task 5: Artifact schema

The three blocks from spec §4. The overlay invariant — a tenant override may modify `bindings` only — is enforced here by construction.

**Files:**
- Create: `src/artifact/schema.ts`
- Test: `tests/artifact/schema.test.ts`

**Interfaces:**
- Produces: `CapabilityArtifactSchema` (Zod), `export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>`, and `export function parseArtifact(u: unknown): CapabilityArtifact`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseArtifact, CapabilityArtifactSchema } from "../../src/artifact/schema.js";

const valid = {
  capability: {
    id: "parabank.find-transaction",
    product: "parabank",
    version: 1,
    goal: "Find a transaction by id",
    inputs: { transactionId: { type: "string" } },
    outputs: { amount: { type: "string" } },
    status: "draft",
  },
  flow: {
    steps: [
      { kind: "act", action: "fill", control: "txn_id", value: "$transactionId" },
      { kind: "act", action: "click", control: "find_btn" },
      { kind: "checkpoint", control: "results_heading" },
      { kind: "extract", control: "amount_cell", as: "amount" },
    ],
  },
  bindings: {
    tenant: "local",
    variant: "baseline",
    controls: {
      txn_id: { scope: [], chain: [{ tier: 2, by: "css", value: "#transactionId" }] },
    },
  },
};

describe("artifact schema", () => {
  it("accepts a well-formed artifact", () => {
    expect(() => parseArtifact(valid)).not.toThrow();
  });

  it("rejects a flow step naming a control with no binding", () => {
    // The three blocks are separable but not independent: flow logic is
    // shared across tenants and bindings are per-tenant, so a step that
    // names an unbound control is an artifact that cannot replay anywhere.
    const broken = structuredClone(valid);
    broken.flow.steps.push({ kind: "act", action: "click", control: "ghost_control" });
    expect(() => parseArtifact(broken)).toThrow(/ghost_control/);
  });

  it("rejects status outside the declared lifecycle", () => {
    const broken = structuredClone(valid);
    (broken.capability as Record<string, unknown>).status = "yolo";
    expect(() => parseArtifact(broken)).toThrow();
  });

  it("rejects a replay-illegal tier 4 strategy", () => {
    // Tier 4 is visual/model-assisted and exists only in discovery and
    // escalation. An artifact carrying one could not replay deterministically,
    // so it must be unrepresentable rather than merely unhandled.
    const broken = structuredClone(valid);
    broken.bindings.controls.txn_id.chain = [{ tier: 4, by: "visual", value: "the box" }];
    expect(() => parseArtifact(broken)).toThrow();
  });
});
```

- [ ] **Step 2: Run and watch all four fail**

Run: `npx vitest run tests/artifact/schema.test.ts`

- [ ] **Step 3: Implement**

Build the three block schemas with Zod 4. `status` is `z.enum(["draft", "approved"])`. The strategy union accepts tiers 0–3 only. Cross-block validation (every `control` named in `flow.steps` exists in `bindings.controls`) goes in a `.superRefine` on the top-level object, and the issue message must contain the offending control name so the test's regex is meaningful.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/artifact/schema.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/artifact/schema.ts tests/artifact/schema.test.ts
git commit -m "feat(artifact): three-block schema with the overlay invariant"
```

---

### Task 6: Record-time proving

The heart of the design's determinism claim: every strategy in an artifact was proven to resolve uniquely on the recording surface. Turns a handle the model touched into a binding.

**Files:**
- Create: `src/artifact/prove.ts`
- Test: `tests/artifact/prove.test.ts`

**Interfaces:**
- Consumes: `resolveBinding` and `Attempt` from Tasks 2–3; `ObservedNode` from Task 4.
- Produces: `export async function proveControl(page: Page, handle: string): Promise<Binding>` — throws if no candidate strategy resolves uniquely.

- [ ] **Step 1: Write the failing test**

```ts
it("produces a chain whose every rung was proven unique on this page", async () => {
  await page.goto(fileUrl("tests/fixtures/parabank/findtrans.html"));
  const obs = await observe(page);
  const node = obs.nodes.find((n) => n.editable)!;
  const binding = await proveControl(page, node.handle);

  expect(binding.chain.length).toBeGreaterThan(0);
  for (const strategy of binding.chain) {
    const res = await resolveBinding(page, { scope: [], chain: [strategy] }, {});
    expect(res.ok, `tier ${strategy.tier} did not resolve uniquely`).toBe(true);
  }
});

it("refuses to emit a binding for an element nothing can uniquely address", async () => {
  // findtrans.html carries four identically-named buttons. If proving cannot
  // find a unique strategy it must throw, not emit a chain that resolves
  // ambiguously at replay time — that is the failure this whole design exists
  // to prevent.
  await page.goto(fileUrl("tests/fixtures/parabank/findtrans.html"));
  const obs = await observe(page);
  const ambiguous = obs.nodes.find((n) => n.name === "Find Transactions")!;
  await expect(proveControl(page, ambiguous.handle)).rejects.toThrow(/unique/i);
});

it("orders the chain by what proved unique, not by tier number", async () => {
  // Spec §7: tier order is recorded per binding, decided by what proved
  // unique at record time. On a legacy surface that usually yields
  // anchor-first, which is why the chain is not sorted ascending.
  await page.goto(fileUrl("tests/fixtures/parabank/login.html"));
  const obs = await observe(page);
  const user = obs.nodes.find((n) => n.editable)!;
  const binding = await proveControl(page, user.handle);
  expect(binding.chain.every((s) => s.tier >= 0 && s.tier <= 3)).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

Read the stamped element's attributes, role, accessible name, and nearby anchor text. Generate candidate strategies — tier 0 from a test-id attribute if present, tier 1 from role+name, tier 2 from a structural selector, tier 3 from the nearest label text and the geometric relation that actually holds. Try each with `resolveBinding` against the live page. Keep only those that return `ok: true`. Order the surviving chain by proven reliability: test-id first if it survived, then whichever of the rest resolved with the fewest attempts. Throw if the surviving set is empty.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/artifact/prove.ts tests/artifact/prove.test.ts
git commit -m "feat(artifact): prove every strategy before it enters an artifact"
```

---

### Task 7: The tool vocabulary

**Files:**
- Create: `src/discover/tools.ts`
- Test: `tests/discover/tools.test.ts`

**Interfaces:**
- Produces: `export const TOOL_SCHEMAS` (an array shaped for the Anthropic SDK's `tools` parameter) and a discriminated union `export type ToolCall`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { TOOL_SCHEMAS, parseToolCall } from "../../src/discover/tools.js";

describe("tool vocabulary", () => {
  it("declares exactly the eight tools the spec names", () => {
    expect(TOOL_SCHEMAS.map((t) => t.name).sort()).toEqual(
      ["click", "done", "extract", "fill", "navigate", "observe", "select", "stuck"].sort(),
    );
  });

  it("requires done to name the checkpoint that proves the goal", () => {
    // "done" without a checkpoint is a model asserting success. The
    // checkpoint is what makes it verifiable.
    expect(() => parseToolCall("done", {})).toThrow();
    expect(() => parseToolCall("done", { checkpoint: "n7" })).not.toThrow();
  });

  it("requires stuck to carry a reason", () => {
    expect(() => parseToolCall("stuck", {})).toThrow();
  });

  it("accepts only a handle for click, never a selector", () => {
    expect(() => parseToolCall("click", { handle: "n3" })).not.toThrow();
    expect(() => parseToolCall("click", { selector: "#btn" })).toThrow();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

One Zod schema per tool. `parseToolCall(name, input)` dispatches and throws on an unknown tool or invalid input. Derive `TOOL_SCHEMAS` from the Zod schemas with `z.toJSONSchema` so the wire schema and the runtime validator cannot drift — deriving is the point; do not hand-write the JSON Schema alongside.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/discover/tools.ts tests/discover/tools.test.ts
git commit -m "feat(discover): typed tool vocabulary, handles only"
```

---

### Task 8: The ModelDriver seam and ScriptedDriver

This is what makes the rest of the phase free to build.

**Files:**
- Create: `src/discover/driver.ts`
- Test: `tests/discover/driver.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DriverTurn { calls: Array<{ name: string; input: unknown }>; }
export interface ModelDriver {
  next(observation: Observation, history: DriverTurn[]): Promise<DriverTurn>;
  usage(): { inputTokens: number; outputTokens: number };
}
export class ScriptedDriver implements ModelDriver {
  constructor(script: Array<{ name: string; input: unknown }>[]);
}
```

- [ ] **Step 1: Write the failing test**

```ts
it("returns each scripted turn in order and then refuses to invent one", async () => {
  const d = new ScriptedDriver([
    [{ name: "click", input: { handle: "n1" } }],
    [{ name: "done", input: { checkpoint: "n4" } }],
  ]);
  const obs = { url: "u", title: "t", nodes: [], screenshot: null };
  expect((await d.next(obs, [])).calls[0]!.name).toBe("click");
  expect((await d.next(obs, [])).calls[0]!.name).toBe("done");
  // Running off the end of the script is a test authoring bug. Silently
  // returning "stuck" would make a loop test pass for the wrong reason.
  await expect(d.next(obs, [])).rejects.toThrow(/exhausted/i);
});

it("reports zero usage, so a scripted test can assert nothing was spent", async () => {
  const d = new ScriptedDriver([[{ name: "stuck", input: { reason: "x" } }]]);
  expect(d.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/discover/driver.ts tests/discover/driver.test.ts
git commit -m "feat(discover): model driver seam with a zero-cost scripted implementation"
```

---

### Task 9: Budget guard

With $5 total, a runaway loop is a real risk. This makes overspend structurally impossible rather than a thing to remember.

**Files:**
- Create: `src/discover/budget.ts`
- Test: `tests/discover/budget.test.ts`

**Interfaces:**
- Produces: `export class Budget { constructor(limitUsd: number, rate: { inPerM: number; outPerM: number }); charge(u: { inputTokens: number; outputTokens: number }): void; spentUsd(): number; }` — `charge` throws `BudgetExceeded` when the limit would be crossed.

- [ ] **Step 1: Write the failing test**

```ts
it("throws before the spend crosses the ceiling, not after", async () => {
  // Sonnet 5 intro rate: $2/1M in, $10/1M out.
  const b = new Budget(0.05, { inPerM: 2, outPerM: 10 });
  b.charge({ inputTokens: 10_000, outputTokens: 1_000 });   // $0.02 + $0.01
  expect(b.spentUsd()).toBeCloseTo(0.03, 4);
  expect(() => b.charge({ inputTokens: 20_000, outputTokens: 0 })).toThrow(BudgetExceeded);
  // and the rejected charge must not have been recorded
  expect(b.spentUsd()).toBeCloseTo(0.03, 4);
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/discover/budget.ts tests/discover/budget.test.ts
git commit -m "feat(discover): hard spend ceiling that refuses rather than warns"
```

---

### Task 10: The loop

Every stopping condition from spec §6, the policy gate in the per-turn hook, and artifact emission on success. All tested with `ScriptedDriver` — zero API cost.

**Files:**
- Create: `src/discover/loop.ts`
- Test: `tests/discover/loop.test.ts` (unit, ScriptedDriver, no container), `tests/e2e/discover.test.ts` (against ParaBank, still ScriptedDriver)

**Interfaces:**
- Consumes: everything from Tasks 4–9.
- Produces:

```ts
export type DiscoveryResult =
  | { status: "recorded"; artifact: CapabilityArtifact; steps: number }
  | { status: "escalated"; reason: StopReason; steps: number };
export type StopReason =
  | "max-steps" | "wall-clock" | "dead-end" | "model-stuck"
  | "policy-refusal" | "budget-exceeded" | "checkpoint-unverified";
export async function discover(opts: {
  page: Page; goal: string; driver: ModelDriver; policy: PolicyConfig;
  log: RunLogger; budget: Budget;
  maxSteps?: number; wallClockMs?: number;
}): Promise<DiscoveryResult>;
```

- [ ] **Step 1: Write the failing tests, one per stopping condition**

```ts
const obsStub = { url: "http://localhost:8081/parabank/x", title: "t", nodes: [], screenshot: null };

it("records an artifact when the model calls done and the checkpoint verifies", async () => { /* ScriptedDriver: click, done */ });

it("escalates at max steps rather than running forever", async () => {
  const script = Array.from({ length: 10 }, () => [{ name: "observe", input: {} }]);
  const res = await discover({ ...base, driver: new ScriptedDriver(script), maxSteps: 3 });
  expect(res).toMatchObject({ status: "escalated", reason: "max-steps", steps: 3 });
});

it("escalates when the model declares itself stuck", async () => { /* stuck */ });

it("escalates on three consecutive actions with no observable state change", async () => {
  // Dead-end detection. Without it a model that clicks a dead control forty
  // times burns the whole step budget and the whole money budget.
});

it("escalates on a policy refusal instead of performing the action", async () => {
  // The gate runs in the per-turn hook BEFORE execution. Assert the page was
  // never navigated, not merely that the result says escalated.
});

it("escalates when the budget guard trips", async () => { /* Budget(0) */ });

it("escalates when done names a checkpoint that does not verify", async () => {
  // "done" is a claim. If the named checkpoint does not resolve and render,
  // the goal was not reached and no artifact may be recorded.
});

it("records no artifact on any escalation path", async () => {
  // Spec §6: discovery never records a partial artifact.
});
```

Fill each body following the first one's shape. Every test constructs its own `ScriptedDriver`; none makes a network call.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement the loop**

Refresh the observation each turn rather than accumulating — spec §6 requires this and it is also the main cost control. Run `gate()` in the per-turn hook before executing any action tool. Track a hash of the observation to detect no-change. Charge the budget from `driver.usage()` each turn. On `done`, verify the named checkpoint resolves *and* is rendered, then prove every touched handle via `proveControl` and assemble the artifact.

- [ ] **Step 4: Run and watch them pass**

Run: `npm test`
Expected: all pass, still container-free and still zero network calls.

- [ ] **Step 5: Add the ParaBank e2e test, still scripted**

`tests/e2e/discover.test.ts` drives a real ParaBank page with a hand-written script of tool calls and asserts a real artifact is emitted whose every binding resolves. This proves the loop against a real surface without a model.

- [ ] **Step 6: Commit**

```bash
git add src/discover/loop.ts tests/discover/loop.test.ts tests/e2e/discover.test.ts
git commit -m "feat(discover): the loop, its stopping conditions, and the policy hook"
```

---

### Task 11: CassetteDriver

Guards the wire shape without spending. Records one real exchange to disk; replays it forever.

**Files:**
- Create: `src/discover/cassette.ts`
- Test: `tests/discover/cassette.test.ts`
- Create: `tests/cassettes/.gitkeep`

**Interfaces:**
- Produces: `export class CassetteDriver implements ModelDriver { constructor(path: string); }` and `export function recordCassette(path: string, inner: ModelDriver): ModelDriver` — a wrapper that writes every exchange to disk as it passes through.

- [ ] **Step 1: Write the failing test**

```ts
it("replays a recorded exchange without any network call", async () => {
  const d = new CassetteDriver("tests/cassettes/sample.json");
  const turn = await d.next(obsStub, []);
  expect(turn.calls[0]!.name).toBe("click");
});

it("refuses a cassette whose recorded observation does not match the live one", async () => {
  // A cassette replayed against a changed page is a test that passes while
  // proving nothing — the exact defect class Phase 1 shipped six times.
  const d = new CassetteDriver("tests/cassettes/sample.json");
  await expect(d.next({ ...obsStub, url: "http://elsewhere" }, [])).rejects.toThrow(/cassette/i);
});

it("contains no credential or session token", async () => {
  const raw = readFileSync("tests/cassettes/sample.json", "utf8");
  for (const bad of ["jsessionid", "demo", "john"]) {
    expect(raw.toLowerCase()).not.toContain(bad);
  }
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement, and hand-author `tests/cassettes/sample.json`**

The sample cassette is hand-authored for this task — it is a fixture, not a recording, and must be obviously synthetic. The real recording arrives in Task 12.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/discover/cassette.ts tests/discover/cassette.test.ts tests/cassettes/
git commit -m "feat(discover): cassette replay so the wire shape is guarded for free"
```

---

### Task 12: AnthropicDriver — the only task that spends money

**STOP before running this task's live step. It requires explicit human approval.** Everything above must be green first.

**Files:**
- Create: `src/discover/anthropic.ts`
- Create: `scripts/discover.mts`
- Test: `tests/discover/anthropic.test.ts` (offline — asserts request shaping only)
- Modify: `package.json` (add `@anthropic-ai/sdk`, add a `discover` script)

**Interfaces:**
- Produces: `export class AnthropicDriver implements ModelDriver { constructor(opts: { apiKey: string; model: string; budget: Budget }); }`

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Write the offline test that shapes the request without sending it**

```ts
it("sends handles and never a selector in the system prompt or tools", () => {
  const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: ["/parabank/**"] });
  const blob = JSON.stringify(req);
  expect(blob).not.toMatch(/#[a-zA-Z]/);
  expect(blob).toContain("n0");
});

it("declares the risk classes and the instruction to call stuck rather than guess", () => {
  const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] });
  expect(req.system).toMatch(/stuck/i);
  expect(req.system).toMatch(/irreversible/i);
});

it("uses claude-sonnet-5, not an Opus model", () => {
  expect(buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] }).model).toBe("claude-sonnet-5");
});
```

Export `buildRequest` so it is testable without a client. No API key is read in these tests.

- [ ] **Step 3: Run and watch them fail, then implement `buildRequest` and the driver**

Use the SDK's `client.beta.messages.tool_runner` per the spec's §6. Charge the `Budget` from each response's `usage` before returning the turn. Read the key from `process.env.ANTHROPIC_API_KEY`; never log it.

- [ ] **Step 4: Run the offline suite**

Run: `npm test`
Expected: all pass, zero network calls.

- [ ] **Step 5: STOP. Report to the controller and wait for approval.**

Report: total tests green, the estimated cost of one run, and the goal string you intend to use. Do not proceed without an explicit go-ahead.

- [ ] **Step 6: One live run, wrapped in the recorder**

```bash
npm run discover -- --goal "Log in and find the account balance" --max-steps 12 --budget 0.50
```

Wrap the driver in `recordCassette("tests/cassettes/parabank-balance.json", driver)` so this single run produces a permanent replayable artifact. Redact the cassette before committing: no credentials, no session token.

- [ ] **Step 7: Commit the driver, the script, and the recorded cassette**

```bash
git add src/discover/anthropic.ts scripts/discover.mts tests/discover/anthropic.test.ts tests/cassettes/parabank-balance.json package.json package-lock.json
git commit -m "feat(discover): anthropic driver, and one recorded discovery run"
```

---

## Self-Review

**Spec coverage.** §4 artifact → Tasks 5, 6. §6 discovery loop → Tasks 7, 8, 10, 12; the tool table maps one-to-one onto Task 7's eight tools; every stopping condition in §6's table has a named test in Task 10. §7 determinism → Tasks 2, 3, 6. §9 safety → Task 10's policy hook. Visibility gating (§7, "non-negotiable") → Task 1.

**Gap accepted:** `binding.scope` frame and shadow descent is still not implemented. ParaBank has no frames, so nothing in this phase exercises it, and Task 1's guard already makes an unhonourable scope refuse rather than resolve wrongly. Carried to Phase 3.

**Placeholder scan.** Task 10's step 1 gives one full test body and names the other seven with their assertions; each is a distinct stopping condition with its own trigger, and the shape is established by the first. Everything else carries real code.

**Type consistency.** `Observation` and `ObservedNode` (Task 4) are consumed by Tasks 6, 8, 10, 12 under those names. `ModelDriver.next(observation, history)` has the same signature in Tasks 8, 11, 12. `Budget.charge` is called in Tasks 10 and 12 with the shape Task 9 defines. `Attempt` (Task 2) is read by Task 6's chain ordering.
