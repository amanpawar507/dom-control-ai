# Phase 3 — Replay Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay a recorded capability artifact against a live application with no model in the loop, classifying every runtime condition it meets, and prove the replay is deterministic rather than asserting it.

**Architecture:** A step walker reads a stored artifact, resolves each control through its recorded binding chain, and executes the flow behind the same policy gate discovery used. The chain is treated as a **corroboration set** rather than a fallback ladder — every rung was proven at record time to resolve to the *same* element, so two rungs disagreeing at replay means the surface drifted, and that is a failure rather than a coin flip. Every exceptional state is classified against a declared taxonomy; recoveries are bounded; the result is one of four shapes.

**Tech Stack:** TypeScript ESM (NodeNext), Playwright, Zod 4, Vitest, Node 25. No new dependencies.

**Spec:** `docs/design/specs/2026-08-15-capability-recorder-design.md` — §4 (artifact), §7 (determinism, runtime conditions, result contract, stability harness), §9 (safety), §11 (evidence).

**Prior phases:** `docs/design/2026-08-16-phase-1-decision-record.md`, and the phase 2 ledger at `.superpowers/sdd/2026-08-16-phase-2-discovery/progress.md`.

## Global Constraints

- `npm test` must stay **container-free** with **zero network calls** — 289 tests today. The count may move; container-freedom may not. Container work lives in `npm run test:e2e` (18).
- **No live model call anywhere in this phase.** Replay has no model in the loop by definition; if you believe you need one, you have misunderstood the task. $4.937 of a $5 budget remains and is not this phase's to spend.
- Exactly one match, or fail. Never `[0]` on a multi-match.
- Condition-based waits with explicit budgets. **No sleeps.** Every recovery is bounded — an unbounded retry is a hang wearing a costume.
- Every detector is **visibility-gated**. The target ships hidden success and error nodes in its accessibility tree; a detector that fires on one is worse than no detector.
- No inner named bindings in any function serialized into the page — `tsx` ships esbuild `keepNames` and vitest does not. A bidirectional drift guard covers the three `isRenderedIn` copies.
- No credential, session token, or `;jsessionid=` value in any artifact, log, evidence file, fixture, or test.
- **Never click `Clean` or `Shutdown`** on ParaBank admin. Seed account 12345 must read −2300.00 at the end of every task.
- `tsc --noEmit` clean.
- **Commit messages must NOT contain `Co-Authored-By` or `Claude-Session` trailers.**

---

## File Structure

```
src/replay/
  load.ts        read an artifact from the store, apply an overlay, validate
  identity.ts    corroboration — the replay-time answer to record-time proving
  conditions.ts  the seven runtime conditions, visibility-gated detectors
  recover.ts     bounded recovery per condition class
  result.ts      the four-shape result contract
  engine.ts      the step walker
  stability.ts   run N times, report whether the runs agree
```

---

### Task 1: Load an artifact, and refuse one that cannot replay

**Files:** Create `src/replay/load.ts`; Test `tests/replay/load.test.ts`

**Interfaces:**
- Produces: `export function loadCapability(root: string, product: string, id: string, version: number): CapabilityArtifact` and `export function applyOverlay(base: CapabilityArtifact, overlay: unknown): CapabilityArtifact`.

- [ ] **Step 1: Write the failing tests**

```ts
it("loads a stored artifact and validates it on the way in", () => {
  const a = loadCapability("capabilities", "parabank", "demo-cap", 1);
  expect(a.capability.id).toBe("demo-cap");
});

it("refuses an artifact whose flow names a control with no binding", () => {
  // parseArtifact already rejects this; the point is that loading does not
  // bypass it. An artifact read off disk is `unknown` and never went through
  // the type system.
  expect(() => loadCapability("tests/fixtures/store-broken", "parabank", "unbound", 1)).toThrow();
});

it("applies a tenant overlay to bindings only", () => {
  const base = loadCapability("capabilities", "parabank", "demo-cap", 1);
  const merged = applyOverlay(base, { tenant: "feature", entryUrl: base.bindings.entryUrl, controls: {} });
  expect(merged.bindings.tenant).toBe("feature");
  expect(merged.flow).toEqual(base.flow);
});

it("rejects an overlay that tries to change the flow", () => {
  // Spec §4's overlay invariant. A tenant that can edit the logic is not an
  // overlay, it is a fork wearing an overlay's name.
  const base = loadCapability("capabilities", "parabank", "demo-cap", 1);
  expect(() => applyOverlay(base, { tenant: "x", controls: {}, flow: { steps: [] } } as never)).toThrow(/overlay/i);
});
```

- [ ] **Step 2: Run and watch all four fail**
- [ ] **Step 3: Implement.** Read the file at the store path from Task 12 of phase 2 (`capabilities/<product>/<id>/<version>.json`), `parseArtifact` it, and for the overlay accept only `tenant`, `variant`, `entryUrl` and `controls`, rejecting any other key by name in the error.
- [ ] **Step 4: Run and watch them pass**
- [ ] **Step 5: Commit**

---

### Task 2: Replay-time identity by corroboration

This is the phase's central task and the answer to the one hole Phase 2 shipped knowingly. Read the reasoning before writing code.

Record-time proving verified that **every rung in a chain resolves to the same element**. At replay there is no observation handle to compare against, and the only guard today is a `tag` fingerprint — which tier 3 defeats by construction, because `accepts: [tag]` guarantees a wrong element has the right tag.

But the chain itself carries the answer. If two independently-proven strategies now resolve to *different* elements, the surface has drifted since recording, and neither answer can be trusted. That converts the chain from a fallback ladder into a corroboration set, using evidence the artifact already holds.

**Files:** Create `src/replay/identity.ts`; Test `tests/replay/identity.test.ts`

**Interfaces:**
- Consumes: `resolveBinding` from `src/surface/playwright-web/resolver.js`.
- Produces:

```ts
export type Corroboration =
  | { ok: true; handle: Handle; tier: number; agreed: number }
  | { ok: false; reason: "no-match" | "ambiguous" | "fingerprint-mismatch" | "chain-disagreement";
      tier?: number; disagreeingTiers?: number[] };

export async function resolveCorroborated(
  page: Page, binding: Binding, args: Record<string, string>,
): Promise<Corroboration>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves when every rung agrees", async () => {
  // Two proven strategies, one element. This is the ordinary case and must
  // stay cheap to reason about.
  await page.setContent(`<input data-testid="amt" name="amount">`);
  const res = await resolveCorroborated(page, {
    scope: [],
    chain: [
      { tier: 0, by: "testid", value: "amt" },
      { tier: 2, by: "css", value: 'input[name="amount"]' },
    ],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.agreed).toBe(2);
});

it("refuses when two rungs resolve to different elements", async () => {
  // The surface drifted: the test id moved to a different input. Each rung
  // still resolves uniquely, so every check that exists today passes — and
  // acting on either would be a guess about which one the recording meant.
  await page.setContent(`
    <input data-testid="amt" name="moved">
    <input name="amount">
  `);
  const res = await resolveCorroborated(page, {
    scope: [],
    chain: [
      { tier: 0, by: "testid", value: "amt" },
      { tier: 2, by: "css", value: 'input[name="amount"]' },
    ],
  }, {});
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.reason).toBe("chain-disagreement");
  expect(res.disagreeingTiers).toEqual([0, 2]);
});

it("still resolves on a single-rung chain, reporting that nothing corroborated it", async () => {
  // Honest rather than strict: a one-rung binding cannot be corroborated, and
  // refusing it would make the common case unreplayable. The count says so.
  await page.setContent(`<input data-testid="amt">`);
  const res = await resolveCorroborated(page, {
    scope: [], chain: [{ tier: 0, by: "testid", value: "amt" }],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.agreed).toBe(1);
});

it("ignores a rung that no longer resolves at all, provided the rest agree", async () => {
  // A missing rung is drift too, but it is not ambiguity: nothing about it
  // suggests a different element. Recording it as unresolved and continuing
  // is what keeps a capability alive across a harmless markup change.
  await page.setContent(`<input name="amount">`);
  const res = await resolveCorroborated(page, {
    scope: [],
    chain: [
      { tier: 0, by: "testid", value: "gone" },
      { tier: 2, by: "css", value: 'input[name="amount"]' },
    ],
  }, {});
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.agreed).toBe(1);
});
```

- [ ] **Step 2: Run and watch all four fail**

- [ ] **Step 3: Implement**

Resolve *every* rung rather than stopping at the first success. Compare the resulting elements by their stamped resolver handle. Agreement among the rungs that resolved is success, and `agreed` reports how many corroborated. Any two that resolve to different elements is `chain-disagreement`, naming the tiers, and nothing is acted on.

Cost is a full chain walk per control instead of an early exit. Replay is not latency-critical and determinism is the product; say so in a comment so nobody "optimises" it back to first-match later.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Prove it binds.** Reduce `resolveCorroborated` to return the first successful rung. The disagreement test must go red. It is not done until you have watched that.

- [ ] **Step 6: Commit**

---

### Task 3: The four-shape result contract

**Files:** Create `src/replay/result.ts`; Test `tests/replay/result.test.ts`

**Interfaces:** Produces `ReplayResult` exactly as spec §7 declares it — `success` / `business_outcome` / `escalated` / `failed` — plus `FailureKind`.

- [ ] **Step 1: Write the failing test**

```ts
it("makes a business outcome a success carrying a code, not a failure", () => {
  // "No such account" is the answer the caller asked for. A contract that
  // reports it as a crash makes every caller write the same unwrapping.
  const r: ReplayResult = { status: "business_outcome", code: "RECORD_NOT_FOUND",
                            message: "No such account", evidence: stubEvidence };
  expect(r.status).not.toBe("failed");
});

it("cannot express a failure without saying what was expected and what was seen", () => {
  // @ts-expect-error a `failed` result missing `observed` is not constructible
  const bad: ReplayResult = { status: "failed", stepId: "s1", expected: "x",
                              classification: "hard", evidence: stubEvidence };
  void bad;
});
```

- [ ] **Step 2: Run, watch it fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, watch it pass** — [ ] **Step 5: Commit**

---

### Task 4: Runtime conditions, visibility-gated

Spec §7's table, one detector each. Two rules make the table honest and both are testable: every detector asserts the node is **rendered**, and every recovery is **bounded**.

**Files:** Create `src/replay/conditions.ts`; Test `tests/replay/conditions.test.ts`

**Interfaces:**

```ts
export type ConditionClass = "business" | "recoverable" | "hard";
export interface DetectedCondition { id: string; class: ConditionClass; code: string; message: string }
export async function detect(page: Page, declared: ConditionDecl[]): Promise<DetectedCondition | null>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("does not fire on a hidden error node", async () => {
  // The target ships these by the dozen. A detector that fires on one reports
  // a business outcome for a page that is displaying nothing of the sort.
  await page.setContent(`<div id="err" style="display:none">Account not found</div>`);
  expect(await detect(page, [notFoundDecl])).toBeNull();
});

it("fires when the same node is shown", async () => {
  await page.setContent(`<div id="err">Account not found</div>`);
  const c = await detect(page, [notFoundDecl]);
  expect(c).toMatchObject({ class: "business", code: "RECORD_NOT_FOUND" });
});

it("classifies each of the seven declared conditions into its declared class", () => {
  // The mechanism is uniform and only the data differs (§7); this pins that
  // the data is complete rather than that the mechanism works.
  const classes = SEVEN_CONDITIONS.map((c) => c.class);
  expect(classes.filter((c) => c === "business")).toHaveLength(3);
  expect(classes.filter((c) => c === "recoverable")).toHaveLength(4);
});
```

- [ ] **Step 2: Run, watch them fail** — [ ] **Step 3: Implement, reusing `isRenderedIn` semantics** — [ ] **Step 4: Run, watch them pass** — [ ] **Step 5: Commit**

---

### Task 5: Bounded recovery

**Files:** Create `src/replay/recover.ts`; Test `tests/replay/recover.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("stops after maxAttempts rather than retrying forever", async () => {
  const attempts = await recover(page, alwaysFailingDecl, { maxAttempts: 2 });
  expect(attempts.tried).toBe(2);
  expect(attempts.recovered).toBe(false);
});

it("re-verifies the last checkpoint after a session refresh", async () => {
  // Spec §7: refresh, re-verify, resume. Resuming without re-verifying assumes
  // the page came back to where it was, which is the assumption that makes a
  // resumed run act on the wrong screen.
  const r = await recover(page, sessionExpiryDecl, { maxAttempts: 1, session: stubProvider });
  expect(r.checkpointReverified).toBe(true);
});
```

- [ ] **Step 2: Run, watch them fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, watch them pass** — [ ] **Step 5: Commit**

---

### Task 6: The replay engine

**Files:** Create `src/replay/engine.ts`; Test `tests/replay/engine.test.ts` (container-free, local fixtures), `tests/e2e/replay.test.ts` (live ParaBank)

**Interfaces:**

```ts
export async function replay(opts: {
  page: Page; artifact: CapabilityArtifact; args: Record<string, string>;
  policy: PolicyConfig; log: RunLogger; session?: SessionProvider;
}): Promise<ReplayResult>;
```

- [ ] **Step 1: Write the failing tests, one per result shape**

```ts
it("returns success with the declared outputs", async () => { /* … */ });

it("returns a business outcome without acting further", async () => {
  // Assert against the page, not the result: a business outcome that kept
  // executing is indistinguishable from one that stopped, by its status alone.
});

it("escalates rather than acting when the gate refuses", async () => {
  // Same rule as discovery: assert the URL did not change and the click did
  // not land. A result saying "escalated" is also consistent with the action
  // running and then being reported.
});

it("fails with the step, the expectation and what it saw", async () => { /* … */ });

it("refuses to act when the chain disagrees with itself", async () => {
  // Task 2's corroboration reaching the engine.
});

it("never acts on a control the artifact does not bind", async () => { /* … */ });
```

- [ ] **Step 2: Run, watch them fail**
- [ ] **Step 3: Implement.** Walk `flow.steps`. Resolve each control with `resolveCorroborated`. Gate before every action, using the same `gate()` every other path calls. Run `detect` after each step; a business condition ends the run with its code, a recoverable one goes through bounded recovery, a hard one fails. Extract declared outputs. Log every decision.
- [ ] **Step 4: Run, watch them pass**
- [ ] **Step 5: Mutate one stopping path per test and watch that specific test go red**
- [ ] **Step 6: Commit**

---

### Task 7: Replay evidence, including what it cost

**Files:** Modify `src/evidence/logger.ts` consumers; Create `tests/replay/evidence.test.ts`

Phase 2 found that the evidence log records which control the model chose but not what the run spent. For a system whose hard operating constraint is a dollar ceiling, spend belongs in the same append-only trail as the actions. Replay spends nothing on models, but it spends **time**, and the same argument applies to a wall-clock budget.

- [ ] **Step 1: Write the failing tests**

```ts
it("records every step, its resolved tier, and how many rungs corroborated it", async () => { /* … */ });

it("records a run summary carrying elapsed time against its budget", async () => { /* … */ });

it("carries no credential, token or argument value", async () => {
  // Replay takes arguments — the values discovery refused to record. They must
  // not be logged either, or the artifact's discipline is undone at the sink.
  const raw = readFileSync(logPath, "utf8");
  expect(raw).not.toContain(SECRET_ARG);
});
```

- [ ] **Step 2: Run, watch them fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, watch them pass** — [ ] **Step 5: Commit**

---

### Task 8: Stability harness

Spec §7 says the stability harness is *how determinism is evidenced rather than asserted*. It must be able to report instability, or it evidences nothing.

**Files:** Create `src/replay/stability.ts`; Test `tests/replay/stability.test.ts`

**Interfaces:** `export async function stability(run: () => Promise<ReplayResult>, n: number): Promise<StabilityReport>` where the report carries per-run status, the resolved tier per control, and whether all runs agreed.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports agreement across N identical runs", async () => { /* … */ });

it("reports disagreement when a run differs, rather than averaging it away", async () => {
  // A harness that summarises N runs into a pass rate hides the one run that
  // resolved a different tier — which is the exact signal it exists to surface.
  const report = await stability(alternatingRun, 4);
  expect(report.agreed).toBe(false);
  expect(report.divergences).toHaveLength(1);
});
```

- [ ] **Step 2: Run, watch them fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, watch them pass** — [ ] **Step 5: Commit**

---

### Task 9: Three recorded replays — the phase exit criterion

Spec §15 names the exit: *success, business-outcome, and hard-failure replays recorded.* Against live ParaBank, driven by the artifact Phase 2 recorded.

**Files:** Create `scripts/replay.mts`; Test `tests/e2e/replay-outcomes.test.ts`

- [ ] **Step 1: Write the failing e2e tests**

```ts
it("replays the recorded capability to success", async () => { /* … */ });

it("returns a business outcome for an account that does not exist", async () => {
  // Same artifact, different argument. The capability did not fail; it
  // answered.
});

it("fails hard, with a classification, when the surface has genuinely moved", async () => {
  // Rewrite the page so a bound control is gone, and confirm the run reports
  // which step, what it expected, and what it saw — rather than throwing.
});
```

- [ ] **Step 2: Run, watch them fail**
- [ ] **Step 3: Implement the runner and make them pass**
- [ ] **Step 4: Run the stability harness over the success case and commit its report as evidence**
- [ ] **Step 5: Verify the seed account still reads −2300.00**
- [ ] **Step 6: Commit**

---

## Self-Review

**Spec coverage.** §4 loading and the overlay invariant → Task 1. §7 determinism → Tasks 2, 8; runtime conditions → Task 4; bounded recovery → Task 5; result contract → Task 3. §9 safety → Task 6's gate. §11 evidence → Task 7. §15's exit criterion → Task 9.

**Carried, and deliberately not closed here:** `binding.scope` frame and shadow descent (no frames on this target); the `contenteditable` role heuristic mismatch; capability ids on the one legacy artifact recorded before ids were caller-supplied. Each is noted where it would bite and none blocks a replay.

**The known hole this phase exists to close:** record-time identity had no replay-time counterpart. Task 2 is that counterpart, and Task 6 is where it reaches the engine. If Task 2 is descoped, the phase does not deliver deterministic replay — it delivers replay.

**Type consistency.** `ReplayResult` (Task 3) is returned by Tasks 6, 8, 9. `Corroboration` (Task 2) is consumed by Task 6. `DetectedCondition` (Task 4) is consumed by Tasks 5 and 6. `loadCapability` (Task 1) feeds Tasks 6 and 9.
