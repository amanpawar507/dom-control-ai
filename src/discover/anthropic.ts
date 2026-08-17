// src/discover/anthropic.ts
//
// The only file in this project that spends money. Everything else in
// `src/discover` runs against `ScriptedDriver` or `CassetteDriver` and costs
// nothing; this is the one implementation of `ModelDriver` that puts a real
// model behind `next()`.
import Anthropic from "@anthropic-ai/sdk";
import type { Budget } from "./budget.js";
import { DriverFault, MalformedModelOutput, type DriverTurn, type ModelDriver } from "./driver.js";
import type { Observation } from "../observe/snapshot.js";
import { TOOL_SCHEMAS } from "./tools.js";

/**
 * Pinned, not configurable-by-accident. Spec §3 chose Sonnet 5 for discovery
 * and the phase plan says so twice more ("Do not use Opus"); with $5 funding
 * the whole phase, an Opus id reaching this constant by a typo at a call site
 * is a 2.5x input / 2.5x output mistake nobody would notice until the bill.
 * `AnthropicDriver` still takes a `model` in its options — the spec calls the
 * model id config, not code — but every default in this file and in
 * `scripts/discover.mts` comes from here.
 */
export const DISCOVERY_MODEL = "claude-sonnet-5";

/**
 * Per turn, covering thinking *and* the tool call, since `max_tokens` caps
 * their sum. A tool call is a few dozen tokens; the headroom is entirely for
 * adaptive thinking. Set too low, a turn is cut off mid-thought and
 * `toolCallsFrom` rejects it — a wasted, paid-for turn. It is a ceiling, not
 * a target: nothing is charged for headroom that goes unused.
 */
const MAX_TOKENS = 4096;

/**
 * `medium` rather than the API default of `high`. Sonnet 5 respects effort
 * strictly at the low end and scopes its work to what was asked, which is
 * what this loop wants — the task is a short, well-specified UI flow, not
 * open-ended reasoning — and effort is the main lever on what a turn costs.
 */
const EFFORT = "medium" as const;

export interface RequestInput {
  goal: string;
  observation: Observation;
  /** The allowlist actually in force, as written in the policy config. */
  allowlist: readonly string[];
  /** The model's own prior turns, in order. See `renderHistory` for what survives into the prompt. */
  history?: readonly DriverTurn[];
  model?: string;
}

/**
 * The request, in a shape that is both directly usable as the SDK's
 * `messages.create` parameter and directly assertable in an offline test —
 * `system` is a plain string here rather than the SDK's
 * `string | TextBlockParam[]` union, so a test can match against it without
 * narrowing first. `tests/discover/anthropic.test.ts` pins the assignability
 * to `Anthropic.MessageCreateParamsNonStreaming` at compile time, so the two
 * cannot drift apart silently.
 */
export interface DiscoveryRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  tools: Anthropic.Tool[];
  tool_choice: Anthropic.ToolChoiceAny;
  thinking: Anthropic.ThinkingConfigAdaptive;
  output_config: Anthropic.OutputConfig;
}

/**
 * Shaped for the wire from the same `TOOL_SCHEMAS` that `parseToolCall`
 * validates against (src/discover/tools.ts), so the vocabulary the model is
 * offered and the vocabulary the loop accepts come from one definition. The
 * cast is over `input_schema` only: Zod's emitted JSON Schema is typed as an
 * open record, and `Anthropic.Tool.InputSchema` requires a literal
 * `type: "object"` that the record type cannot prove it carries. Every schema
 * in `TOOL_DEFS` is a `z.object`, so it does.
 */
const TOOLS: Anthropic.Tool[] = TOOL_SCHEMAS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
}));

/**
 * The system prompt, carrying exactly what spec §6 requires it to carry: the
 * goal, the allowlist in force, the risk classes and what happens at each,
 * and the instruction to call `stuck` rather than guess.
 *
 * Two things are stated here that the tool schemas cannot state. First, that
 * a handle is valid only for the snapshot it came from — the mechanism is
 * enforced in `observe()` (handles are epoch-qualified and renumbered every
 * turn) and a model that does not know it will reach for a dead handle and
 * waste a turn. Second, that this run is being *recorded*: the model is not
 * merely operating an application, it is writing a capability that replays
 * later with nothing in the loop, which is why a guess is worse than a stop.
 *
 * No selector syntax appears anywhere in this text, deliberately. The model
 * is never shown one and never asked for one; the tools do not accept one.
 */
function systemPrompt(goal: string, allowlist: readonly string[]): string {
  const allowed =
    allowlist.length === 0
      ? "  (none — no navigation is permitted on this run)"
      : allowlist.map((entry) => `  ${entry}`).join("\n");

  return `You are operating a real web application through a small, typed set of tools in order to accomplish one goal.

This run is being recorded. Every control you touch is turned into a durable, replayable capability that will later be executed with no model involved, so a wrong action does not just fail — it is written down as part of the recording. That is why the rules below are rules rather than preferences.

THE GOAL
${goal}

HOW YOU SEE THE PAGE
Each turn you are given a fresh snapshot of the controls on the current page. Every control carries an opaque handle, and that handle is the only address you have. Handles are renumbered on every snapshot: one from an earlier turn addresses nothing, so only ever use handles from the snapshot in front of you. You are never given, and cannot send, a selector, a query, an element id, a class name or a tag name — no tool accepts one. A control that is not in the snapshot is not addressable; if you need one that is not there, say so with the stuck tool rather than inventing an address.

WHERE YOU MAY GO
Navigation is confined to:
${allowed}
Anything outside that is refused and the run ends.

RISK CLASSES
Every action you ask for is classified before it is carried out, never after:
  safe — carried out.
  guarded — carried out only if this capability has already been approved by a human. Otherwise it is refused and the run ends.
  irreversible — never carried out automatically. It is escalated to a human and the run ends. Controls that destroy, reset or shut down data are in this class. Do not go near them.
A refusal is a decision, not an obstacle. Never look for another route to something that was refused.

FINISHING
Call done only when the goal has actually been met, naming as the checkpoint the handle of a control whose presence on the page proves it. The checkpoint is verified against the live page and must match exactly one visible control, so name one that is distinctive rather than one that appears several times over. Never claim done for work you did not do.
Call stuck, with a reason, as soon as the next step is not evident from the snapshot in front of you. Stopping with a reason is useful; guessing is not.

WORKING RHYTHM
Prefer one action per turn. After anything that may have changed the page, take the next snapshot before addressing anything on it — the page you are looking at may no longer be the page you acted on.`;
}

/**
 * The step log the model gets back, deliberately without handles.
 *
 * A handle from turn 3 is dead by turn 4 (see `observe()`), so echoing one
 * back is an invitation to address an element that no longer exists — the
 * loop halts with `model-output-unusable` and the whole paid-for run is
 * spent. What survives is what the model did and any argument that is not an
 * address, which is enough to know where it is in the flow while making the
 * stale-handle mistake unavailable rather than merely discouraged.
 */
function renderHistory(history: readonly DriverTurn[]): string {
  if (history.length === 0) return "";
  const lines: string[] = [];
  let step = 0;
  for (const turn of history) {
    for (const call of turn.calls) {
      step += 1;
      lines.push(`  ${step}. ${call.name}${renderArgs(call.input)}`);
    }
  }
  return `\nWhat you have done so far (handles from those turns have since expired):\n${lines.join("\n")}\n`;
}

/** Every argument except the address. `handle` and `checkpoint` are dropped. */
function renderArgs(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const parts = Object.entries(input)
    .filter(([key]) => key !== "handle" && key !== "checkpoint")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function renderObservation(observation: Observation): string {
  if (observation.nodes.length === 0) {
    return "This page has no addressable controls.";
  }
  const rows = observation.nodes.map((node) => {
    const value = node.value === null ? "" : ` | value ${JSON.stringify(node.value)}`;
    const editable = node.editable ? " | editable" : "";
    return `  ${node.handle} | ${node.role} | ${node.name}${editable}${value}`;
  });
  return `Controls on this page (handle | role | name):\n${rows.join("\n")}`;
}

/**
 * One turn's request: the system prompt, plus a single user message holding
 * the current page and nothing else.
 *
 * Pure, and exported for that reason — the entire request can be inspected in
 * a test with no client, no key and no network, which is what makes the "the
 * model never sees a selector" claim checkable for free on every `npm test`
 * rather than once, expensively, against the live API.
 *
 * The message array is rebuilt from scratch every turn rather than appended
 * to. Spec §6: "the observation is refreshed each turn rather than
 * accumulated, so context stays bounded on long flows" — with a thread, turn
 * 40 would carry all 39 previous page snapshots and cost accordingly.
 */
export function buildRequest(input: RequestInput): DiscoveryRequest {
  const history = input.history ?? [];
  const content = `Snapshot ${history.length + 1}.
Page title: ${input.observation.title}
Page address: ${input.observation.url}

${renderObservation(input.observation)}
${renderHistory(history)}
Decide the next action and call exactly one tool.`;

  return {
    model: input.model ?? DISCOVERY_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt(input.goal, input.allowlist),
    messages: [{ role: "user", content }],
    tools: TOOLS,
    // Forced, so "the model wrote prose instead of acting" is not a failure
    // mode a paid turn can end in. Every honest answer is a tool call —
    // including `stuck`, which is how the model says it cannot proceed.
    //
    // One at a time, which is not a style preference. Every handle in a turn
    // comes from the snapshot that turn was answering, and the first action in
    // a turn can invalidate the rest of them — a click that navigates leaves
    // every other handle addressing a page that is gone. The loop would then
    // halt on the second call with `model-output-unusable`, having already
    // paid for the turn. Parallel tool use is a real capability of the model
    // and it is switched off here because this particular tool vocabulary
    // cannot honour it.
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: EFFORT },
  };
}

/**
 * The tool calls in a response, or a `MalformedModelOutput` explaining which
 * way the turn was unusable.
 *
 * All three rejections below are `MalformedModelOutput` and not `DriverFault`,
 * because all three are the model answering badly rather than the harness
 * being broken — the loop catches this type and escalates rather than
 * crashing (src/discover/loop.ts). They carry distinguishable messages on
 * purpose: an operator reading `model-output-unusable` in the evidence needs
 * to know whether the model talked instead of acting, was declined by a
 * safety classifier, or simply ran out of room mid-turn, and those want three
 * different responses.
 */
export function toolCallsFrom(response: Anthropic.Message): Array<{ name: string; input: unknown }> {
  if (response.stop_reason === "refusal") {
    // `stop_details` is documented as populated only on a refusal, and read
    // defensively anyway: it is the one field here whose absence would turn a
    // reportable refusal into a `TypeError` thrown from the reporting path,
    // which the loop would rethrow as an unhandled crash rather than escalate.
    const category = (response.stop_details as { category?: unknown } | null | undefined)?.category;
    throw new MalformedModelOutput(
      `the model refused this turn (stop_reason "refusal"${category === undefined || category === null ? "" : `, category "${String(category)}"`})`,
    );
  }

  if (response.stop_reason === "max_tokens") {
    // A truncated turn can still carry a `tool_use` block, whose `input` is
    // whatever survived the cut. Accepting it would let a half-written call
    // through on the strength of "it produced calls".
    throw new MalformedModelOutput(
      `the model's turn was truncated at max_tokens (${MAX_TOKENS}), so any tool call in it is incomplete`,
    );
  }

  const calls = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ name: block.name, input: block.input }));

  if (calls.length === 0) {
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .slice(0, 200);
    throw new MalformedModelOutput(
      `the model's turn contained no tool call (stop_reason "${String(response.stop_reason)}")${text === "" ? "" : `: ${text}`}`,
    );
  }

  return calls;
}

/**
 * What this turn is charged for.
 *
 * Cached input tokens are counted as ordinary input tokens. That is not
 * exact — a cache read bills at about a tenth of the input rate and a cache
 * write at about a quarter more — but `Budget` charges token counts at one
 * rate, and this direction over-states reads rather than under-states them.
 * Nothing here sets `cache_control`, so both fields are expected to be zero;
 * they are added rather than ignored so that a future request that does cache
 * is not silently billed as free.
 */
export function usageFrom(response: Anthropic.Message): { inputTokens: number; outputTokens: number } {
  const usage = response.usage;
  return {
    inputTokens:
      usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

export interface AnthropicDriverOptions {
  apiKey: string;
  model: string;
  budget: Budget;
  /**
   * Required, and not on `ModelDriver.next()` — the loop passes a driver the
   * page and the model's own turns, never the goal, so the goal has to be
   * bound at construction. The brief's signature names only the first three;
   * these two are the minimum a request cannot be built without.
   */
  goal: string;
  allowlist: readonly string[];
}

/**
 * A `ModelDriver` backed by a real Claude model.
 *
 * On the budget, which is the one thing to get right in this file: this
 * driver charges the `Budget` it is given, from each response's usage, before
 * the turn is handed back. **The loop charges too** — `discover()` charges the
 * delta of `driver.usage()` on every turn (src/discover/loop.ts) — so the two
 * must not be handed the *same* `Budget` object or every turn is billed
 * twice: the ceiling would bind at half its stated value and `spentUsd()`
 * would report double what was actually spent. `scripts/discover.mts`
 * therefore constructs two `Budget` instances with the same ceiling, one for
 * each, and checks at the end that they agree. Two guards at the same limit,
 * each charged once, is the point: this one refuses to *return* a turn that
 * crossed the line, the loop's refuses to *act* again after one did.
 *
 * The API key is read from nothing — it is passed in, and this class never
 * logs it, never puts it in an error message, and never falls back to the
 * environment. An empty key is a `DriverFault` at construction rather than a
 * silent pickup of whatever happens to be exported in the shell.
 */
export class AnthropicDriver implements ModelDriver {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly budget: Budget;
  private readonly goal: string;
  private readonly allowlist: readonly string[];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(opts: AnthropicDriverOptions) {
    if (opts.apiKey.trim() === "") {
      throw new DriverFault(
        "AnthropicDriver was constructed without an API key; set ANTHROPIC_API_KEY at the call site rather than letting the client look for one",
      );
    }
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.budget = opts.budget;
    this.goal = opts.goal;
    this.allowlist = opts.allowlist;
  }

  async next(observation: Observation, history: DriverTurn[]): Promise<DriverTurn> {
    const request = buildRequest({
      goal: this.goal,
      observation,
      allowlist: this.allowlist,
      history,
      model: this.model,
    });

    let response: Anthropic.Message;
    try {
      response = await this.send(request);
    } catch (thrown) {
      // Anything the transport throws — a bad key, a rate limit, a 500, a
      // socket that died — says nothing about the page or the model's
      // judgement. It is the harness or the network being broken, which is
      // `DriverFault`'s own definition, and the loop rethrows it rather than
      // reporting a clean escalation for a run that never got an answer.
      throw new DriverFault(`the Anthropic API call failed: ${(thrown as Error).message}`);
    }

    // Counters first, charge second. `charge` throws when the ceiling is
    // crossed, and the tokens in that response were spent whether or not the
    // turn is returned — updating after the charge would lose them from
    // `usage()` at the exact moment the run went over.
    const used = usageFrom(response);
    this.inputTokens += used.inputTokens;
    this.outputTokens += used.outputTokens;
    this.budget.charge(used);

    return { calls: toolCallsFrom(response) };
  }

  usage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  /**
   * The one call that costs money, alone in its own method so that everything
   * else this class does — request shaping, usage accounting, budget
   * charging, response parsing — can be exercised offline by a subclass that
   * replaces it. That seam is why `tests/discover/anthropic.test.ts` can pin
   * the charging behaviour without spending anything.
   */
  protected async send(request: DiscoveryRequest): Promise<Anthropic.Message> {
    return this.client.messages.create(request);
  }
}
