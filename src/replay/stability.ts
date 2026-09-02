// src/replay/stability.ts
import { readFileSync } from "node:fs";
import type { ReplayResult } from "./result.js";

/**
 * What one of the N runs contributed. `tiers` is keyed by control name and
 * read back from the run's own evidence log — not carried on `ReplayResult`
 * itself, which is deliberately thin (`src/replay/result.ts`) and does not
 * name individual controls. A caller only ever has `evidence.logPath`, and
 * this is that same trail read back, so a harness that could not do this
 * reading would be proving nothing that a real caller could reproduce.
 */
export interface RunReport {
  runId: string;
  status: ReplayResult["status"];
  tiers: Record<string, number>;
}

/**
 * One thing — a control's resolved tier, or the run's own `status` — that did
 * not hold the same value on every run. `control: "status"` is reserved for
 * the latter; every other value names a control from `bindings.controls`.
 *
 * Shaped like `Corroboration.disagreeingTiers` in `src/replay/identity.ts` on
 * purpose: `reference` is the first run's value — arbitrary but deterministic,
 * documented rather than invented as a majority — and `observed` names only
 * the runs that differed from it, by index, with what they saw instead.
 * Reporting every run's value regardless of whether it matched would bury the
 * one row an operator needs under N-1 rows saying nothing happened.
 */
export interface Divergence {
  control: string;
  reference: number | string;
  observed: Array<{ runIndex: number; value: number | string }>;
}

/**
 * §7's stability harness: "replay N times and report which tier resolved
 * each control on each run… this is how determinism is evidenced rather than
 * asserted." `agreed` is the load-bearing field, and it is true only when
 * every run reached the same `status` *and* every control resolved through
 * the same tier on every run — two runs that both succeed but resolve a
 * control through a different rung of its chain have not produced the same
 * replay, and reporting that as agreement would evidence nothing. A pass
 * rate cannot make that distinction because it has already discarded which
 * run and which control; `divergences` exists so nothing here does.
 */
export interface StabilityReport {
  n: number;
  runs: RunReport[];
  agreed: boolean;
  divergences: Divergence[];
}

export async function stability(run: () => Promise<ReplayResult>, n: number): Promise<StabilityReport> {
  const runs: RunReport[] = [];
  for (let i = 0; i < n; i++) {
    const result = await run();
    runs.push({ runId: result.evidence.runId, status: result.status, tiers: tiersFrom(result.evidence.logPath) });
  }

  const divergences = findDivergences(runs);
  return { n, runs, agreed: divergences.length === 0, divergences };
}

/**
 * The tier that resolved each control, for one run, read from its own
 * evidence log — the same `replay.resolved` event Task 7 pinned into the
 * trail. Only `ok: true` rungs name a tier at all; a control this run never
 * resolved is simply absent, which `findDivergences` below treats as its own
 * kind of disagreement against a run that did resolve it. A control visited
 * more than once keeps its *last* recorded tier — the same "what actually
 * happened most recently" reading `RunLogger`'s append-only file invites
 * anywhere else it is read back.
 */
function tiersFrom(logPath: string): Record<string, number> {
  const tiers: Record<string, number> = {};
  const raw = readFileSync(logPath, "utf8").trim();
  if (raw === "") return tiers;
  for (const line of raw.split("\n")) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event["kind"] !== "replay.resolved" || event["ok"] !== true) continue;
    const control = event["control"];
    const tier = event["tier"];
    if (typeof control === "string" && typeof tier === "number") tiers[control] = tier;
  }
  return tiers;
}

/**
 * Every control (or `"status"`) whose value was not the same on every run,
 * against the first run as reference. Sorted by control name so the report is
 * deterministic run over run — Task 9 commits this as evidence, and a report
 * whose row order depended on `Set` iteration would be a second source of
 * apparent instability layered on top of any real one.
 */
function findDivergences(runs: RunReport[]): Divergence[] {
  const reference = runs[0];
  if (reference === undefined) return [];
  const divergences: Divergence[] = [];

  const statusObserved = diverging(runs, reference.status, (r) => r.status);
  if (statusObserved.length > 0) {
    divergences.push({ control: "status", reference: reference.status, observed: statusObserved });
  }

  const allControls = new Set<string>();
  for (const r of runs) for (const control of Object.keys(r.tiers)) allControls.add(control);

  for (const control of [...allControls].sort()) {
    const referenceValue: number | string = reference.tiers[control] ?? "not-resolved";
    const observed = diverging(runs, referenceValue, (r) => r.tiers[control] ?? "not-resolved");
    if (observed.length > 0) divergences.push({ control, reference: referenceValue, observed });
  }

  return divergences;
}

function diverging<T extends number | string>(
  runs: RunReport[],
  referenceValue: T,
  valueOf: (r: RunReport) => T,
): Array<{ runIndex: number; value: T }> {
  const out: Array<{ runIndex: number; value: T }> = [];
  runs.forEach((r, runIndex) => {
    const value = valueOf(r);
    if (value !== referenceValue) out.push({ runIndex, value });
  });
  return out;
}
