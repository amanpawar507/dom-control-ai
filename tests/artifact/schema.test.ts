import { describe, it, expect } from "vitest";
import { parseArtifact, CapabilityArtifactSchema } from "../../src/artifact/schema.js";

/**
 * The brief this test is adapted from bound only `txn_id` in `bindings`
 * while `flow.steps` names four distinct controls (`txn_id`, `find_btn`,
 * `results_heading`, `amount_cell`). Left as given, the "well-formed
 * artifact" fixture would itself be rejected by the very rule the second
 * test below exists to check — flow references a control with no binding —
 * making the two tests contradict each other. This is the same shape of
 * fixture bug as Task 4's leak test (see the phase 2 ledger, Ruling 2): the
 * fix is to complete the fixture, not to weaken the rule. All four controls
 * are bound below.
 */
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
    entryUrl: "http://localhost:8081/parabank/index.htm",
    controls: {
      txn_id: { scope: [], chain: [{ tier: 2, by: "css", value: "#transactionId" }] },
      find_btn: { scope: [], chain: [{ tier: 2, by: "css", value: "#find_btn" }] },
      results_heading: { scope: [], chain: [{ tier: 2, by: "css", value: "#results_heading" }] },
      amount_cell: { scope: [], chain: [{ tier: 2, by: "css", value: "#amount_cell" }] },
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

  it("rejects an artifact that cannot say where it starts", () => {
    // An artifact with no entry URL is not replayable standalone: something
    // outside it has to know which page to open, and that knowledge has
    // nowhere to live. Required rather than optional for that reason.
    const broken = structuredClone(valid) as Record<string, any>;
    delete broken["bindings"].entryUrl;
    expect(() => parseArtifact(broken)).toThrow();
  });

  it("keeps the entry URL in the per-tenant block, where an overlay can correct it", () => {
    // Placement is load-bearing, not cosmetic. `capability` and `flow` are
    // shared across every tenant running the vendor product; `bindings` is the
    // per-tenant surface. Tenant A's install does not sit at tenant B's host,
    // so a starting URL in `capability` would make one tenant's hostname part
    // of a contract the others inherit — and the overlay invariant (a tenant
    // override may modify `bindings` only) would leave them unable to fix it.
    const parsed = parseArtifact(structuredClone(valid));
    expect(parsed.bindings.entryUrl).toBe("http://localhost:8081/parabank/index.htm");
    expect(parsed.capability).not.toHaveProperty("entryUrl");
  });

  it("rejects status outside the declared lifecycle", () => {
    const broken = structuredClone(valid);
    (broken.capability as Record<string, unknown>).status = "yolo";
    // Confirm this throws for the status enum, not for some unrelated
    // reason — the surrounding fixture is otherwise untouched, so if this
    // throws for any reason it is because "yolo" is not draft|approved.
    expect(() => parseArtifact(broken)).toThrow(/status/i);
  });

  it("rejects a replay-illegal tier 4 strategy", () => {
    // Tier 4 is visual/model-assisted and exists only in discovery and
    // escalation. An artifact carrying one could not replay deterministically,
    // so it must be unrepresentable rather than merely unhandled.
    const broken = structuredClone(valid);
    broken.bindings.controls.txn_id.chain = [{ tier: 4, by: "visual", value: "the box" }];
    // Confirm this throws because of the strategy chain, not something else —
    // the error must implicate the tier-4 rung specifically.
    expect(() => parseArtifact(broken)).toThrow(/tier|chain|discriminator/i);
  });

  it("rejects tier 4 at the type level, not only at runtime", () => {
    // z.infer over a discriminated union of literal tiers 0-3 has no tier-4
    // member, so code building a Strategy from this inferred type cannot
    // name tier 4 — this is a compile-time property, asserted here by
    // constructing every legal tier from the inferred type and confirming
    // TypeScript rejects a tier: 4 literal (see the `// @ts-expect-error`).
    // This test only has teeth under `tsc --noEmit`; vitest alone would pass
    // it even if the union secretly allowed tier 4, because `@ts-expect-error`
    // is a compiler-only construct with no runtime effect.
    type Strategy = import("../../src/artifact/schema.js").CapabilityArtifact["bindings"]["controls"][string]["chain"][number];
    const legal: Strategy[] = [
      { tier: 0, by: "testid", value: "x" },
      { tier: 1, by: "role", role: "button", name: "Find" },
      { tier: 2, by: "css", value: "#x" },
      { tier: 3, by: "anchor", anchorText: "Amount", rel: "nearest-below", accepts: ["td"] },
    ];
    expect(legal).toHaveLength(4);

    // @ts-expect-error tier 4 is not a member of Strategy — unrepresentable
    // by construction, not merely rejected by a runtime check.
    const illegal: Strategy = { tier: 4, by: "visual", value: "the box" };
    void illegal;
  });

  // A `fill`/`select` step with no `value` is not a coherent recording —
  // there is nothing to fill or select. The schema is the only thing that
  // would catch this (nothing downstream in this phase consumes
  // `flow.steps` yet), so it has to be structural, not merely conventional.
  it.each(["fill", "select"] as const)("rejects a %s step with no value", (action) => {
    const broken = structuredClone(valid);
    broken.flow.steps.push({ kind: "act", action, control: "txn_id" } as never);
    expect(() => parseArtifact(broken)).toThrow();
  });

  it("still accepts a click step with no value, which legitimately has none", () => {
    // The positive half of the pin above: `click` must not be swept into the
    // same requirement `fill`/`select` now carry.
    const broken = structuredClone(valid);
    broken.flow.steps.push({ kind: "act", action: "click", control: "find_btn" });
    expect(() => parseArtifact(broken)).not.toThrow();
  });

  it("rejects an artifact carrying an unknown top-level field", () => {
    // The overlay invariant (a tenant override may modify `bindings` only)
    // holds by construction: neither `capability` nor `flow` has any
    // tenant-scoped field, and every block is closed to unknown keys. This
    // pins that closure so a future edit can't accidentally loosen it.
    const broken = structuredClone(valid) as Record<string, unknown>;
    broken.tenant = "sneaky";
    const result = CapabilityArtifactSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });
});
