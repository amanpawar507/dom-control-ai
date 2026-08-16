import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8081/parabank";

describe("target harness", () => {
  it("serves the ParaBank login page", async () => {
    const res = await fetch(`${BASE}/index.htm`, { redirect: "follow" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Customer Login");
  });
});
