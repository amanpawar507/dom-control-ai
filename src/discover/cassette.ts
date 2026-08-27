// src/discover/cassette.ts
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Observation } from "../observe/snapshot.js";
import { redactDeep } from "../policy/redact.js";
import { DriverFault, type DriverTurn, type ModelDriver } from "./driver.js";

/**
 * The part of an `Observation` a cassette records for matching, and nothing
 * more. Two fields are deliberately absent, both for the same reason —
 * observe() renumbers and re-derives them every call, so neither one is a
 * property of "the page this cassette was recorded against":
 *
 *  - `handle` is epoch-qualified (`o7n3`, src/observe/snapshot.ts) and valid
 *    only for the observation that produced it. A cassette recorded in one
 *    process and replayed in another sees a DIFFERENT handle for the SAME
 *    element, because the epoch counter starts over. Keying a match on the
 *    raw handle would make every cassette refuse every replay, including a
 *    replay against the exact page it was recorded on — the opposite of
 *    useless, but useless all the same.
 *  - `value` is live form state, not page identity. Recording it would also
 *    put whatever the model typed — a password, an account number — directly
 *    into a file the credential test below exists to keep clean. It is
 *    dropped structurally rather than pattern-matched away: a field that was
 *    never captured cannot leak later no matter how a secret is shaped.
 *
 * `screenshot` is excluded for the same reason `digestOf` in loop.ts excludes
 * it: it is opt-in, so keying anything load-bearing on it would make that
 * behaviour silently depend on a cost flag.
 *
 * What is left — `url`, `title`, and each node's `role`/`name`/`editable` —
 * is the floor from the brief (a changed `url` must refuse) plus one more
 * check chosen deliberately: the *set and order* of addressable controls.
 * That catches a cassette replayed against a structurally different page even
 * when the URL coincidentally matches (a redirect target, a multi-tenant host
 * serving different markup at one path). It does NOT catch every possible
 * drift — a control's current text or its position in a still-conceptually-
 * identical list is not checked — because the goal is "does this recording
 * still describe the situation", not byte-for-byte identity, and a check that
 * strict would make a cassette stop replaying after the most trivial content
 * change on the page.
 */
interface Fingerprint {
  url: string;
  title: string;
  nodes: Array<{ role: string; name: string; editable: boolean }>;
}

function fingerprintOf(observation: Observation): Fingerprint {
  return {
    url: observation.url,
    title: observation.title,
    nodes: observation.nodes.map((n) => ({ role: n.role, name: n.name, editable: n.editable })),
  };
}

/**
 * Where the two fingerprints first diverge, in one human-readable sentence.
 * `JSON.stringify` inequality alone tells a reader THAT a cassette refused a
 * replay; this is what tells them WHY, which is the whole point of failing
 * loudly rather than merely failing.
 */
function describeMismatch(recorded: Fingerprint, live: Fingerprint): string {
  if (recorded.url !== live.url) return `url: recorded ${JSON.stringify(recorded.url)}, live ${JSON.stringify(live.url)}`;
  if (recorded.title !== live.title) {
    return `title: recorded ${JSON.stringify(recorded.title)}, live ${JSON.stringify(live.title)}`;
  }
  if (recorded.nodes.length !== live.nodes.length) {
    return `node count: recorded ${recorded.nodes.length}, live ${live.nodes.length}`;
  }
  for (let i = 0; i < recorded.nodes.length; i++) {
    const r = recorded.nodes[i]!;
    const l = live.nodes[i]!;
    if (r.role !== l.role || r.name !== l.name || r.editable !== l.editable) {
      return `node ${i}: recorded ${JSON.stringify(r)}, live ${JSON.stringify(l)}`;
    }
  }
  return "observation shape differs";
}

const FingerprintSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    nodes: z
      .array(
        z
          .object({
            role: z.string(),
            name: z.string(),
            editable: z.boolean(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const CassetteCallSchema = z
  .object({
    name: z.string(),
    input: z.unknown(),
  })
  .strict();

const CassetteTurnSchema = z
  .object({
    observation: FingerprintSchema,
    response: z.object({ calls: z.array(CassetteCallSchema) }).strict(),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      })
      .strict(),
  })
  .strict();

const CassetteFileSchema = z
  .object({
    version: z.literal(1),
    /**
     * Free-text provenance, checked by nothing at runtime. Its job is purely
     * documentary: `tests/cassettes/sample.json` uses it to say in the file
     * itself that the recording is hand-authored, the same way the synthetic
     * DOM fixtures (tests/fixtures/synthetic/*.html) carry a comment saying
     * so at the top of the markup. Optional because a real capture (Task 12)
     * has nothing true to put here beyond "recorded", which the filename
     * convention already says.
     */
    note: z.string().optional(),
    turns: z.array(CassetteTurnSchema).min(1),
  })
  .strict();

type CassetteTurn = z.infer<typeof CassetteTurnSchema>;
type CassetteFile = z.infer<typeof CassetteFileSchema>;

/**
 * Read and validate the file at `path`, or throw `DriverFault`.
 *
 * Every way this can go wrong — the file is missing, the JSON does not
 * parse, the JSON parses but does not match the cassette shape — is a
 * test-authoring problem: someone pointed a driver at the wrong path, or
 * hand-edited a fixture into an invalid shape. None of these say anything
 * about a page or a model, which is exactly the line `DriverFault`'s own
 * doc comment (src/discover/driver.ts) draws: "the cassette is malformed" is
 * named there as one of its own examples.
 */
function loadCassette(path: string): CassetteTurn[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (thrown) {
    throw new DriverFault(`cassette "${path}" could not be read: ${(thrown as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (thrown) {
    throw new DriverFault(`cassette "${path}" is not valid JSON: ${(thrown as Error).message}`);
  }

  const parsed = CassetteFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new DriverFault(`cassette "${path}" is malformed: ${parsed.error.message}`);
  }
  return parsed.data.turns;
}

/**
 * A `ModelDriver` that replays a recorded sequence of exchanges from disk
 * instead of calling a model — the zero-cost twin of `AnthropicDriver`
 * (Task 12). It exists to guard the request/response wire shape (what a real
 * exchange's `DriverTurn` and token counts actually look like) without
 * spending anything on every test run.
 *
 * Two refusal modes, and both are `DriverFault`, never `MalformedModelOutput`:
 *
 *  - running past the last recorded turn ("exhausted"), the cassette
 *    equivalent of `ScriptedDriver` running off the end of its script;
 *  - the live observation not matching what was recorded for this turn
 *    ("does not match the live one") — a cassette replayed against a page it
 *    was not recorded on.
 *
 * Both are harness/authoring faults, not the model producing bad output, and
 * the loop (src/discover/loop.ts) only ever catches `MalformedModelOutput`.
 * Throwing anything else here — including a bare `Error` — would let a
 * mismatched or exhausted cassette get caught by that narrow catch, silently
 * reinterpreted as "the model's turn was unusable", and reported as a clean
 * `model-output-unusable` escalation: a test passing while proving that its
 * own cassette ran out, which is the exact false-pass shape this project has
 * shipped nine times.
 */
export class CassetteDriver implements ModelDriver {
  private readonly turns: CassetteTurn[];
  private cursor = 0;

  constructor(private readonly path: string) {
    this.turns = loadCassette(path);
  }

  async next(observation: Observation, _history: DriverTurn[]): Promise<DriverTurn> {
    if (this.cursor >= this.turns.length) {
      throw new DriverFault(
        `cassette "${this.path}" exhausted: ${this.turns.length} turn(s) recorded, but next() was called again`,
      );
    }

    const turn = this.turns[this.cursor]!;
    const live = fingerprintOf(observation);
    if (JSON.stringify(turn.observation) !== JSON.stringify(live)) {
      throw new DriverFault(
        `cassette "${this.path}" turn ${this.cursor}: recorded observation does not match the live one (${describeMismatch(turn.observation, live)})`,
      );
    }

    this.cursor += 1;
    return { calls: turn.response.calls };
  }

  /**
   * Not the fixed zero `ScriptedDriver` reports. A cassette's turns were
   * real spend at recording time, and `usage()` here returns the cumulative
   * totals as they were recorded — 0 before any turn is consumed, then each
   * turn's recorded cumulative figure as it is played. That lets a test
   * assert realistic budget-charging behaviour (src/discover/loop.ts charges
   * the delta since the previous reading) against numbers a real exchange
   * actually produced, at zero cost, rather than against a driver that can
   * only ever report zero.
   */
  usage(): { inputTokens: number; outputTokens: number } {
    const last = this.turns[this.cursor - 1];
    return last === undefined ? { inputTokens: 0, outputTokens: 0 } : last.usage;
  }
}

/**
 * Structural placeholder for a `fill`/`select` call's typed value, applied
 * before anything is ever written to disk.
 *
 * This mirrors `ArtifactRecorder.parameter()` in loop.ts, and for the same
 * reason stated there: the loop cannot tell a password field from a search
 * box (`observe()` reports role `textbox` for both), so "record the value
 * unless it looks sensitive" is a guess made at the one boundary where a
 * wrong guess writes a credential to disk. A cassette faces the identical
 * problem one layer lower — it is recording the model's raw tool call, not
 * the loop's already-parameterized flow step — so the rule is re-applied
 * here rather than assumed inherited from the loop. Pattern-based redaction
 * (`redactDeep`, applied to the whole record below) only catches secrets
 * that are shaped like something already known — a session token, an SSN. An
 * arbitrary typed password is not shaped like anything; the only reliable
 * defence is to never write the field at all.
 */
function scrubCall(call: { name: string; input: unknown }): { name: string; input: unknown } {
  if (
    (call.name === "fill" || call.name === "select") &&
    call.input !== null &&
    typeof call.input === "object" &&
    "value" in call.input
  ) {
    return { name: call.name, input: { ...call.input, value: "<redacted>" } };
  }
  return call;
}

/**
 * Wraps a real `ModelDriver` (Task 12's `AnthropicDriver`, in production) so
 * that every exchange passing through it is also written to `path` as a
 * cassette `CassetteDriver` can later replay. The wrapped driver's own
 * behaviour — what it returns, what it throws — passes through unchanged;
 * this is a tee, not a substitute.
 *
 * Two redaction passes run before anything reaches disk, sink-side, the same
 * place `RunLogger` applies `redactDeep` (src/evidence/logger.ts) and for the
 * same stated reason there: "what counts as a secret ... is a policy
 * question, and the sink's job is to apply that answer to every write
 * without exception."
 *
 *  1. `scrubCall` structurally drops any `fill`/`select` value — see its own
 *     comment for why pattern-matching alone cannot be trusted for that
 *     field.
 *  2. `redactDeep` catches everything else shaped like a known secret
 *     wherever it appears in the record: a session token in a `navigate`
 *     url, an SSN in an `extract`ed label the model echoed back, and so on.
 *
 * The file is rewritten after every turn, not only once at the end, so a run
 * that crashes or is budget-refused mid-flight still leaves the turns
 * recorded so far on disk rather than losing the whole exchange.
 */
export function recordCassette(path: string, inner: ModelDriver): ModelDriver {
  return new RecordingDriver(path, inner);
}

class RecordingDriver implements ModelDriver {
  private readonly turns: CassetteTurn[] = [];

  constructor(
    private readonly path: string,
    private readonly inner: ModelDriver,
  ) {}

  async next(observation: Observation, history: DriverTurn[]): Promise<DriverTurn> {
    const turn = await this.inner.next(observation, history);
    // Cumulative, per the `ModelDriver.usage()` contract — read immediately
    // after `next()` resolves, exactly where the loop itself reads it.
    const usage = this.inner.usage();

    const recorded: CassetteTurn = {
      observation: fingerprintOf(observation),
      response: { calls: turn.calls.map(scrubCall) },
      usage,
    };
    this.turns.push(redactDeep(recorded) as CassetteTurn);
    this.flush();

    return turn;
  }

  usage(): { inputTokens: number; outputTokens: number } {
    return this.inner.usage();
  }

  private flush(): void {
    const file: CassetteFile = { version: 1, turns: this.turns };
    writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}
