import { describe, it, expect } from "vitest";
import { ScriptedDriver } from "../../src/discover/driver.js";
import type { Observation } from "../../src/observe/snapshot.js";

const obs: Observation = { url: "u", title: "t", nodes: [], screenshot: null };

describe("ScriptedDriver", () => {
  it("returns each scripted turn in order and then refuses to invent one", async () => {
    const d = new ScriptedDriver([
      [{ name: "click", input: { handle: "n1" } }],
      [{ name: "done", input: { checkpoint: "n4" } }],
    ]);
    expect((await d.next(obs, [])).calls[0]!.name).toBe("click");
    expect((await d.next(obs, [])).calls[0]!.name).toBe("done");
    // Running off the end of the script is a test authoring bug. Silently
    // returning "stuck" would make a loop test pass for the wrong reason.
    await expect(d.next(obs, [])).rejects.toThrow(/exhausted/i);
  });

  it("keeps refusing on every call past the end, not just the first", async () => {
    // Guards against an off-by-one that lets the cursor wrap or the
    // exhausted state be "consumed" by one throw and then quietly resume.
    const d = new ScriptedDriver([[{ name: "stuck", input: { reason: "x" } }]]);
    await d.next(obs, []);
    await expect(d.next(obs, [])).rejects.toThrow(/exhausted/i);
    await expect(d.next(obs, [])).rejects.toThrow(/exhausted/i);
  });

  it("reports zero usage, so a scripted test can assert nothing was spent", async () => {
    const d = new ScriptedDriver([[{ name: "stuck", input: { reason: "x" } }]]);
    expect(d.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("usage stays zero even after turns are consumed", async () => {
    // Zero must be the permanent answer for this driver, not an
    // uninitialized value that happens to read zero before next() runs.
    const d = new ScriptedDriver([[{ name: "click", input: { handle: "n1" } }]]);
    await d.next(obs, []);
    expect(d.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
