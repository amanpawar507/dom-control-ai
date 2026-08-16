// Shared test doubles. Not a *.test.ts file, so vitest collects nothing here.
import type { LogEvent, RunLogger } from "../../src/evidence/logger.js";
import { DriverFault, ScriptedDriver, type DriverTurn, type ModelDriver } from "../../src/discover/driver.js";
import type { Observation } from "../../src/observe/snapshot.js";

/** Records what was logged without writing anything to disk. */
export class StubLogger {
  readonly events: LogEvent[] = [];

  log(event: LogEvent): void {
    this.events.push(event);
  }

  path(): string {
    return "<stub>";
  }

  get kinds(): string[] {
    return this.events.map((e) => e.kind);
  }

  asLogger(): RunLogger {
    return this as unknown as RunLogger;
  }
}

export type ScriptedCall = { name: string; input: unknown };

/**
 * `ScriptedDriver`, wrapped, with exactly one addition: a string input written
 * as `@<accessible name>` is replaced with the handle of the node that goes by
 * that name in the observation the turn is answering.
 *
 * A hand-written script cannot name a handle literally, and that is by design
 * rather than by accident: handles are epoch-qualified (`o7n3`) and every
 * `observe()` renumbers them, which is the mechanism that makes a stale handle
 * fail loudly. So the script says what a model would be looking at — "the
 * control called Accounts Overview" — and the harness does the same lookup a
 * model would do, against the same observation the model is handed. Nothing
 * selector-shaped is ever put in the loop's hands; it still receives an opaque
 * handle and nothing else.
 *
 * Two properties are kept deliberately:
 *
 *  - The lookup is exactly-one-or-fail, like every other targeting decision in
 *    this codebase. A name matching two nodes is a broken script, not a coin
 *    toss.
 *  - Exhaustion still comes from `ScriptedDriver` itself and is still a
 *    `DriverFault`. This wrapper adds no fallback turn, so a loop that asks
 *    for one turn more than the script holds still fails loudly instead of
 *    being handed a synthetic `stuck`.
 */
export class HandleScript implements ModelDriver {
  private readonly inner: ScriptedDriver;
  /** What the loop handed this driver, turn by turn. */
  readonly seen: Array<{ observation: Observation; history: DriverTurn[] }> = [];

  constructor(
    script: ScriptedCall[][],
    private readonly totals: { inputTokens: number; outputTokens: number } = {
      inputTokens: 0,
      outputTokens: 0,
    },
  ) {
    this.inner = new ScriptedDriver(script);
  }

  async next(observation: Observation, history: DriverTurn[]): Promise<DriverTurn> {
    const turn = await this.inner.next(observation, history);
    this.seen.push({ observation, history: [...history] });
    return {
      calls: turn.calls.map((c) => ({ name: c.name, input: substitute(c.input, observation) })),
    };
  }

  usage(): { inputTokens: number; outputTokens: number } {
    return this.totals;
  }
}

function substitute(input: unknown, observation: Observation): unknown {
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "string" && value.startsWith("@")
        ? handleFor(observation, value.slice(1))
        : value,
    ]),
  );
}

function handleFor(observation: Observation, name: string): string {
  const matches = observation.nodes.filter((n) => n.name === name);
  if (matches.length !== 1) {
    throw new DriverFault(
      `script names "${name}", which matches ${matches.length} node(s) in this observation (expected exactly 1)`,
    );
  }
  return matches[0]!.handle;
}
