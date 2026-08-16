// CLI wrapper. The run itself lives in src/e2e/phase1-smoke.ts so that both
// this script and tests/e2e/phase1.test.ts drive the same code path — a runner
// that only exists under scripts/ is a runner the test suite cannot import.
//
//   npx tsx scripts/phase1-smoke.mts
import { runPhase1Smoke } from "../src/e2e/phase1-smoke.js";

const result = await runPhase1Smoke();
console.log(JSON.stringify(result, null, 2));
