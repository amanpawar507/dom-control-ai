import { describe, it, expect } from "vitest";
import { loadCapability, applyOverlay } from "../../src/replay/load.js";

// The one artifact actually committed to the store (`capabilities/`).
// Its id is a truncated goal slug — a known Phase 2 defect that predates ids
// becoming caller-supplied. Not fixed here: renaming it would orphan the
// file at its recorded path.
const PRODUCT = "parabank";
const ID = "record_the_first_account_number_listed_in_the_ac";

/** Runs `fn`, returns the thrown error's message, and fails if it did not throw. */
function messageFrom(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected function to throw, but it did not");
}

describe("loadCapability", () => {
  it("loads a stored artifact and validates it on the way in", () => {
    const a = loadCapability(".", PRODUCT, ID, 1);
    expect(a.capability.id).toBe(ID);
    expect(a.bindings.entryUrl).toBe("http://localhost:8081/parabank/overview.htm");
    expect(a.flow.steps.length).toBeGreaterThan(0);
  });

  it("refuses an artifact whose flow names a control with no binding, and says which control", () => {
    // parseArtifact already rejects this; the point is that loading does not
    // bypass it. A file read off disk is `unknown` and never went through
    // the type system until parseArtifact runs on it.
    const message = messageFrom(() => loadCapability("tests/fixtures/store-broken", PRODUCT, "unbound", 1));
    expect(message).toContain("missing_control");
    expect(message).toContain("no binding");
  });

  it("throws rather than returning something when no artifact is recorded at that path", () => {
    // Distinguishes "the file doesn't exist" from "the file is invalid" —
    // both must fail, but conflating them would let a typo'd path masquerade
    // as a schema rejection.
    const message = messageFrom(() => loadCapability(".", PRODUCT, "does-not-exist", 1));
    expect(message).not.toContain("no binding");
  });
});

describe("applyOverlay", () => {
  const base = loadCapability(".", PRODUCT, ID, 1);

  it("applies a tenant overlay to bindings only, leaving capability and flow untouched", () => {
    const merged = applyOverlay(base, { tenant: "feature", entryUrl: base.bindings.entryUrl, controls: {} });
    expect(merged.bindings.tenant).toBe("feature");
    expect(merged.flow).toEqual(base.flow);
    expect(merged.capability).toEqual(base.capability);
    // The overlay named no controls, so every recorded binding is inherited
    // rather than dropped — an empty `controls: {}` is "no per-control
    // changes", not "erase what was proven at record time".
    expect(merged.bindings.controls).toEqual(base.bindings.controls);
  });

  it("overrides one named control while every other recorded binding is untouched", () => {
    // Mirrors spec §4's own overlay example: a sparse overlay names only the
    // control whose markup differs for this tenant.
    const replacement = { scope: [], chain: [{ tier: 2, by: "css", value: "#go-button" }] };
    const merged = applyOverlay(base, { controls: { button_go: replacement } });
    expect(merged.bindings.controls.button_go).toEqual(replacement);
    expect(merged.bindings.controls.link_12345).toEqual(base.bindings.controls.link_12345);
    expect(merged.bindings.controls.combobox_all_credit_debit).toEqual(base.bindings.controls.combobox_all_credit_debit);
  });

  it("rejects an overlay that tries to change the flow, naming 'flow' as the offending key", () => {
    // Spec §4's overlay invariant. A tenant that can edit the logic is not
    // an overlay, it is a fork wearing an overlay's name.
    const message = messageFrom(() =>
      applyOverlay(base, { tenant: "x", controls: {}, flow: { steps: [] } } as never),
    );
    expect(message).toMatch(/overlay/i);
    expect(message).toContain('"flow"');
  });

  it("rejects an overlay key that is not part of bindings at all, naming that key specifically", () => {
    // A different offending key than the flow test above, so a rejection
    // that merely says "invalid overlay" without naming the key would pass
    // one of these two tests and fail to distinguish itself from the other.
    const message = messageFrom(() => applyOverlay(base, { tenant: "x", hostname: "evil.example" } as never));
    expect(message).toContain('"hostname"');
  });

  it("rejects an overlay that is not an object", () => {
    expect(() => applyOverlay(base, "feature" as never)).toThrow(/overlay/i);
  });
});
