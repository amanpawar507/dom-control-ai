// Container-dependent: launches a real browser and logs into the live
// ParaBank target, so this lives under tests/e2e (npm run test:e2e), not the
// container-free tests/session/ location the brief names. See task-9-report.md.
import { describe, it, expect } from "vitest";
import { ParabankSessionProvider } from "../../src/session/playwright-state.js";

describe("ParabankSessionProvider", () => {
  it("acquires a session that lands on the authenticated overview page", async () => {
    const provider = new ParabankSessionProvider("http://localhost:8081/parabank");
    const ctx = await provider.acquire("parabank", "local");
    expect(ctx.storageState).toContain("JSESSIONID");
    expect(new Date(ctx.acquiredAt).getTime()).toBeLessThanOrEqual(Date.now());
    await provider.release(ctx);
  }, 60_000);

  it("never exposes the credentials it used", async () => {
    const provider = new ParabankSessionProvider("http://localhost:8081/parabank");
    const ctx = await provider.acquire("parabank", "local");
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("demo");
    expect(serialized).not.toContain("john");
    expect(Object.keys(ctx)).toEqual(["storageState", "acquiredAt"]);
    await provider.release(ctx);
  }, 60_000);

  it("leaks neither username nor password when login fails", async () => {
    const provider = new ParabankSessionProvider(
      "http://localhost:8081/parabank",
      "wrong-user-fixture",
      "wrong-pass-fixture",
    );

    let caught: unknown;
    try {
      await provider.acquire("parabank", "local");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const surfaced = [
      String(caught),
      caught instanceof Error ? (caught.stack ?? "") : "",
      caught instanceof Error ? caught.message : "",
    ].join("\n");

    expect(surfaced).not.toContain("wrong-user-fixture");
    expect(surfaced).not.toContain("wrong-pass-fixture");
  }, 60_000);
});
