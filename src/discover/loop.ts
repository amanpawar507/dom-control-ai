// src/discover/loop.ts
import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { proveControl } from "../artifact/prove.js";
import { parseArtifact, type CapabilityArtifact } from "../artifact/schema.js";
import type { RunLogger } from "../evidence/logger.js";
import { observe, OBS_ATTR, type Observation, type ObservedNode } from "../observe/snapshot.js";
import { filterRendered } from "../observe/visibility.js";
import { gate, type PolicyConfig } from "../policy/gate.js";
import { controlNamesFor } from "../surface/playwright-web/actor.js";
import type { Binding } from "../surface/types.js";
import { BudgetExceeded, type Budget } from "./budget.js";
import { MalformedModelOutput, type DriverTurn, type ModelDriver } from "./driver.js";
import { parseToolCall, type ToolCall } from "./tools.js";

/**
 * Why the loop stopped without recording.
 *
 * The first seven are spec §6's stopping-condition table, one for one. The
 * last two are conditions §6 does not name because it assumes them away, and
 * folding either into a neighbouring reason would make that reason mean two
 * different things at the one place an operator reads it:
 *
 *  - `model-output-unusable` — the turn did not parse into the tool
 *    vocabulary, was empty, or named a handle that is not in the observation
 *    it was answering. Deliberately NOT `model-stuck`: a model calling `stuck`
 *    has understood the page and reported a dead end, which is a useful
 *    signal; a model emitting `{"selector": "#login"}` has done something
 *    else entirely, and a report that cannot tell them apart cannot route
 *    them apart.
 *  - `control-unprovable` — an element the model acted on cannot be turned
 *    into a binding that resolves uniquely (`proveControl`). The action
 *    happened; what cannot happen is recording a flow step naming a control
 *    with no binding. Spec §6 forbids a partial artifact, so the whole run
 *    escalates rather than emitting a flow with a hole in it.
 */
export type StopReason =
  | "max-steps"
  | "wall-clock"
  | "dead-end"
  | "model-stuck"
  | "policy-refusal"
  | "budget-exceeded"
  | "checkpoint-unverified"
  | "model-output-unusable"
  | "control-unprovable";

export type DiscoveryResult =
  | { status: "recorded"; artifact: CapabilityArtifact; steps: number }
  | { status: "escalated"; reason: StopReason; steps: number };

export interface DiscoverOptions {
  page: Page;
  goal: string;
  driver: ModelDriver;
  policy: PolicyConfig;
  log: RunLogger;
  budget: Budget;
  /** Spec §6 default: 40. */
  maxSteps?: number;
  /** Spec §6 default: 10 minutes. */
  wallClockMs?: number;
  /**
   * The clock the wall-clock budget is measured against, injectable so that
   * proving the wall-clock stop does not require a test that waits ten
   * minutes — or, worse, a test that sleeps. Resolution rule 4 (§7) is
   * "condition-based waits with explicit budgets, no sleeps"; a test that
   * slept to trip a timeout would be violating the rule it exists to check.
   */
  now?: () => number;
  /** Artifact identity. Defaults are derived from the page rather than invented. */
  product?: string;
  tenant?: string;
  variant?: string;
}

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;

/**
 * How many consecutive acting turns may leave the observation unchanged before
 * the run is called a dead end. Spec §6: "no observable state change across 3
 * consecutive actions".
 */
const DEAD_END_LIMIT = 3;

/**
 * How long the page gets to finish committing whatever an action started
 * before the next observation is taken. A condition (`domcontentloaded`) with
 * an explicit ceiling — never a sleep.
 *
 * Its job is not to guarantee the page has settled; nothing can. It is to stop
 * a navigation that is merely in flight from being read as "the action changed
 * nothing", which would feed dead-end detection a false negative and, three
 * turns running, a false dead end.
 */
const SETTLE_BUDGET_MS = 5_000;

/**
 * A handle as `observe()` mints them: `o<epoch>n<index>`, alphanumeric and
 * nothing else. Checked before a handle is ever interpolated into a selector,
 * because on the `done` path the handle arrives straight from the model and a
 * `"` in it would end the attribute selector and start something else.
 */
const HANDLE_SHAPE = /^[A-Za-z0-9]+$/;

function handleLocator(page: Page, handle: string): Locator | null {
  if (!HANDLE_SHAPE.test(handle)) return null;
  return page.locator(`[${OBS_ATTR}="${handle}"]`);
}

/**
 * A fingerprint of everything about the page the model can see, used to answer
 * one question: did the last action change anything observable?
 *
 * Handles are deliberately excluded. They carry the observation epoch and are
 * renumbered on every `observe()` by design, so including them would make
 * every digest differ from every other digest and dead-end detection would
 * never fire — the "test passes while proving nothing" shape, in the one place
 * it would be hardest to notice, because the loop would look like it was
 * working right up until it burned the whole budget on a dead control.
 *
 * The screenshot is excluded too: it is opt-in, so keying state change on it
 * would make dead-end detection silently depend on a cost flag.
 */
function digestOf(o: Observation): string {
  // JSON gives unambiguous field separation for free: a name ending where the
  // next field begins cannot forge an identical digest, because the quotes and
  // commas are part of the hashed text.
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      o.url,
      o.title,
      o.nodes.map((n) => [n.role, n.name, n.value, n.editable]),
    ]),
  );
  return hash.digest("hex");
}

/**
 * Give the page a bounded chance to finish what the action started. Resolves
 * either way: the observation taken afterwards is the source of truth, and a
 * page that is still loading after the budget is a page whose current state is
 * what the next turn is entitled to see.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: SETTLE_BUDGET_MS }).catch(() => undefined);
}

/**
 * Whether the checkpoint the model named is actually there, right now, on the
 * live page — not whether the model said it was.
 *
 * Exactly one *rendered* match, or the checkpoint does not hold. Three
 * distinct failures collapse into that one predicate, and each is a real way
 * for a `done` to be wrong:
 *
 *  - zero matches — the handle is invented, or names an element that has since
 *    left the DOM (the page moved on and the model did not notice);
 *  - more than one — ambiguous, and this codebase never takes the first of
 *    several;
 *  - matched but not rendered — the case this target ships by the dozen. Spec
 *    §7 calls visibility gating "non-negotiable after finding that the target
 *    ships hidden success and error nodes in the tree", and a `done` whose
 *    checkpoint is a hidden success banner is exactly the false completion
 *    that finding predicts.
 *
 * Written as one `filterRendered` over all matches rather than a count check
 * followed by a render check: a separate `matches.length !== 1` in front would
 * be dead code, since a list of zero or of two survives filtering as a list of
 * zero or of two and fails the same comparison. Dead code in a safety check is
 * worse than no code, because it reads like a second guarantee.
 */
async function checkpointHolds(page: Page, handle: string): Promise<boolean> {
  const loc = handleLocator(page, handle);
  if (loc === null) return false;
  return (await filterRendered(await loc.all())).length === 1;
}

/** A lowercase identifier safe as an artifact control/input/id name. */
function slug(text: string): string {
  const body = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
  if (body === "") return "";
  // The resolver's placeholder syntax is `$` followed by a letter or
  // underscore (`src/surface/playwright-web/resolver.ts`), so a name that
  // starts with a digit could never be substituted at replay time.
  return /^[a-z_]/.test(body) ? body : `c_${body}`;
}

/**
 * Accumulates the three artifact blocks as the run goes, and hands back a
 * validated artifact only when the run has actually succeeded.
 *
 * Nothing here writes anything anywhere. That is the mechanism behind spec
 * §6's "never records a partial artifact": there is no incremental sink to
 * leave half-written, so every escalation path produces no artifact by
 * construction rather than by each path remembering to clean up after itself.
 */
class ArtifactRecorder {
  private readonly controls: Record<string, Binding> = {};
  private readonly byBinding = new Map<string, string>();
  private readonly steps: CapabilityArtifact["flow"]["steps"] = [];
  private readonly inputs: Record<string, { type: string }> = {};
  private readonly outputs: Record<string, { type: string }> = {};

  /**
   * The semantic name this element is recorded under, allocating one the first
   * time it is seen.
   *
   * Identity is keyed on the *proven binding*, not on the element's name or
   * its handle. A handle cannot serve: it is a one-turn token and the same
   * control observed on two turns carries two of them. A name cannot either:
   * `findtrans.html`'s four identically-named buttons would collapse into one
   * control, and the flow would then replay four different clicks against
   * whichever of them happened to be bound. Two touches that prove to the same
   * chain are the same control; anything else gets its own entry.
   */
  bind(node: ObservedNode, binding: Binding): string {
    const key = JSON.stringify(binding);
    const existing = this.byBinding.get(key);
    if (existing !== undefined) return existing;

    const name = this.unique(slug(`${node.role} ${node.name}`) || slug(node.role) || "control");
    this.byBinding.set(key, name);
    this.controls[name] = binding;
    return name;
  }

  step(step: CapabilityArtifact["flow"]["steps"][number]): void {
    this.steps.push(step);
  }

  /**
   * Declares an input parameter for a value the model typed, and returns the
   * placeholder that goes into the flow step in its place.
   *
   * The literal is never recorded — not in the artifact, not in the evidence
   * log. Two reasons, and either alone would be enough. Safety: the loop
   * cannot tell a password field from a search box (`observe()` reports role
   * `textbox` for both, because that is what the accessibility tree says), so
   * "record the value unless it looks sensitive" is a guess made at the one
   * boundary where a wrong guess writes a credential to disk. Correctness:
   * spec §4 is explicit that "a concrete id recorded from one session is never
   * replayed literally" — a capability that hardcodes what one run happened to
   * type is a script, not a capability.
   */
  parameter(control: string): string {
    const name = this.uniqueInput(control);
    this.inputs[name] = { type: "string" };
    return `$${name}`;
  }

  output(as: string): void {
    const name = slug(as) || "output";
    this.outputs[name] = { type: "string" };
  }

  /**
   * The finished artifact, put through `parseArtifact` rather than returned
   * raw. Anything it rejects is a bug in this class, and a loud throw at the
   * moment of recording beats handing a caller an artifact that fails its own
   * schema the first time anyone reads it back off disk.
   */
  finish(capability: {
    id: string;
    product: string;
    goal: string;
    tenant: string;
    variant: string;
    /**
     * Where the run started, captured before the first turn rather than read
     * off the page at the end — by `finish` time the loop has navigated and
     * `page.url()` is wherever it finished, which is not where a replay should
     * begin.
     */
    entryUrl: string;
  }): CapabilityArtifact {
    return parseArtifact({
      capability: {
        id: capability.id,
        product: capability.product,
        version: 1,
        goal: capability.goal,
        inputs: this.inputs,
        outputs: this.outputs,
        // Discovery produces a draft. Approval is a human act (§4), and a
        // recorder that marked its own output approved would be granting
        // itself the permission the `approved` policy flag exists to withhold.
        status: "draft",
      },
      flow: { steps: this.steps },
      bindings: {
        tenant: capability.tenant,
        variant: capability.variant,
        entryUrl: capability.entryUrl,
        controls: this.controls,
      },
    });
  }

  private unique(base: string): string {
    if (this.controls[base] === undefined) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}`;
      if (this.controls[candidate] === undefined) return candidate;
    }
  }

  private uniqueInput(base: string): string {
    if (this.inputs[base] === undefined) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}`;
      if (this.inputs[candidate] === undefined) return candidate;
    }
  }
}

/**
 * The discovery loop.
 *
 * An arbitrary model drives a real UI over the typed vocabulary in
 * `tools.ts`, addressing elements only by opaque handle, and every action it
 * asks for passes the policy gate *before* it is executed. When it calls
 * `done`, the checkpoint it named is verified against the live page and every
 * handle the run touched is turned into a proven binding — producing an
 * artifact that replays with no model in the loop, or nothing at all.
 *
 * Three properties are structural rather than conventional, and each is here
 * because the convention version of it has already failed somewhere in this
 * project:
 *
 *  1. **The gate runs before execution.** Every acting branch below reaches
 *     `gate()` and returns on anything short of `allow` before it touches a
 *     locator's `click`/`fill`/`selectOption`/`goto`. A test that only
 *     asserted the returned status would be satisfied by a loop that acted and
 *     then reported; `tests/discover/loop.test.ts` asserts against the page
 *     instead.
 *  2. **The observation is refreshed, never accumulated.** One `observe()` per
 *     turn, and `history` carries the model's own turns only — no stack of
 *     past snapshots. Spec §6 requires it, and it is also the difference
 *     between a transcript that grows linearly and one that grows
 *     quadratically on a long flow, which is the whole cost model.
 *  3. **Controls are proven before the action, not after.** A click that
 *     navigates takes its own element with it; proving afterwards would find
 *     nothing and every recorded flow would end one step short.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { page, goal, driver, policy, log, budget } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const recorder = new ArtifactRecorder();
  /**
   * Where this run began, read once before the first turn. It is what a replay
   * must open to reproduce the run, and it has to be captured now: by the time
   * an artifact is recorded the loop has navigated, and `page.url()` then is
   * wherever the flow ended up, not where it started.
   */
  const entryUrl = page.url();
  /** The model's turns, and nothing else — see property 2 above. */
  const history: DriverTurn[] = [];

  let steps = 0;
  let chargedIn = 0;
  let chargedOut = 0;
  let previousDigest: string | null = null;
  let lastTurnActed = false;
  let unchangedRuns = 0;

  log.log({ kind: "discover.start", goal, maxSteps, wallClockMs });

  const halt = (reason: StopReason, detail?: Record<string, unknown>): DiscoveryResult => {
    log.log({ kind: "discover.escalated", reason, steps, ...detail });
    return { status: "escalated", reason, steps };
  };

  for (;;) {
    // Both budgets are checked before the model is consulted, so a run that
    // has already exceeded one does not pay for one more turn to find out.
    if (now() - startedAt >= wallClockMs) return halt("wall-clock");
    if (steps >= maxSteps) return halt("max-steps");

    const observation = await observe(page);
    const digest = digestOf(observation);

    // Dead-end detection, measured here rather than immediately after the
    // action, because "did that change anything" is a question about the page
    // once it has had its settle budget, and this is the next time the page is
    // read. `lastTurnActed` gates it so that a run of pure `observe` turns —
    // which legitimately change nothing — is stopped by the step budget, which
    // is the condition that actually describes it, and not misreported as a
    // dead end.
    if (lastTurnActed) {
      if (previousDigest !== null && digest === previousDigest) {
        unchangedRuns += 1;
        log.log({ kind: "discover.no-change", consecutive: unchangedRuns, url: observation.url });
        if (unchangedRuns >= DEAD_END_LIMIT) return halt("dead-end");
      } else {
        unchangedRuns = 0;
      }
    }
    previousDigest = digest;
    lastTurnActed = false;

    let turn: DriverTurn;
    try {
      turn = await driver.next(observation, history);
    } catch (thrown) {
      // Narrow on purpose. `MalformedModelOutput` is a runtime condition and
      // escalates; everything else — `DriverFault` above all — is a fault in
      // the harness or the transport and propagates untouched. A broad catch
      // here is precisely what would let a loop test whose script merely ran
      // out report a clean escalation and pass.
      if (thrown instanceof MalformedModelOutput) {
        return halt("model-output-unusable", { detail: thrown.message });
      }
      throw thrown;
    }
    steps += 1;
    history.push(turn);

    // `usage()` is cumulative over the driver's life, so the charge is the
    // delta since the last one. Charging the running total every turn would
    // bill the first turn's tokens forty times.
    const usage = driver.usage();
    const delta = {
      inputTokens: Math.max(0, usage.inputTokens - chargedIn),
      outputTokens: Math.max(0, usage.outputTokens - chargedOut),
    };
    chargedIn = usage.inputTokens;
    chargedOut = usage.outputTokens;
    try {
      budget.charge(delta);
    } catch (thrown) {
      if (thrown instanceof BudgetExceeded) {
        // The turn that crossed the ceiling is not executed. The money is
        // already spent — nothing can undo that — but a run that is over
        // budget must not also perform one more action on the page.
        return halt("budget-exceeded", { spentUsd: budget.spentUsd() });
      }
      throw thrown;
    }

    let calls: ToolCall[];
    try {
      calls = turn.calls.map((c) => parseToolCall(c.name, c.input));
    } catch (thrown) {
      return halt("model-output-unusable", { detail: (thrown as Error).message });
    }
    if (calls.length === 0) {
      return halt("model-output-unusable", { detail: "the model returned a turn with no tool calls" });
    }

    for (const call of calls) {
      if (call.name === "observe") {
        // The answer is the refresh at the top of the next turn. Nothing to do
        // here beyond spending the step, which is what makes a model that only
        // observes hit the step budget rather than loop forever.
        log.log({ kind: "discover.tool", tool: "observe" });
        continue;
      }

      if (call.name === "stuck") {
        log.log({ kind: "discover.tool", tool: "stuck", reason: call.input.reason });
        return halt("model-stuck", { modelReason: call.input.reason });
      }

      if (call.name === "navigate") {
        // A navigate is judged by where it is going, not by where the page
        // already is, and it has no element, so there is no name to read.
        const verdict = gate(policy, { url: call.input.url, action: "navigate", controlNames: [] });
        log.log({ kind: "discover.gate", tool: "navigate", url: call.input.url, verdict });
        if (verdict.decision !== "allow") return halt("policy-refusal", { verdict });
        await page.goto(call.input.url);
        await settle(page);
        lastTurnActed = true;
        continue;
      }

      if (call.name === "done") {
        // `done` is a claim. Verify it against the page before anything is
        // recorded — an unverified checkpoint means the goal was not reached,
        // whatever the model asserted.
        const verified = await checkpointHolds(page, call.input.checkpoint);
        log.log({ kind: "discover.checkpoint", verified });
        if (!verified) return halt("checkpoint-unverified");

        // Verified on the page, yet absent from the observation this turn was
        // answering. `observe()` clears and renumbers every stamp, so nothing
        // reachable under `OBS_ATTR` can be from an older epoch — this is
        // unreachable in practice, and it is reported as unusable model output
        // rather than as an unverified checkpoint precisely because it is not
        // a statement about the checkpoint. Same condition, same reason, as a
        // `click` naming a handle from nowhere.
        const node = observation.nodes.find((n) => n.handle === call.input.checkpoint);
        if (node === undefined) {
          return halt("model-output-unusable", {
            detail: `checkpoint "${call.input.checkpoint}" is not in the observation this turn answered`,
          });
        }

        let control: string;
        try {
          control = recorder.bind(node, await proveControl(page, node));
        } catch (thrown) {
          return halt("control-unprovable", { detail: (thrown as Error).message, control: "checkpoint" });
        }
        recorder.step({ kind: "checkpoint", control });

        const artifact = recorder.finish({
          id: slug(goal) || "capability",
          product: opts.product ?? productFrom(observation.url),
          goal,
          entryUrl,
          tenant: opts.tenant ?? "default",
          variant: opts.variant ?? "baseline",
        });
        log.log({ kind: "discover.recorded", steps, artifact });
        return { status: "recorded", artifact, steps };
      }

      // click / fill / select / extract — everything addressed by handle.
      const node = observation.nodes.find((n) => n.handle === call.input.handle);
      if (node === undefined) {
        return halt("model-output-unusable", {
          detail: `handle "${call.input.handle}" is not in the observation this turn answered`,
        });
      }
      const loc = handleLocator(page, node.handle);
      if (loc === null || (await loc.count()) !== 1) {
        return halt("model-output-unusable", {
          detail: `handle "${node.handle}" no longer matches exactly one element`,
        });
      }

      // What the gate is asked about is read off the element, never taken from
      // the model. The model supplied a handle and nothing else, so there is
      // no label for it to talk the gate down with.
      const controlNames = await controlNamesFor(loc);
      if (node.name !== "" && !controlNames.includes(node.name)) controlNames.push(node.name);
      const verdict = gate(policy, { url: page.url(), action: call.name, controlNames });
      log.log({ kind: "discover.gate", tool: call.name, controlNames, verdict });
      if (verdict.decision !== "allow") return halt("policy-refusal", { verdict });

      // Proven before the action — see property 3 on `discover`.
      let control: string;
      try {
        control = recorder.bind(node, await proveControl(page, node));
      } catch (thrown) {
        return halt("control-unprovable", { detail: (thrown as Error).message, tool: call.name });
      }

      switch (call.name) {
        case "click":
          await loc.click();
          recorder.step({ kind: "act", action: "click", control });
          lastTurnActed = true;
          break;
        case "fill":
          await loc.fill(call.input.value);
          recorder.step({ kind: "act", action: "fill", control, value: recorder.parameter(control) });
          lastTurnActed = true;
          break;
        case "select":
          await loc.selectOption(call.input.value);
          recorder.step({ kind: "act", action: "select", control, value: recorder.parameter(control) });
          lastTurnActed = true;
          break;
        case "extract":
          // A read with no effect: it declares an output rather than producing
          // one. The value itself is never read here, so it is never in a
          // position to be logged.
          recorder.step({ kind: "extract", control, as: call.input.as });
          recorder.output(call.input.as);
          break;
      }
      // `extract` is the one branch that does not set `lastTurnActed`.
      if (call.name !== "extract") {
        log.log({ kind: "discover.acted", tool: call.name, control, url: page.url() });
        await settle(page);
      }
    }
  }
}

/** The product an artifact recorded from this URL belongs to. */
function productFrom(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
