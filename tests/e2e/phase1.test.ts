// Container-dependent: drives the live ParaBank target end to end, so this
// lives under tests/e2e (npm run test:e2e) and is excluded from `npm test`.
//
// The assertions below are the Phase 1 exit criterion. They share a single run:
// runPhase1Smoke() performs a real login and a real browser session, and
// re-running it per test would triple the cost while producing three separate
// evidence files, leaving no single artifact to audit. One run, independent
// assertions over its result.
//
// What is NOT proved here: that the actor refuses to click an escalated
// control. That would require calling act() on the admin Clean button against a
// live database. It is proved container-free in tests/surface/actor.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { CURRENCY_FINGERPRINT, runPhase1Smoke, type SmokeResult } from "../../src/e2e/phase1-smoke.js";

let result!: SmokeResult;

describe("phase 1 end-to-end", () => {
  beforeAll(async () => {
    result = await runPhase1Smoke();
  }, 180_000);

  it("logs in, reaches the overview, and reads a balance with no model in the loop", () => {
    expect(result.checkpointReached).toBe(true);
    expect(result.balance).toMatch(new RegExp(CURRENCY_FINGERPRINT));
  });

  it("resolves each control at its expected tier", () => {
    // The ladder is the phase's centerpiece, so it is pinned rather than counted.
    expect(result.tiersByControl).toEqual({
      nav_overview: 1,
      first_balance: 2,
      admin_clean: 1,
    });
    expect(result.tiersUsed).toEqual([1, 2, 1]);
  });

  it("degrades past a tier-0 rung that matches nothing, tried first", () => {
    // Three assertions, and none of them is redundant.
    //
    // The tier alone cannot show degradation: the number reported is the
    // winning strategy's declared tier, which is 2 whether or not anything was
    // tried before it. The isolated probe adds that the chain's own tier-0 rung
    // matches nothing on this page. Neither says *where* that rung sits — a
    // chain reordered to put the brittle CSS selector first resolves at tier 2
    // and probes `no-match` exactly as this one does, while having inverted the
    // ladder. The declared order is what closes that.
    expect(result.chainTiers["first_balance"]).toEqual([0, 2]);
    expect(result.tier0Outcome).toBe("no-match");
    expect(result.tiersByControl["first_balance"]).toBe(2);
  });

  it("declares every chain in exactly the order that was recorded for it", () => {
    // Resolution rule 2 — "fixed chain order" — means the order is fixed *at
    // replay time*: no scoring, no best-match, the chain is tried in the order
    // the artifact holds. It does not mean the order ascends.
    //
    // An earlier version of this test asserted ascending tiers, which spec §7
    // explicitly rejects: "Tier order is recorded per binding, decided by what
    // proved unique at record time — not fixed globally. On this target that
    // usually yields anchor-first." So the first genuinely recorded chain in
    // Phase 2 would have turned that test red for being *correct*, and the
    // repair would have been to delete it — taking the reorder guard with it.
    //
    // Pinned as an equality against the recorded orders instead. It fails for a
    // reorder, which is the point, and a chain that is legitimately anchor-first
    // is accommodated by writing that order down here rather than by deleting
    // the guard. When the recorder lands, this map is read from the artifact and
    // the expectation becomes "replayed order == recorded order" with no
    // hand-maintained copy at all.
    expect(result.chainTiers).toEqual({
      nav_overview: [1],
      first_balance: [0, 2],
      admin_clean: [1],
    });
  });

  it("refuses an out-of-allowlist navigation through the gate", () => {
    expect(result.refusedForeignNavigation).toBe(true);
    // Refused for the allowlist reason, not because the action was malformed.
    expect(result.refusalReason).toContain("origin not allowed");
    // Refused *before* navigating, not after: the browser never left the target.
    expect(result.urlAfterRefusal).toContain("localhost:8081/parabank");
  });

  it("escalates rather than clicking the admin Clean button", () => {
    expect(result.cleanButtonVerdict).toBe("escalate");
    // Pinning the tier makes this assertion depend on the Clean control
    // actually having been found on the live page, rather than on config alone.
    expect(result.cleanControlTier).toBe(1);
  });

  it("escalates the live Clean button on what it is, not on what the caller called it", () => {
    // Same page, same resolved handle, a caller that says nothing and then a
    // caller that says something false. Against the gate as it was first
    // shipped both of these are `allow`, and the only thing standing between
    // that and a dropped database was the smoke passing the right label.
    expect(result.cleanButtonVerdictUnlabelled).toBe("escalate");
    expect(result.cleanButtonVerdictMislabelled).toBe("escalate");
  });
});
