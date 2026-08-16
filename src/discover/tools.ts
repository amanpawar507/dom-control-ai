// src/discover/tools.ts
import { z } from "zod";

/**
 * The eight tools the discovery loop hands the model. Every tool that acts
 * on the page (`click`, `fill`, `select`, `extract`) takes a `handle` and
 * nothing else — never a selector, an id, a class, or any other string the
 * model could have invented. `ObservedNode` (src/observe/snapshot.ts) is the
 * only thing that ever hands the model a handle, and a handle is valid only
 * for the observation that produced it; this file never encodes or parses
 * that structure; it is an opaque string here, exactly as it is there.
 *
 * That "handle only" rule is what makes record-time proving (Task 6)
 * meaningful: there is no brittle string for the model to smuggle into a
 * recorded binding, because a selector was never in its hands to begin
 * with. `.strict()` on every input schema below is not incidental — it is
 * what turns "the model didn't send a selector" into "the model
 * structurally cannot send a selector and have it accepted."
 */

const ClickInput = z
  .object({
    handle: z.string(),
  })
  .strict();

const FillInput = z
  .object({
    handle: z.string(),
    value: z.string(),
  })
  .strict();

const SelectInput = z
  .object({
    handle: z.string(),
    value: z.string(),
  })
  .strict();

const NavigateInput = z
  .object({
    url: z.string(),
  })
  .strict();

/**
 * `as` is the semantic name the extracted value is recorded under — the
 * same field `flow`'s extract step carries in the capability artifact
 * (src/artifact/schema.ts). A recorder turns a discovery-time `extract`
 * call's `handle` into a bound `control`; `as` passes straight through
 * unchanged, which is what lets an artifact's `outputs` block name the same
 * thing the model asked for during discovery.
 */
const ExtractInput = z
  .object({
    handle: z.string(),
    as: z.string(),
  })
  .strict();

/**
 * No handle, no selector — this asks for a fresh snapshot of the page
 * rather than acting on anything already on it. `screenshot` mirrors
 * `observe()`'s own opt-in image flag (src/observe/snapshot.ts).
 */
const ObserveInput = z
  .object({
    screenshot: z.boolean().optional(),
  })
  .strict();

/**
 * "done" without a checkpoint is a model asserting success with nothing to
 * verify it against. `checkpoint` is a handle (opaque here, as above) naming
 * the node whose presence proves the goal — required, not optional, so a
 * bare success claim cannot pass validation.
 */
const DoneInput = z
  .object({
    checkpoint: z.string(),
  })
  .strict();

/**
 * `reason` is required for the same reason `checkpoint` is on `done`: a bare
 * "I'm stuck" with nothing else is not actionable by whatever escalates
 * from it (§8).
 */
const StuckInput = z
  .object({
    reason: z.string(),
  })
  .strict();

const TOOL_DEFS = [
  {
    name: "click",
    description: "Click the element identified by handle.",
    schema: ClickInput,
  },
  {
    name: "fill",
    description: "Type value into the input identified by handle, replacing its current contents.",
    schema: FillInput,
  },
  {
    name: "select",
    description: "Choose value in the <select> (or listbox) identified by handle.",
    schema: SelectInput,
  },
  {
    name: "navigate",
    description: "Navigate the page directly to url.",
    schema: NavigateInput,
  },
  {
    name: "extract",
    description: "Read the current content of the element identified by handle and record it under the semantic name as.",
    schema: ExtractInput,
  },
  {
    name: "observe",
    description: "Request a fresh snapshot of the page's addressable elements. Call this after any action that may have changed the page.",
    schema: ObserveInput,
  },
  {
    name: "done",
    description: "Declare the goal achieved, naming the checkpoint handle whose presence proves it.",
    schema: DoneInput,
  },
  {
    name: "stuck",
    description: "Declare that the goal cannot be completed from here, and why.",
    schema: StuckInput,
  },
] as const;

/**
 * Shaped for the Anthropic SDK's `tools` parameter: `{ name, description,
 * input_schema }`. `input_schema` is derived from the same Zod schema
 * `parseToolCall` validates a call against via `z.toJSONSchema` — the wire
 * format and the runtime validator come from one definition, so they cannot
 * drift the way two hand-maintained copies of the same contract would.
 */
export const TOOL_SCHEMAS = TOOL_DEFS.map((def) => ({
  name: def.name,
  description: def.description,
  input_schema: z.toJSONSchema(def.schema),
}));

export type ToolCall =
  | { name: "click"; input: z.infer<typeof ClickInput> }
  | { name: "fill"; input: z.infer<typeof FillInput> }
  | { name: "select"; input: z.infer<typeof SelectInput> }
  | { name: "navigate"; input: z.infer<typeof NavigateInput> }
  | { name: "extract"; input: z.infer<typeof ExtractInput> }
  | { name: "observe"; input: z.infer<typeof ObserveInput> }
  | { name: "done"; input: z.infer<typeof DoneInput> }
  | { name: "stuck"; input: z.infer<typeof StuckInput> };

/**
 * Dispatches on `name` and validates `input` against that tool's schema,
 * throwing on an unknown tool name or input that fails validation. This is
 * the only path from a model's raw tool call (`unknown` at this boundary —
 * it came off the wire) into a `ToolCall` the rest of the discovery loop can
 * trust to hold a handle and nothing sharper.
 */
export function parseToolCall(name: string, input: unknown): ToolCall {
  switch (name) {
    case "click":
      return { name, input: ClickInput.parse(input) };
    case "fill":
      return { name, input: FillInput.parse(input) };
    case "select":
      return { name, input: SelectInput.parse(input) };
    case "navigate":
      return { name, input: NavigateInput.parse(input) };
    case "extract":
      return { name, input: ExtractInput.parse(input) };
    case "observe":
      return { name, input: ObserveInput.parse(input) };
    case "done":
      return { name, input: DoneInput.parse(input) };
    case "stuck":
      return { name, input: StuckInput.parse(input) };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
