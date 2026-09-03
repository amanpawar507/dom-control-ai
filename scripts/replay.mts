// Replay a recorded capability against the live target.
//
//   npm run replay -- --id billing.pay-bill --arg name=value ... --video /tmp/x
//
// No model, no API key, no spend — that is the whole point of the artifact.
// What it costs is wall clock and whatever the capability itself does to the
// application, which for a payment is real fixture money.
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { loadCapability } from "../src/replay/load.js";
import { replay } from "../src/replay/engine.js";
import { RunLogger } from "../src/evidence/logger.js";
import { ParabankSessionProvider } from "../src/session/playwright-state.js";
import { BASE, POLICY, PARABANK_CONDITIONS, PRODUCT, VIEWPORT } from "../src/e2e/replay-parabank.js";

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    version: { type: "string", default: "1" },
    arg: { type: "string", multiple: true, default: [] },
    video: { type: "string" },
    approve: { type: "boolean", default: false },
  },
});
if (values.id === undefined) throw new Error("--id is required: which capability to replay");

const args: Record<string, string> = {};
for (const pair of values.arg) {
  const eq = pair.indexOf("=");
  if (eq < 0) throw new Error(`--arg must be name=value, got ${JSON.stringify(pair)}`);
  args[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const artifact = loadCapability(".", PRODUCT, values.id, Number(values.version));
const session = await new ParabankSessionProvider(BASE).acquire(PRODUCT, "local");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  storageState: JSON.parse(session.storageState),
  ...(values.video === undefined ? {} : { recordVideo: { dir: values.video, size: VIEWPORT } }),
});
const page = await context.newPage();
const log = new RunLogger(`replay-${Date.now()}`);

console.log(`replaying ${artifact.capability.id} v${artifact.capability.version} (${artifact.capability.status})`);
console.log(`  entry:  ${artifact.bindings.entryUrl}`);
console.log(`  steps:  ${artifact.flow.steps.length}`);

const result = await replay({
  page,
  artifact,
  args,
  // `--approve` grants the guarded class for this replay, exactly as it does
  // for a recording run. A capability that sends money is guarded by design;
  // replaying one is still a decision somebody makes at the command line.
  policy: { ...POLICY, approved: values.approve === true },
  log,
  conditions: PARABANK_CONDITIONS,
});

console.log(`\n  status: ${result.status}`);
if (result.status === "success") console.log(`  outputs: ${JSON.stringify(result.outputs)}`);
if (result.status === "business_outcome") console.log(`  ${result.code}: ${result.message}`);
if (result.status === "failed") console.log(`  ${result.stepId}\n  expected ${result.expected}\n  observed ${result.observed}`);
if (result.status === "escalated") console.log(`  ${result.reason}`);
console.log(`  evidence: ${result.evidence.logPath}`);

await context.close();
await browser.close();
process.exitCode = result.status === "success" ? 0 : 1;
