// tests/replay/result.test.ts
//
// `ReplayResult` is a type, not a function, so there is no branch here for a
// mutation to flip — its correctness is pinned by `tsc --noEmit` reading the
// object literals below against the declared union, not by anything these
// tests execute at runtime. What each `it` proves is that the shape TypeScript
// accepts is the shape spec §7 actually wants: a business outcome typed
// alongside `success`, not alongside `failed`, and a `failed` result that
// cannot be built with half its diagnostic missing.
import { describe, it, expect } from "vitest";
import type { Evidence, FailureKind, ReplayResult } from "../../src/replay/result.js";

const stubEvidence: Evidence = { runId: "run-1", logPath: "evidence/run-1/run.jsonl" };

describe("ReplayResult", () => {
  it("makes a business outcome a success carrying a code, not a failure", () => {
    // "No such account" is the answer the caller asked for. A contract that
    // reports it as a crash makes every caller write the same unwrapping.
    const r: ReplayResult = {
      status: "business_outcome",
      code: "RECORD_NOT_FOUND",
      message: "No such account",
      evidence: stubEvidence,
    };
    expect(r.status).not.toBe("failed");
  });

  it("cannot express a failure without saying what was expected and what was seen", () => {
    // @ts-expect-error a `failed` result missing `observed` is not constructible
    const bad: ReplayResult = {
      status: "failed",
      stepId: "s1",
      expected: "x",
      classification: "hard",
      evidence: stubEvidence,
    };
    void bad;
  });

  it("accepts every shape spec §7 declares, and nothing status cannot name", () => {
    // A compile-time pin, not a behavioural one: each literal below has to
    // type-check as a `ReplayResult`, and a union member silently dropped from
    // the type (or a required field silently made optional) would fail here
    // at `tsc`, not at `expect`.
    const success: ReplayResult = { status: "success", outputs: { accountId: "12345" }, evidence: stubEvidence };
    const escalated: ReplayResult = {
      status: "escalated",
      interventionId: "int-1",
      reason: "irreversible action requires a human",
      evidence: stubEvidence,
    };
    const classifications: FailureKind[] = [
      "no-match",
      "ambiguous",
      "fingerprint-mismatch",
      "chain-disagreement",
      "policy-refusal",
      "action-refused",
      "hard",
    ];
    const failed: ReplayResult = {
      status: "failed",
      stepId: "s1",
      expected: "the checkpoint control visible",
      observed: "a login form",
      classification: "chain-disagreement",
      evidence: stubEvidence,
    };
    expect(success.status).toBe("success");
    expect(escalated.status).toBe("escalated");
    expect(failed.status).toBe("failed");
    expect(classifications).toHaveLength(7);
  });

  it("keeps evidence on every shape, so a result never points nowhere", () => {
    const results: ReplayResult[] = [
      { status: "success", outputs: {}, evidence: stubEvidence },
      { status: "business_outcome", code: "X", message: "x", evidence: stubEvidence },
      { status: "escalated", interventionId: "i", reason: "r", evidence: stubEvidence },
      {
        status: "failed",
        stepId: "s",
        expected: "e",
        observed: "o",
        classification: "hard",
        evidence: stubEvidence,
      },
    ];
    for (const r of results) expect(r.evidence).toBe(stubEvidence);
  });
});
