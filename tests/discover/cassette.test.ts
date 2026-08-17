// tests/discover/cassette.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CassetteDriver, recordCassette } from "../../src/discover/cassette.js";
import { DriverFault, MalformedModelOutput, type DriverTurn, type ModelDriver } from "../../src/discover/driver.js";
import type { Observation } from "../../src/observe/snapshot.js";

/**
 * What a live `observe()` would report for the page `tests/cassettes/sample.json`
 * was hand-authored to describe. Handles are deliberately NOT "o1n2" (the
 * handle the sample's recorded response names) — they are strings no
 * `observe()` epoch would ever produce, chosen specifically to make the point
 * that CassetteDriver's match never looks at them.
 */
const obsStub: Observation = {
  url: "https://example.test/synthetic/login",
  title: "Synthetic Login — DCA Fixture",
  nodes: [
    { handle: "live-a", role: "textbox", name: "Sample Account Handle", value: null, editable: true },
    { handle: "live-b", role: "textbox", name: "Sample Passphrase", value: null, editable: true },
    { handle: "live-c", role: "button", name: "Enter Sample Vault", value: null, editable: false },
  ],
  screenshot: null,
};

const SAMPLE = "tests/cassettes/sample.json";

describe("CassetteDriver", () => {
  it("replays a recorded exchange without any network call", async () => {
    const d = new CassetteDriver(SAMPLE);
    const turn = await d.next(obsStub, []);
    expect(turn.calls[0]!.name).toBe("click");
  });

  it("refuses a cassette whose recorded observation does not match the live one", async () => {
    // A cassette replayed against a changed page is a test that passes while
    // proving nothing — the exact defect class Phase 1 shipped six times.
    const d = new CassetteDriver(SAMPLE);
    await expect(d.next({ ...obsStub, url: "http://elsewhere" }, [])).rejects.toThrow(/cassette/i);
  });

  it("contains no credential or session token", async () => {
    const raw = readFileSync(SAMPLE, "utf8");
    for (const bad of ["jsessionid", "demo", "john"]) {
      expect(raw.toLowerCase()).not.toContain(bad);
    }
  });

  // --- The rest: why each rejection fails, not just that it does. A
  // malformed-cassette error and a mismatch error both surface as "a
  // rejected promise" at a bare `.rejects.toThrow()` call site; the loop
  // (src/discover/loop.ts) only catches MalformedModelOutput and lets
  // everything else — DriverFault above all — propagate, so the type is
  // what actually matters, not the fact that something threw.

  it("reports a URL mismatch as a harness fault, not unusable model output", async () => {
    const d = new CassetteDriver(SAMPLE);
    const thrown: unknown = await d.next({ ...obsStub, url: "http://elsewhere" }, []).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(DriverFault);
    expect(thrown).not.toBeInstanceOf(MalformedModelOutput);
  });

  it("refuses a cassette whose page structure changed even though the URL is unchanged", async () => {
    // The brief's own mismatch test only varies url. That is the floor, not
    // the ceiling: a cassette recorded against a login form with two fields
    // must also refuse to replay against a page at the SAME url that only
    // has one — a redirect target, or a multi-tenant host serving different
    // markup at one path, would otherwise silently pass.
    const d = new CassetteDriver(SAMPLE);
    const shrunk: Observation = { ...obsStub, nodes: obsStub.nodes.slice(0, 1) };
    const thrown: unknown = await d.next(shrunk, []).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(DriverFault);
    expect(thrown).not.toBeInstanceOf(MalformedModelOutput);
    expect((thrown as Error).message).toMatch(/cassette/i);
  });

  it("replays even when the live form state differs from what was recorded", async () => {
    // Deliberately NOT checked: a node's current `value`. Live state (what a
    // field currently holds) is not page identity, and matching on it would
    // make a cassette stop replaying the moment anything on the page legally
    // changes turn to turn — the over-strict failure mode named in the brief.
    const d = new CassetteDriver(SAMPLE);
    const typedInto: Observation = {
      ...obsStub,
      nodes: obsStub.nodes.map((n, i) => (i === 0 ? { ...n, value: "whatever the model already typed" } : n)),
    };
    const turn = await d.next(typedInto, []);
    expect(turn.calls[0]!.name).toBe("click");
  });

  it("reports exhaustion as a harness fault, not unusable model output, and keeps refusing", async () => {
    const d = new CassetteDriver(SAMPLE);
    await d.next(obsStub, []); // consumes the sample's one recorded turn

    const first: unknown = await d.next(obsStub, []).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(DriverFault);
    expect(first).not.toBeInstanceOf(MalformedModelOutput);
    expect((first as Error).message).toMatch(/exhausted/i);

    // Not "consumed" by the first throw — every call past the end refuses.
    const second: unknown = await d.next(obsStub, []).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(DriverFault);
  });
});

describe("CassetteDriver — malformed cassette files", () => {
  const dir = "tests/.tmp-cassettes";
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a cassette that is missing entirely", () => {
    expect(() => new CassetteDriver(join(dir, "does-not-exist.json"))).toThrow(DriverFault);
  });

  it("refuses a cassette that is not valid JSON", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "not-json.json");
    writeFileSync(path, "{ this is not json", "utf8");

    let thrown: unknown;
    try {
      new CassetteDriver(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverFault);
    expect(thrown).not.toBeInstanceOf(MalformedModelOutput);
  });

  it("refuses valid JSON that does not match the cassette shape", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "wrong-shape.json");
    // Schema-valid JSON, wrong document: no `turns` at all.
    writeFileSync(path, JSON.stringify({ version: 1, hello: "world" }), "utf8");

    expect(() => new CassetteDriver(path)).toThrow(DriverFault);
  });

  it("refuses a cassette with zero recorded turns", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "empty.json");
    writeFileSync(path, JSON.stringify({ version: 1, turns: [] }), "utf8");

    expect(() => new CassetteDriver(path)).toThrow(DriverFault);
  });
});

/** A tiny in-memory ModelDriver standing in for a real one (e.g. Task 12's
 * AnthropicDriver), so `recordCassette` can be exercised without ever
 * touching the network. Its two turns are deliberately shaped to carry a
 * secret each, in two DIFFERENT ways, so the test below can tell apart the
 * two defences `recordCassette` applies:
 *  - turn 1's `fill` value is scrubbed STRUCTURALLY, regardless of shape;
 *  - turn 2's `navigate` url is caught by pattern-based `redactDeep`, the
 *    backstop for everything scrubCall does not touch.
 */
class FakeDriver implements ModelDriver {
  private cursor = 0;
  private readonly turns: DriverTurn[] = [
    { calls: [{ name: "fill", input: { handle: "x1", value: "123-45-6789" } }] },
    {
      calls: [
        { name: "navigate", input: { url: "https://example.test/x;jsessionid=SYNTHETICTESTTOKEN00000000000000" } },
      ],
    },
  ];
  private readonly cumulative = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 260, outputTokens: 34 },
  ];

  async next(_observation: Observation, _history: DriverTurn[]): Promise<DriverTurn> {
    const turn = this.turns[this.cursor]!;
    this.cursor += 1;
    return turn;
  }

  usage(): { inputTokens: number; outputTokens: number } {
    return this.cursor === 0 ? { inputTokens: 0, outputTokens: 0 } : this.cumulative[this.cursor - 1]!;
  }
}

describe("recordCassette", () => {
  const dir = "tests/.tmp-cassettes";
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes every exchange to disk, redacts secrets before they land, and the written file replays", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "recorded.json");
    const fake = new FakeDriver();
    const wrapped = recordCassette(path, fake);

    const rec1: Observation = {
      url: "https://example.test/synthetic/profile",
      title: "Synthetic Profile",
      nodes: [{ handle: "o1n0", role: "textbox", name: "Sample SSN Field", value: "", editable: true }],
      screenshot: null,
    };
    const rec2: Observation = {
      url: "https://example.test/synthetic/confirm",
      title: "Synthetic Confirm",
      nodes: [{ handle: "o2n0", role: "link", name: "Continue", value: null, editable: false }],
      screenshot: null,
    };

    // The wrapper is a tee: it must behave exactly like `fake`, unchanged.
    const turn1 = await wrapped.next(rec1, []);
    expect(turn1.calls[0]).toEqual({ name: "fill", input: { handle: "x1", value: "123-45-6789" } });
    const turn2 = await wrapped.next(rec2, [turn1]);
    expect(turn2.calls[0]!.name).toBe("navigate");
    expect(wrapped.usage()).toEqual({ inputTokens: 260, outputTokens: 34 });

    // Nothing sensitive reaches disk, in either of the two shapes it arrived in.
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("SYNTHETICTESTTOKEN00000000000000");
    expect(raw).toContain("<redacted");
    expect(raw).toContain(";jsessionid=<redacted>");

    // What was written replays — at zero cost, and against LIVE observations
    // whose handles and values differ from what was recorded, which is the
    // whole point of not keying the match on either.
    const replayer = new CassetteDriver(path);
    const replay1: Observation = {
      url: rec1.url,
      title: rec1.title,
      nodes: [{ handle: "z9", role: "textbox", name: "Sample SSN Field", value: "typed during replay", editable: true }],
      screenshot: null,
    };
    const played1 = await replayer.next(replay1, []);
    // The recorded value survives only as the scrubbed placeholder — the
    // real typed value was never written, so replay cannot reproduce it.
    expect(played1.calls[0]).toEqual({ name: "fill", input: { handle: "x1", value: "<redacted>" } });
    expect(replayer.usage()).toEqual({ inputTokens: 100, outputTokens: 10 });

    const replay2: Observation = {
      url: rec2.url,
      title: rec2.title,
      nodes: [{ handle: "z10", role: "link", name: "Continue", value: null, editable: false }],
      screenshot: null,
    };
    const played2 = await replayer.next(replay2, [played1]);
    expect(played2.calls[0]).toEqual({
      name: "navigate",
      input: { url: "https://example.test/x;jsessionid=<redacted>" },
    });
    expect(replayer.usage()).toEqual({ inputTokens: 260, outputTokens: 34 });
  });
});
