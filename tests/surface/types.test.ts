import { describe, it, expect } from "vitest";
import { scopeKey, type ScopePath } from "../../src/surface/types.js";

describe("scopeKey", () => {
  it("renders the document scope as an empty path", () => {
    expect(scopeKey([])).toBe("/");
  });

  it("renders nested frame and shadow hops in order", () => {
    const p: ScopePath = [
      { kind: "frame", name: "mainFrame" },
      { kind: "shadow", name: "lightning-datatable" },
    ];
    expect(scopeKey(p)).toBe("/frame:mainFrame/shadow:lightning-datatable");
  });
});
