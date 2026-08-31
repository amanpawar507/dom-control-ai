// Runs the recorded capability N times against the live target and writes the
// report spec §7 calls "how determinism is evidenced rather than asserted".
//
//   npm run stability -- --runs 5
//
// It spends no model tokens: replay has no model in the loop, which is the
// property the report exists to demonstrate. What it does spend is wall clock
// and one ParaBank session, acquired once and shared across runs — a fresh
// *page* per run, so every run reloads the entry and re-resolves every control
// from scratch while the login is paid for once.
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openParabankTarget, TYPE_ARGUMENT } from "../src/e2e/replay-parabank.js";
import { stability } from "../src/replay/stability.js";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    out: { type: "string", default: "docs/evidence/stability-report.json" },
    account: { type: "string", default: "12345" },
  },
});

const n = Number(values.runs);
if (!Number.isFinite(n) || n < 2) {
  throw new Error("--runs must be at least 2: a single run cannot agree or disagree with anything");
}

const target = await openParabankTarget();
try {
  const report = await stability(
    async () => (await target.run({ args: { [TYPE_ARGUMENT]: "Debit" } })).result,
    n,
  );

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`${n} runs against the live target`);
  console.log(`  agreed:      ${report.agreed}`);
  console.log(`  statuses:    ${report.runs.map((r) => r.status).join(", ")}`);
  console.log(`  divergences: ${report.divergences.length}`);
  for (const d of report.divergences) {
    const differed = d.observed.map((o) => `run ${o.runIndex} saw ${JSON.stringify(o.value)}`).join("; ");
    console.log(`    ${d.control}: reference ${JSON.stringify(d.reference)} — ${differed}`);
  }
  console.log(`  written to   ${values.out}`);

  // A disagreement is a finding, not a crash: the report is the deliverable
  // either way, and tuning a run until it agrees would defeat the point.
  process.exitCode = report.agreed ? 0 : 1;
} finally {
  await target.close();
}
