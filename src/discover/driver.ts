// src/discover/driver.ts
import type { Observation } from "../observe/snapshot.js";

/**
 * One turn's worth of tool calls, in the shape the discovery loop consumes
 * regardless of where they came from — a real model response or a scripted
 * fixture. `calls[].input` is `unknown` here on purpose: this is the seam
 * boundary, upstream of `parseToolCall` (src/discover/tools.ts), which is
 * what actually proves a call's shape before the loop trusts it.
 */
export interface DriverTurn {
  calls: Array<{ name: string; input: unknown }>;
}

/**
 * The harness driving the loop is broken. A script that ran out of turns, a
 * transport that cannot be constructed, a driver misconfigured at the call
 * site — none of these are things the run can be asked to recover from,
 * because none of them say anything about the page or the model. They are
 * bugs in whoever set the run up.
 *
 * The discovery loop must let this propagate. That is not a stylistic
 * preference: `ScriptedDriver` below throws it when a test's script runs out,
 * and a loop that caught it and escalated would turn "this test wrote too
 * short a script" into "the loop reached a stopping condition", which is a
 * clean pass for a test that proved nothing. This project has shipped that
 * exact false-pass shape nine times; here the two failures are given
 * different types so a loop cannot conflate them even by accident.
 */
export class DriverFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverFault";
  }
}

/**
 * The model answered, and the answer is unusable — an unknown tool name,
 * input that fails its schema, an empty turn, a handle naming nothing in the
 * observation it was answering. Unlike `DriverFault` this is an ordinary
 * runtime condition: models do produce garbage, and the loop's response is to
 * stop and escalate rather than to crash the process.
 *
 * Separate from `DriverFault` for exactly one reason: the loop treats them
 * differently. This one is caught and turned into an escalation; that one is
 * rethrown. Collapsing them into a single type would make the distinction
 * unavailable at the catch site, which is where it has to be made.
 */
export class MalformedModelOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedModelOutput";
  }
}

/**
 * The one door the discovery loop uses to talk to a model. Nothing in the
 * loop is allowed to import the Anthropic SDK, construct a client, or read
 * `ANTHROPIC_API_KEY` — it calls `next()` on whatever `ModelDriver` it was
 * given and nothing else. That is what makes `ScriptedDriver` below a
 * complete stand-in rather than a partial mock: the loop cannot tell the
 * difference between a scripted run and a real one, because it never sees
 * anything past this interface.
 *
 * With $5 of total budget funding this phase, that indirection is not a
 * nicety. A real driver (Task 12) spends money every time `next()` is
 * called; a scripted one (below) never does. Every test of the loop's
 * control flow — stopping conditions, the policy gate, dead-end detection,
 * artifact emission — runs against `ScriptedDriver` and costs nothing. Only
 * the handful of tests that exist to prove the real driver works at all
 * (Task 12) are allowed to spend.
 *
 * `usage()` exists on the interface, not bolted onto a concrete class,
 * precisely so a loop test can assert "nothing was spent" against whatever
 * driver it was handed, without knowing which implementation it is holding.
 *
 * `usage()` is **cumulative over the driver's lifetime**, not per-turn. The
 * loop charges the delta since the previous reading (`src/discover/loop.ts`),
 * so a driver that returned only the last turn's tokens would be undercharged
 * on every turn after the first — and undercharging is the direction that
 * spends real money. This sentence is the contract; an implementation that
 * disagrees with it is the one that is wrong.
 */
export interface ModelDriver {
  next(observation: Observation, history: DriverTurn[]): Promise<DriverTurn>;
  usage(): { inputTokens: number; outputTokens: number };
}

/**
 * A `ModelDriver` that plays back a fixed sequence of turns instead of
 * calling a model. Each element of `script` is one turn's `calls`; `next()`
 * hands them out in order regardless of what `observation` or `history` it
 * is passed, because a scripted test is dictating the model's behaviour, not
 * observing it react to the page.
 *
 * Running off the end of `script` throws rather than returning some default
 * turn (a synthesized `stuck`, say). A loop test that exhausts its script
 * has a bug — it wrote too short a script, or the loop under test asked for
 * one more turn than expected — and that bug must surface as a loud failure
 * at the call site, not get reinterpreted as "the model gave up," which
 * would send the loop down its escalation path and let the test pass while
 * proving nothing about escalation at all.
 *
 * It throws `DriverFault` specifically, not a bare `Error`. The loop only
 * ever catches `MalformedModelOutput`, so this propagates by construction
 * rather than by the loop remembering to re-check the type of what it caught.
 */
export class ScriptedDriver implements ModelDriver {
  private readonly script: Array<{ name: string; input: unknown }>[];
  private cursor = 0;

  constructor(script: Array<{ name: string; input: unknown }>[]) {
    this.script = script;
  }

  async next(_observation: Observation, _history: DriverTurn[]): Promise<DriverTurn> {
    if (this.cursor >= this.script.length) {
      throw new DriverFault(
        `ScriptedDriver script exhausted: ${this.script.length} turn(s) scripted, but next() was called again`,
      );
    }
    const calls = this.script[this.cursor]!;
    this.cursor += 1;
    return { calls };
  }

  /**
   * Always zero. A scripted run never talks to a model, so there is no
   * token count to report — this is not a stub waiting to be wired up, it
   * is the actual, permanent answer for this driver.
   */
  usage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: 0, outputTokens: 0 };
  }
}
