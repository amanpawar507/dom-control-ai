import { describe, it, expect } from "vitest";
import { TOOL_SCHEMAS, parseToolCall } from "../../src/discover/tools.js";

describe("tool vocabulary", () => {
  it("declares exactly the eight tools the spec names", () => {
    expect(TOOL_SCHEMAS.map((t) => t.name).sort()).toEqual(
      ["click", "done", "extract", "fill", "navigate", "observe", "select", "stuck"].sort(),
    );
  });

  it("requires done to name the checkpoint that proves the goal", () => {
    // "done" without a checkpoint is a model asserting success. The
    // checkpoint is what makes it verifiable.
    expect(() => parseToolCall("done", {})).toThrow(/checkpoint/);
    expect(() => parseToolCall("done", { checkpoint: "n7" })).not.toThrow();
  });

  it("requires stuck to carry a reason", () => {
    expect(() => parseToolCall("stuck", {})).toThrow(/reason/);
  });

  it("accepts only a handle for click, never a selector", () => {
    expect(() => parseToolCall("click", { handle: "n3" })).not.toThrow();
    expect(() => parseToolCall("click", { selector: "#btn" })).toThrow(/selector|handle/);
  });

  it("rejects a selector smuggled alongside a valid handle", () => {
    // The dangerous case isn't a bare selector — it's a handle that also
    // carries a selector, since a lenient schema might accept it and let a
    // downstream consumer prefer the wrong one. Extra unknown keys must be
    // rejected outright, not silently dropped.
    expect(() => parseToolCall("click", { handle: "n3", selector: "#btn" })).toThrow(/selector/);
  });

  it("rejects fill and select calls that carry a selector instead of a handle", () => {
    expect(() => parseToolCall("fill", { selector: "#txn", value: "123" })).toThrow(/selector|handle/);
    expect(() => parseToolCall("select", { selector: "#opt", value: "USD" })).toThrow(/selector|handle/);
    expect(() => parseToolCall("fill", { handle: "n1", value: "123" })).not.toThrow();
    expect(() => parseToolCall("select", { handle: "n1", value: "USD" })).not.toThrow();
  });

  it("offers observe no parameters, rather than one that does nothing", () => {
    // It advertised `screenshot` while the loop discarded it and nothing ever
    // took one. A tool parameter the model can set and the system ignores is a
    // lie told to the only reader that cannot check.
    expect(() => parseToolCall("observe", {})).not.toThrow();
    expect(() => parseToolCall("observe", { screenshot: true })).toThrow();
    const observe = TOOL_SCHEMAS.find((s) => s.name === "observe")!;
    expect(JSON.stringify(observe)).not.toContain("screenshot");
  });

  it("throws on an unknown tool name", () => {
    expect(() => parseToolCall("delete_everything", {})).toThrow(/unknown tool/i);
  });

  it("derives TOOL_SCHEMAS from the same Zod schemas parseToolCall validates against", () => {
    // The wire schema and the runtime validator must not be able to drift —
    // that's the whole point of deriving rather than hand-writing. Spot
    // check: click's JSON Schema requires exactly "handle" and forbids
    // additional properties, matching the strict-handle-only behaviour
    // exercised above.
    const click = TOOL_SCHEMAS.find((t) => t.name === "click");
    expect(click).toBeDefined();
    expect(click?.input_schema).toMatchObject({
      type: "object",
      required: ["handle"],
      additionalProperties: false,
    });
    expect(click?.input_schema.properties).toHaveProperty("handle");
    expect(click?.input_schema.properties).not.toHaveProperty("selector");
  });
});
