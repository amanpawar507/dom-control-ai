// tests/replay/recover.test.ts
//
// `page.setContent` keeps this container-free and network-free. Every fixture
// that needs a click gated goes through a real `PolicyConfig` rather than a
// stub gate, so a policy refusal in this module behaves exactly as it would
// against a live target.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { recover, type RecoveryDecl } from "../../src/replay/recover.js";
import type { ConditionDecl } from "../../src/replay/conditions.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import type { AuthenticatedContext, SessionProvider } from "../../src/session/provider.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

// `page.setContent` never navigates, so `page.url()` stays "about:blank" for
// the whole file — whose origin is the opaque string "null" and whose
// pathname is "blank" (checked directly against a live Playwright page
// above this file was written). The policy has to know that to allow
// anything at all.
const PERMISSIVE_POLICY: PolicyConfig = {
  allowlist: { origins: ["null"], paths: ["*"], actions: ["click", "navigate", "fill", "select", "extract"] },
  riskRules: [],
  approved: true,
};

const persistentCondition: ConditionDecl = {
  id: "cond",
  class: "recoverable",
  code: "UNEXPECTED_DIALOG",
  message: "still here",
  locate: { tier: 2, by: "css", value: "#cond" },
};

describe("recover — bounded attempts", () => {
  it("stops after maxAttempts rather than retrying forever", async () => {
    // A dismiss control that does not exist: every attempt does nothing, the
    // condition never clears, and the only thing that stops this is the
    // bound itself.
    await page.setContent(`<div id="cond">still here</div>`);
    const alwaysFailingDecl: RecoveryDecl = {
      kind: "dismiss",
      condition: persistentCondition,
      dismiss: { tier: 2, by: "css", value: "#does-not-exist" },
    };
    const attempts = await recover(page, alwaysFailingDecl, { maxAttempts: 2 });
    expect(attempts.tried).toBe(2);
    expect(attempts.recovered).toBe(false);
  });

  it("keeps trying within the bound, rather than giving up after one attempt", async () => {
    // The other side of "bounded": a bound of 2 must actually permit a second
    // attempt, not silently behave as though maxAttempts were 1. The dismiss
    // button's own handler only clears the condition on its second click, so
    // recovery can only succeed here if attempt 2 genuinely runs.
    await page.setContent(`
      <div id="cond">still here</div>
      <button id="dismiss" onclick="
        window.__clicks = (window.__clicks || 0) + 1;
        if (window.__clicks >= 2) document.getElementById('cond').remove();
      ">Dismiss</button>
    `);
    const clearsOnSecondTry: RecoveryDecl = {
      kind: "dismiss",
      condition: persistentCondition,
      dismiss: { tier: 2, by: "css", value: "#dismiss" },
    };
    const attempts = await recover(page, clearsOnSecondTry, { maxAttempts: 3, policy: PERMISSIVE_POLICY });
    expect(attempts.recovered).toBe(true);
    expect(attempts.tried).toBe(2);
  });

  it("gives a checkpoint a bounded chance to appear before giving up", async () => {
    // "One bounded re-wait" for transient slowness: the checkpoint is not on
    // the page yet, but the page itself adds it shortly after — well inside
    // the wait budget. This exercises the real wait, not a stub.
    await page.setContent(`<script>
      setTimeout(() => {
        const el = document.createElement("div");
        el.id = "ready";
        el.textContent = "arrived";
        document.body.appendChild(el);
      }, 15);
    </script>`);
    const rewaitDecl: RecoveryDecl = {
      kind: "rewait",
      condition: persistentCondition,
      checkpoint: { tier: 2, by: "css", value: "#ready" },
      waitBudgetMs: 500,
    };
    const attempts = await recover(page, rewaitDecl, { maxAttempts: 1 });
    expect(attempts.recovered).toBe(true);
    expect(attempts.tried).toBe(1);
  });
});

describe("recover — session expiry re-verifies before resuming", () => {
  const sessionExpiryDecl: RecoveryDecl = {
    kind: "session-expiry",
    condition: {
      id: "session-expiry",
      class: "recoverable",
      code: "SESSION_EXPIRED",
      message: "logged out",
      locate: { tier: 2, by: "css", value: "#loginPanel" },
    },
    checkpoint: { tier: 2, by: "css", value: "#checkpoint" },
  };

  it("re-verifies the last checkpoint after a session refresh", async () => {
    // Spec §7: refresh, re-verify, resume. Resuming without re-verifying assumes
    // the page came back to where it was, which is the assumption that makes a
    // resumed run act on the wrong screen.
    //
    // A real SessionProvider.refresh() never touches a page — it returns a
    // fresh AuthenticatedContext (src/session/provider.ts) and applying that
    // to the live browser context is the caller's job (recover.ts's own doc
    // comment on PLACEHOLDER_AUTH_CONTEXT says so). This stub's refresh()
    // stands in for that out-of-band step by mutating the page directly, so
    // what recover() re-verifies afterward is real DOM state rather than an
    // assertion about a call having happened.
    await page.setContent(`<div id="loginPanel">logged out</div>`);
    const stubProvider: SessionProvider = {
      acquire: async () => ({ storageState: "{}", acquiredAt: new Date().toISOString() }),
      refresh: async (ctx: AuthenticatedContext) => {
        await page.setContent(`<div id="checkpoint">back where it was</div>`);
        return ctx;
      },
      release: async () => undefined,
    };
    const r = await recover(page, sessionExpiryDecl, { maxAttempts: 1, session: stubProvider });
    expect(r.checkpointReverified).toBe(true);
    expect(r.recovered).toBe(true);
  });

  it("does not resume when the checkpoint fails to re-verify", async () => {
    // The path that matters more than the happy one: refresh() reports
    // success, but the page it hands back never shows the checkpoint again
    // (a different screen, a partial render, the login form once more).
    // Recovery must not call that a success.
    await page.setContent(`<div id="loginPanel">still logged out</div>`);
    const stubProvider: SessionProvider = {
      acquire: async () => ({ storageState: "{}", acquiredAt: new Date().toISOString() }),
      refresh: async (ctx: AuthenticatedContext) => ctx, // "succeeds", but the page never changes
      release: async () => undefined,
    };
    const r = await recover(page, sessionExpiryDecl, { maxAttempts: 2, session: stubProvider });
    expect(r.checkpointReverified).toBe(false);
    expect(r.recovered).toBe(false);
    expect(r.tried).toBe(2);
  });
});
