// tests/replay/stability.test.ts
//
// Spec §7: "Replay N times and report which tier resolved each control on
// each run… This is how determinism is evidenced rather than asserted." A
// harness that folds N runs into a pass rate has already thrown away the one
// thing it exists to report, so the tests below are built around a `run`
// that differs across calls, not one that always agrees with itself.
//
// No browser here. `stability()` learns which tier resolved each control by
// reading the run's own evidence log back through `evidence.logPath` — the
// same story `tests/replay/evidence.test.ts` proves a real replay leaves
// behind — so a canned `run` only needs to write that one kind of event
// through a real `RunLogger` to stand in for one.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { stability } from "../../src/replay/stability.js";
import { RunLogger } from "../../src/evidence/logger.js";
import type { ReplayResult } from "../../src/replay/result.js";

const DIR = "tests/.tmp-stability-evidence";
afterEach(() => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
});

let seq = 0;

/**
 * A run that resolves the given controls at the given tiers and returns the
 * given status — everything `stability()` needs, without a page. `agreed: 1`
 * throughout: no test here depends on the corroboration count, only on tier.
 */
function cannedRun(controls: Record<string, number>, status: ReplayResult["status"] = "success"): () => Promise<ReplayResult> {
  return async () => {
    seq += 1;
    const log = new RunLogger(`stability-test-${seq}`, DIR);
    for (const [control, tier] of Object.entries(controls)) {
      log.log({ kind: "replay.resolved", step: `s:${control}`, control, ok: true, tier, agreed: 1 });
    }
    const evidence = { runId: log.runId, logPath: log.path() };
    switch (status) {
      case "success":
        return { status, outputs: {}, evidence };
      case "failed":
        return { status, stepId: "s1", expected: "x", observed: "y", classification: "hard", evidence };
      case "business_outcome":
        return { status, code: "X", message: "m", evidence };
      case "escalated":
        return { status, interventionId: "i", reason: "r", evidence };
    }
  };
}

describe("stability — agreement", () => {
  it("reports agreement across N identical runs", async () => {
    const run = cannedRun({ account_input: 0, find_button: 1 });
    const report = await stability(run, 4);

    expect(report.n).toBe(4);
    expect(report.runs).toHaveLength(4);
    expect(report.agreed).toBe(true);
    expect(report.divergences).toEqual([]);
    // Per-run status and per-control tier both carried, not summarised away.
    for (const r of report.runs) {
      expect(r.status).toBe("success");
      expect(r.tiers).toEqual({ account_input: 0, find_button: 1 });
    }
  });
});

describe("stability — instability, reported rather than averaged away", () => {
  it("reports disagreement when a run differs, rather than averaging it away", async () => {
    // A control that resolves via a different tier on one run out of four —
    // the surface drifted, then the very same run's chain happened to still
    // land somewhere, at a different rung. A pass-rate harness ("75%
    // passed") would hide exactly this.
    let call = 0;
    const alternatingRun = async (): Promise<ReplayResult> => {
      call += 1;
      const tier = call === 3 ? 2 : 0;
      return cannedRun({ find_button: tier })();
    };

    const report = await stability(alternatingRun, 4);

    expect(report.agreed).toBe(false);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      control: "find_button",
      reference: 0,
      observed: [{ runIndex: 2, value: 2 }],
    });
  });

  it("treats two runs that both succeed but resolve a control at different tiers as disagreement, not agreement", async () => {
    // The definition of agreement this harness uses: same status is not
    // enough. Two successful runs that resolved a control through different
    // rungs of its chain did not produce the same replay, and calling that
    // agreement would evidence nothing.
    let call = 0;
    const run = async (): Promise<ReplayResult> => {
      call += 1;
      return cannedRun({ account_input: call === 2 ? 3 : 0 }, "success")();
    };

    const report = await stability(run, 2);

    expect(report.runs.every((r) => r.status === "success")).toBe(true);
    expect(report.agreed).toBe(false);
    expect(report.divergences).toEqual([
      { control: "account_input", reference: 0, observed: [{ runIndex: 1, value: 3 }] },
    ]);
  });

  it("reports a status divergence distinctly from a tier divergence", async () => {
    let call = 0;
    const run = async (): Promise<ReplayResult> => {
      call += 1;
      return cannedRun({ account_input: 0 }, call === 4 ? "failed" : "success")();
    };

    const report = await stability(run, 4);

    expect(report.agreed).toBe(false);
    const statusDivergence = report.divergences.find((d) => d.control === "status");
    expect(statusDivergence).toMatchObject({
      reference: "success",
      observed: [{ runIndex: 3, value: "failed" }],
    });
    // The control that resolved identically on every run is not also reported.
    expect(report.divergences.some((d) => d.control === "account_input")).toBe(false);
  });

  it("names every control that diverges, not just the first", async () => {
    let call = 0;
    const run = async (): Promise<ReplayResult> => {
      call += 1;
      const drifted = call === 2;
      return cannedRun({
        account_input: drifted ? 3 : 0,
        find_button: drifted ? 2 : 1,
      })();
    };

    const report = await stability(run, 3);

    expect(report.agreed).toBe(false);
    expect(report.divergences.map((d) => d.control).sort()).toEqual(["account_input", "find_button"]);
  });
});
