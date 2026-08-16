// tests/fixtures/fixtures.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const FIXTURES = ["login", "findtrans", "transfer"] as const;

describe("committed fixtures", () => {
  for (const name of FIXTURES) {
    const path = `tests/fixtures/parabank/${name}.html`;

    it(`${name}.html exists`, () => {
      expect(existsSync(path)).toBe(true);
    });

    it(`${name}.html contains no session token`, () => {
      expect(readFileSync(path, "utf8")).not.toMatch(/jsessionid=[A-Za-z0-9]{8,}/i);
    });
  }

  it("findtrans.html has the four identically-named submit buttons", () => {
    const html = readFileSync("tests/fixtures/parabank/findtrans.html", "utf8");
    const labels = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(labels.filter((l) => l === "Find Transactions")).toHaveLength(4);
  });

  it("login.html has unnamed inputs whose labels are not associated", () => {
    const html = readFileSync("tests/fixtures/parabank/login.html", "utf8");
    expect(html).toContain('<input type="text" class="input" name="username">');
    expect(html).toContain('<input type="password" class="input" name="password">');
    expect(html.match(/<label[^>]*\bfor=/g)).toBeNull();
  });
});
