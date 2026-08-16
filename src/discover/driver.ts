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
 */
export class ScriptedDriver implements ModelDriver {
  private readonly script: Array<{ name: string; input: unknown }>[];
  private cursor = 0;

  constructor(script: Array<{ name: string; input: unknown }>[]) {
    this.script = script;
  }

  async next(_observation: Observation, _history: DriverTurn[]): Promise<DriverTurn> {
    if (this.cursor >= this.script.length) {
      throw new Error(
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
