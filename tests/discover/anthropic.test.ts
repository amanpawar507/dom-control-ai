// Offline by construction. Nothing here reads `ANTHROPIC_API_KEY`, constructs
// a network client against a real key, or sends a byte: every test either
// exercises a pure function (`buildRequest`, `toolCallsFrom`, `usageFrom`) or
// drives `AnthropicDriver` through a subclass that replaces the one method
// that talks to the API. The single live exchange this driver exists for is a
// script (`scripts/discover.mts`), not a test — spending money in `npm test`
// would make the suite cost money to run and would make its result depend on
// a third party being up.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { CassetteDriver } from "../../src/discover/cassette.js";
import {
  AnthropicDriver,
  DISCOVERY_MODEL,
  buildRequest,
  toolCallsFrom,
  usageFrom,
  type DiscoveryRequest,
} from "../../src/discover/anthropic.js";
import { Budget, BudgetExceeded } from "../../src/discover/budget.js";
import { DriverFault, MalformedModelOutput } from "../../src/discover/driver.js";
import type { Observation } from "../../src/observe/snapshot.js";

const obsWithNodes: Observation = {
  url: "http://localhost:8081/parabank/overview.htm",
  title: "ParaBank | Accounts Overview",
  nodes: [
    { handle: "o1n0", role: "link", name: "Accounts Overview", value: null, editable: false },
    { handle: "o1n1", role: "combobox", name: "All Credit Debit", value: "All", editable: true },
    { handle: "o1n2", role: "button", name: "Go", value: null, editable: false },
  ],
  screenshot: null,
};

const ALLOWLIST = ["http://localhost:8081/parabank/**"];

/** A response as the API returns one, with only the fields this code reads. */
function message(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DISCOVERY_MODEL,
    content: [],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...over,
  } as Anthropic.Message;
}

function toolUse(name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id: `toolu_${name}`, name, input } as Anthropic.ContentBlock;
}

/**
 * The real driver with its one network call replaced. Everything the driver
 * actually owns — request shaping, response parsing, cumulative usage, budget
 * charging — runs unmodified; only the transport is scripted, which is what
 * makes those behaviours testable without spending anything.
 */
class OfflineDriver extends AnthropicDriver {
  readonly sent: DiscoveryRequest[] = [];

  constructor(
    budget: Budget,
    private readonly replies: Anthropic.Message[],
  ) {
    super({ apiKey: "sk-not-a-real-key", model: DISCOVERY_MODEL, budget, goal: "g", allowlist: ALLOWLIST });
  }

  protected override async send(request: DiscoveryRequest): Promise<Anthropic.Message> {
    this.sent.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("OfflineDriver ran out of scripted replies");
    return reply;
  }
}

describe("buildRequest — what the model is given", () => {
  it("sends handles and never a selector in the system prompt or tools", () => {
    const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: ALLOWLIST });
    const blob = JSON.stringify(req);
    expect(blob).not.toMatch(/#[a-zA-Z]/);
    expect(blob).toContain("n0");
  });

  /**
   * The brief's `/#[a-zA-Z]/` above only rules out one selector *syntax*. A
   * request could satisfy it and still hand the model a class list, an
   * attribute selector or an XPath — so the shapes are ruled out by name here,
   * and every handle is checked to be present, which is the positive half of
   * the same claim: handles are the only address the model gets.
   */
  it("gives the model every handle and nothing else it could paste into a locator", () => {
    const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: ALLOWLIST });
    const blob = JSON.stringify(req);
    for (const node of obsWithNodes.nodes) expect(blob).toContain(node.handle);
    for (const shape of ["data-dca-obs", "querySelector", "xpath", "//div", "css=", "[name=", "getElementById"]) {
      expect(blob.toLowerCase(), `request offers the model a ${shape}`).not.toContain(shape.toLowerCase());
    }
  });

  it("declares the risk classes and the instruction to call stuck rather than guess", () => {
    const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] });
    expect(req.system).toMatch(/stuck/i);
    expect(req.system).toMatch(/irreversible/i);
    expect(req.system).toMatch(/guarded/i);
    expect(req.system).toMatch(/safe/i);
  });

  it("uses claude-sonnet-5, not an Opus model", () => {
    expect(buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] }).model).toBe("claude-sonnet-5");
    expect(JSON.stringify(buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] }))).not.toMatch(/opus/i);
  });

  it("carries the goal and the allowlist actually in force", () => {
    const req = buildRequest({
      goal: "narrow the transaction list to debits only",
      observation: obsWithNodes,
      allowlist: ["http://localhost:8081/parabank/**", "http://localhost:8081/parabank/services/**"],
    });
    expect(req.system).toContain("narrow the transaction list to debits only");
    expect(req.system).toContain("http://localhost:8081/parabank/**");
    expect(req.system).toContain("http://localhost:8081/parabank/services/**");
  });

  it("offers the whole tool vocabulary, stuck and done included", () => {
    const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] });
    expect(req.tools.map((t) => t.name).sort()).toEqual(
      ["click", "done", "extract", "fill", "navigate", "observe", "select", "stuck"],
    );
  });

  /**
   * Spec §6: "the observation is refreshed each turn rather than accumulated".
   * The stricter half of that here is about *handles*: they are epoch-qualified
   * and every `observe()` renumbers them, so a handle from an earlier turn
   * resolves to nothing. Echoing one back in the step log would be an
   * invitation to address an element that no longer exists — the loop would
   * halt with `model-output-unusable` and the run would be wasted. So the log
   * says what was done, never what it was done to.
   */
  it("does not offer back a handle from an earlier turn, only the current snapshot's", () => {
    const req = buildRequest({
      goal: "g",
      observation: obsWithNodes,
      allowlist: [],
      history: [
        { calls: [{ name: "click", input: { handle: "o9n7" } }] },
        { calls: [{ name: "select", input: { handle: "o9n8", value: "Debit" } }] },
      ],
    });
    const blob = JSON.stringify(req);
    expect(blob, "a handle from an expired observation was offered back to the model").not.toContain("o9n7");
    expect(blob).not.toContain("o9n8");
    // The actions themselves are still reported — the log is not empty, it is
    // handle-free.
    expect(req.messages[0]?.content).toMatch(/click/);
    expect(req.messages[0]?.content).toMatch(/select/);
    expect(blob).toContain("o1n0");
  });

  /**
   * Not a style preference. Every handle in a turn belongs to the snapshot
   * that turn answered, and the first action can invalidate the rest — a click
   * that navigates takes the page, and every other handle with it. A turn
   * carrying two calls would be paid for and then rejected on the second one.
   */
  it("forces exactly one tool call per turn, because the second one would address a page that is gone", () => {
    const req = buildRequest({ goal: "g", observation: obsWithNodes, allowlist: [] });
    expect(req.tool_choice.type).toBe("any");
    expect(req.tool_choice.disable_parallel_tool_use).toBe(true);
  });

  it("says so in words when a page offers nothing addressable", () => {
    const req = buildRequest({
      goal: "g",
      observation: { ...obsWithNodes, nodes: [] },
      allowlist: [],
    });
    expect(req.messages[0]?.content).toMatch(/no addressable controls/i);
  });

  it("is accepted by the SDK's own request type", () => {
    // Compile-time, not runtime: if `DiscoveryRequest` ever drifts out of shape
    // this assignment stops type-checking, which is the only check that
    // actually matters for a request nobody sends in this file.
    const req: Anthropic.MessageCreateParamsNonStreaming = buildRequest({
      goal: "g",
      observation: obsWithNodes,
      allowlist: [],
    });
    expect(req.max_tokens).toBeGreaterThan(0);
  });
});

describe("toolCallsFrom — reading the model's turn", () => {
  it("takes the tool calls in order and ignores prose and thinking around them", () => {
    const calls = toolCallsFrom(
      message({
        content: [
          { type: "thinking", thinking: "", signature: "" } as unknown as Anthropic.ContentBlock,
          { type: "text", text: "I will open the account." } as Anthropic.ContentBlock,
          toolUse("click", { handle: "o1n0" }),
          toolUse("extract", { handle: "o1n1", as: "balance" }),
        ],
      }),
    );
    expect(calls).toEqual([
      { name: "click", input: { handle: "o1n0" } },
      { name: "extract", input: { handle: "o1n1", as: "balance" } },
    ]);
  });

  it("rejects a turn that answered in prose, saying that no tool was called", () => {
    let thrown: unknown;
    try {
      toolCallsFrom(message({ stop_reason: "end_turn", content: [{ type: "text", text: "I am not sure." } as Anthropic.ContentBlock] }));
    } catch (error) {
      thrown = error;
    }
    // Both the assertions below matter. The type decides what the loop does
    // with it (escalate, not crash); the message decides whether an operator
    // can tell this apart from the two other rejections in this block, which a
    // bare `toThrow()` cannot.
    expect(thrown).toBeInstanceOf(MalformedModelOutput);
    expect((thrown as Error).message).toMatch(/no tool call/i);
  });

  it("rejects a refusal as unusable output rather than treating it as a dead end the model reported", () => {
    let thrown: unknown;
    try {
      toolCallsFrom(message({ stop_reason: "refusal", content: [] }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MalformedModelOutput);
    expect((thrown as Error).message).toMatch(/refus/i);
    // Not the same thing as the model calling `stuck`: that is a considered
    // report about the page, this is the request never having been answered.
    expect((thrown as Error).message).not.toMatch(/no tool call/i);
  });

  it("rejects a turn cut off at max_tokens even though it carries a tool call", () => {
    let thrown: unknown;
    try {
      toolCallsFrom(
        message({ stop_reason: "max_tokens", content: [toolUse("click", { handle: "o1n0" })] }),
      );
    } catch (error) {
      thrown = error;
    }
    // The tool call is there, so a "did it produce calls" check would pass this
    // turn straight through — and its `input` is whatever survived the cut.
    expect(thrown).toBeInstanceOf(MalformedModelOutput);
    expect((thrown as Error).message).toMatch(/max_tokens|truncat/i);
  });
});

describe("usageFrom — what a turn is charged for", () => {
  it("counts cached input tokens as input, because they were still paid for", () => {
    expect(
      usageFrom(
        message({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 7,
          } as Anthropic.Usage,
        }),
      ),
    ).toEqual({ inputTokens: 137, outputTokens: 20 });
  });

  it("reads an absent cache breakdown as zero rather than as NaN", () => {
    expect(usageFrom(message({ usage: { input_tokens: 5, output_tokens: 6 } as Anthropic.Usage }))).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    });
  });
});

/**
 * The one live exchange this project paid for, replayed for free.
 *
 * `tests/cassettes/parabank-account-activity.json` is a real recording — the
 * turns Claude Sonnet 5 actually produced against the running ParaBank
 * container, captured by `recordCassette` as they happened. These tests are
 * what turn that single expenditure into a permanent asset: the wire shape of
 * a real exchange, and the redaction applied to it, are now checked on every
 * `npm test` without spending anything or reaching the network.
 */
describe("the recorded exchange", () => {
  const CASSETTE = "tests/cassettes/parabank-account-activity.json";

  /** An observation that fingerprints identically to a recorded turn's. */
  function observationFor(turn: { url: string; title: string; nodes: Array<{ role: string; name: string; editable: boolean }> }): Observation {
    return {
      url: turn.url,
      title: turn.title,
      // Handles and values are deliberately not part of a cassette's match key
      // (src/discover/cassette.ts), so anything goes here — which is the point:
      // a replay in a fresh process sees different handles for the same page.
      nodes: turn.nodes.map((node, index) => ({ ...node, handle: `replay${index}`, value: null })),
      screenshot: null,
    };
  }

  const recorded = JSON.parse(readFileSync(CASSETTE, "utf8")) as {
    version: number;
    turns: Array<{
      observation: { url: string; title: string; nodes: Array<{ role: string; name: string; editable: boolean }> };
      response: { calls: Array<{ name: string; input: unknown }> };
      usage: { inputTokens: number; outputTokens: number };
    }>;
  };

  it("replays every turn of the run it recorded, against the pages it recorded them on", async () => {
    const driver = new CassetteDriver(CASSETTE);
    for (const turn of recorded.turns) {
      const played = await driver.next(observationFor(turn.observation), []);
      expect(played.calls).toEqual(turn.response.calls);
      expect(driver.usage()).toEqual(turn.usage);
    }
    // Cumulative and real: these are the tokens the API reported, not a
    // placeholder. A recording that had lost them would let a loop test assert
    // budget behaviour against numbers no exchange ever produced.
    expect(driver.usage().inputTokens).toBeGreaterThan(0);
    expect(driver.usage().outputTokens).toBeGreaterThan(0);
  });

  it("ends by claiming the goal, with a checkpoint, and never touched an irreversible control", () => {
    const calls = recorded.turns.flatMap((turn) => turn.response.calls);
    expect(calls.at(-1)?.name).toBe("done");
    expect((calls.at(-1)?.input as { checkpoint?: string }).checkpoint).toBeTruthy();
    // The run had `Clean`, `Shutdown` and `Admin Page` one click away on every
    // page it visited. Asserting against the recording is how "it never went
    // there" stays true rather than being remembered.
    expect(calls.map((c) => c.name)).not.toContain("navigate");
    expect(JSON.stringify(recorded).toLowerCase()).not.toContain("admin.htm");
  });

  it("carries no typed value, no session token and no credential anywhere in the file", () => {
    const raw = readFileSync(CASSETTE, "utf8");
    // `select` happened in this run, so this is a live check on a real
    // recording rather than a hypothetical: the value the model chose was
    // dropped structurally before the file was written.
    for (const call of recorded.turns.flatMap((t) => t.response.calls)) {
      if (call.name === "fill" || call.name === "select") {
        expect((call.input as { value?: unknown }).value).toBe("<redacted>");
      }
    }
    expect(raw).not.toMatch(/;jsessionid=(?!<redacted>)/i);
    expect(raw).not.toMatch(/JSESSIONID/i);
    expect(raw).not.toMatch(/sk-ant/);
    expect(raw.toLowerCase()).not.toContain("password");
  });
});

describe("AnthropicDriver — accounting and refusal", () => {
  const reply = (inputTokens: number, outputTokens: number) =>
    message({
      content: [toolUse("click", { handle: "o1n0" })],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens } as Anthropic.Usage,
    });

  it("charges the budget from the response's usage before handing the turn back", async () => {
    const budget = new Budget(1, { inPerM: 2, outPerM: 10 });
    const driver = new OfflineDriver(budget, [reply(1_000, 500)]);

    const turn = await driver.next(obsWithNodes, []);

    expect(turn.calls).toEqual([{ name: "click", input: { handle: "o1n0" } }]);
    // 1000 input at $2/1M plus 500 output at $10/1M.
    expect(budget.spentUsd()).toBeCloseTo(0.007, 10);
  });

  it("reports usage cumulatively over its life, which is what the loop's delta charging assumes", async () => {
    const driver = new OfflineDriver(new Budget(1, { inPerM: 2, outPerM: 10 }), [
      reply(1_000, 100),
      reply(2_000, 200),
    ]);

    expect(driver.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    await driver.next(obsWithNodes, []);
    expect(driver.usage()).toEqual({ inputTokens: 1_000, outputTokens: 100 });
    await driver.next(obsWithNodes, []);
    // Cumulative, not per turn. A driver that reported 2000/200 here would be
    // undercharged on every turn after the first, and undercharging is the
    // direction that spends real money.
    expect(driver.usage()).toEqual({ inputTokens: 3_000, outputTokens: 300 });
  });

  it("refuses to hand back a turn that crossed the ceiling, and still admits the tokens were spent", async () => {
    const budget = new Budget(0.001, { inPerM: 2, outPerM: 10 });
    const driver = new OfflineDriver(budget, [reply(1_000, 500)]);

    let thrown: unknown;
    try {
      await driver.next(obsWithNodes, []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BudgetExceeded);
    expect((thrown as Error).message).toMatch(/budget exceeded/i);
    // The refusal stops the next call; it cannot un-spend this one. `usage()`
    // must therefore still report the tokens, or the run would under-report
    // real money at exactly the moment it went over.
    expect(driver.usage()).toEqual({ inputTokens: 1_000, outputTokens: 500 });
    expect(budget.spentUsd()).toBe(0);
  });

  it("gives each turn the goal and the current page, never a stack of past pages", async () => {
    const driver = new OfflineDriver(new Budget(1, { inPerM: 2, outPerM: 10 }), [reply(1, 1), reply(1, 1)]);
    await driver.next(obsWithNodes, []);
    await driver.next({ ...obsWithNodes, url: "http://localhost:8081/parabank/activity.htm" }, [
      { calls: [{ name: "click", input: { handle: "o1n0" } }] },
    ]);

    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]?.messages).toHaveLength(1);
    expect(driver.sent[1]?.messages[0]?.content).toContain("activity.htm");
    expect(driver.sent[1]?.messages[0]?.content).not.toContain("overview.htm");
  });

  it("treats a missing API key as a harness fault, not as something to work around", () => {
    let thrown: unknown;
    try {
      new AnthropicDriver({
        apiKey: "",
        model: DISCOVERY_MODEL,
        budget: new Budget(1, { inPerM: 2, outPerM: 10 }),
        goal: "g",
        allowlist: [],
      });
    } catch (error) {
      thrown = error;
    }
    // `DriverFault`, specifically: the loop rethrows it. Were this
    // `MalformedModelOutput`, a run started with no key would be reported as
    // the model producing unusable output — a clean escalation for a
    // misconfiguration nobody would then look for.
    expect(thrown).toBeInstanceOf(DriverFault);
    expect((thrown as Error).message).toMatch(/api key/i);
  });
});
