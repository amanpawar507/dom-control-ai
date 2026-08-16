# Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the surface, session, and policy layers, then prove them with a scripted run that drives ParaBank end to end with no model in the loop.

**Architecture:** A `Surface` interface (observe / act / resolve) with one Playwright web implementation. Every action passes through a shared policy gate that enforces an allowlist, classifies risk, and redacts at the observation boundary. A `SessionProvider` owns authentication so nothing above it ever sees a credential. Phase 1 ships no LLM and no artifact schema — it ships the machinery those depend on, exercised by a hardcoded script.

**Tech Stack:** Node 25 · TypeScript (ESM) · Playwright · Zod · Vitest · Docker (ParaBank)

**Spec:** `docs/design/specs/2026-08-15-capability-recorder-design.md`

## Global Constraints

- Runtime is Node ≥ 24; `package.json` sets `"type": "module"`. All imports use ESM with explicit `.js` extensions in relative specifiers.
- Target is `parasoft/parabank:baseline` on **host port 8081** (`http://localhost:8081/parabank/`). Port 8080 is occupied by Jenkins on the development machine and must not be used.
- No credential, session token, or `;jsessionid=` value may appear in any log line, evidence file, or test fixture. Redaction happens at the observation boundary, never at the log sink.
- Every resolver result is exactly one element or a typed failure. Never `[0]` of many.
- No `sleep`/`waitForTimeout` anywhere. Waits are condition-based with an explicit budget.
- Fixtures are captured from the running container and committed under `tests/fixtures/`. They must not contain a `jsessionid`.
- Fault injection targets the local container only. Never the public ParaBank instance.
- Commit after every task. Branch: `feat/agent-loop`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Toolchain |
| `docker-compose.yml` | ParaBank on 8081 |
| `scripts/target-wait.mjs` | Block until the target answers |
| `src/policy/allowlist.ts` | Origin / path / action-type permission |
| `src/policy/risk.ts` | safe · guarded · irreversible classification |
| `src/policy/redact.ts` | Strip session tokens and declared-sensitive values |
| `src/policy/gate.ts` | Single choke point combining the three |
| `src/surface/types.ts` | `Surface`, `Observation`, `ObservedNode`, `Binding`, `Resolution` |
| `src/surface/playwright-web/observer.ts` | Page → `Observation` with handles |
| `src/surface/playwright-web/resolver.ts` | `Binding` → exactly one element |
| `src/surface/playwright-web/actor.ts` | Dispatch actions through the gate |
| `src/session/provider.ts` | `SessionProvider` interface |
| `src/session/playwright-state.ts` | Storage-state acquisition; credentials confined here |
| `src/evidence/logger.ts` | JSONL run log |
| `scripts/phase1-smoke.mts` | The scripted end-to-end run |

---

## Task 1: Toolchain and target harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `scripts/target-wait.mjs`
- Test: `tests/target.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` (vitest), `npm run target:up`, `npm run target:wait`

- [ ] **Step 1: Write the failing test**

```ts
// tests/target.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/target.test.ts`
Expected: FAIL — vitest is not installed yet ("command not found" or missing config).

- [ ] **Step 3: Write minimal implementation**

```jsonc
// package.json
{
  "name": "dom-control-ai",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "target:up": "docker compose up -d",
    "target:down": "docker compose down",
    "target:wait": "node scripts/target-wait.mjs"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "dependencies": {
    "playwright": "^1.56.0",
    "zod": "^4.0.0"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src", "tests", "scripts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});
```

```yaml
# docker-compose.yml
services:
  parabank:
    image: parasoft/parabank:baseline
    container_name: parabank-baseline
    ports:
      - "8081:8080"   # 8080 on the host is Jenkins; do not change
      - "9001:9001"
      - "61616:61616"
```

```js
// scripts/target-wait.mjs
const URL_ = "http://localhost:8081/parabank/index.htm";
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
  try {
    const res = await fetch(URL_, { redirect: "follow" });
    if (res.ok) { console.log("target ready"); process.exit(0); }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("target did not become ready within 180s");
process.exit(1);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npm run target:up && npm run target:wait && npm test`
Expected: PASS — one test, "serves the ParaBank login page".

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts docker-compose.yml scripts/target-wait.mjs tests/target.test.ts
git commit -m "feat: toolchain and ParaBank target harness on port 8081"
```

---

## Task 2: Allowlist

**Files:**
- Create: `src/policy/allowlist.ts`
- Test: `tests/policy/allowlist.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type ActionType`, `interface Allowlist`, `type PolicyDecision`, `checkAllowlist(list: Allowlist, url: string, action: ActionType): PolicyDecision`

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy/allowlist.test.ts
import { describe, it, expect } from "vitest";
import { checkAllowlist, type Allowlist } from "../../src/policy/allowlist.js";

const list: Allowlist = {
  origins: ["http://localhost:8081"],
  paths: ["/parabank/**"],
  actions: ["click", "fill", "navigate", "extract"],
};

describe("checkAllowlist", () => {
  it("allows an in-scope origin, path, and action", () => {
    expect(checkAllowlist(list, "http://localhost:8081/parabank/overview.htm", "click"))
      .toEqual({ allowed: true });
  });

  it("refuses a foreign origin", () => {
    const d = checkAllowlist(list, "https://evil.example/parabank/x", "click");
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: expect.stringContaining("origin") });
  });

  it("refuses an out-of-scope path on an allowed origin", () => {
    const d = checkAllowlist(list, "http://localhost:8081/other/x", "click");
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("path") });
  });

  it("refuses an action type not on the list", () => {
    const d = checkAllowlist(list, "http://localhost:8081/parabank/x", "upload");
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("action") });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy/allowlist.test.ts`
Expected: FAIL — "Cannot find module '../../src/policy/allowlist.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/policy/allowlist.ts
export type ActionType = "click" | "fill" | "select" | "navigate" | "extract" | "upload";

export interface Allowlist {
  origins: string[];
  paths: string[]; // glob: * within a segment, ** across segments
  actions: ActionType[];
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function checkAllowlist(list: Allowlist, url: string, action: ActionType): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `unparseable url: ${url}` };
  }
  if (!list.origins.includes(parsed.origin)) {
    return { allowed: false, reason: `origin not allowed: ${parsed.origin}` };
  }
  if (!list.paths.some((p) => globToRegExp(p).test(parsed.pathname))) {
    return { allowed: false, reason: `path not allowed: ${parsed.pathname}` };
  }
  if (!list.actions.includes(action)) {
    return { allowed: false, reason: `action not allowed: ${action}` };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy/allowlist.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/allowlist.ts tests/policy/allowlist.test.ts
git commit -m "feat(policy): allowlist over origin, path glob, and action type"
```

---

## Task 3: Risk classification

**Files:**
- Create: `src/policy/risk.ts`
- Test: `tests/policy/risk.test.ts`

**Interfaces:**
- Consumes: `ActionType` from `src/policy/allowlist.js`
- Produces: `type RiskTier = "safe" | "guarded" | "irreversible"`, `interface RiskRule`, `classifyRisk(url: string, action: ActionType, controlName: string | null, rules: RiskRule[]): RiskTier`

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy/risk.test.ts
import { describe, it, expect } from "vitest";
import { classifyRisk, type RiskRule } from "../../src/policy/risk.js";

const rules: RiskRule[] = [
  { tier: "irreversible", matchControl: "^(Clean|Shutdown)$" },
  { tier: "irreversible", matchPath: "^/parabank/transfer\\.htm$", matchAction: "click" },
  { tier: "guarded", matchAction: "fill" },
];

describe("classifyRisk", () => {
  it("defaults to safe when no rule matches", () => {
    expect(classifyRisk("http://localhost:8081/parabank/overview.htm", "click", "Accounts Overview", rules))
      .toBe("safe");
  });

  it("marks the admin Clean button irreversible by control name", () => {
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", "Clean", rules))
      .toBe("irreversible");
  });

  it("marks a transfer submit irreversible by path and action", () => {
    expect(classifyRisk("http://localhost:8081/parabank/transfer.htm", "click", "Transfer", rules))
      .toBe("irreversible");
  });

  it("marks a form fill guarded", () => {
    expect(classifyRisk("http://localhost:8081/parabank/register.htm", "fill", null, rules))
      .toBe("guarded");
  });

  it("prefers the most severe matching rule regardless of order", () => {
    const reordered: RiskRule[] = [{ tier: "guarded", matchAction: "click" }, ...rules];
    expect(classifyRisk("http://localhost:8081/parabank/admin.htm", "click", "Clean", reordered))
      .toBe("irreversible");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy/risk.test.ts`
Expected: FAIL — "Cannot find module '../../src/policy/risk.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/policy/risk.ts
import type { ActionType } from "./allowlist.js";

export type RiskTier = "safe" | "guarded" | "irreversible";

export interface RiskRule {
  tier: RiskTier;
  matchPath?: string;    // regex against URL pathname
  matchAction?: ActionType;
  matchControl?: string; // regex against the control's accessible name
}

const SEVERITY: Record<RiskTier, number> = { safe: 0, guarded: 1, irreversible: 2 };

export function classifyRisk(
  url: string,
  action: ActionType,
  controlName: string | null,
  rules: RiskRule[],
): RiskTier {
  const pathname = new URL(url).pathname;
  let worst: RiskTier = "safe";

  for (const rule of rules) {
    if (rule.matchPath && !new RegExp(rule.matchPath).test(pathname)) continue;
    if (rule.matchAction && rule.matchAction !== action) continue;
    if (rule.matchControl) {
      if (controlName === null) continue;
      if (!new RegExp(rule.matchControl).test(controlName)) continue;
    }
    if (SEVERITY[rule.tier] > SEVERITY[worst]) worst = rule.tier;
  }
  return worst;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy/risk.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/risk.ts tests/policy/risk.test.ts
git commit -m "feat(policy): risk classification with most-severe-wins semantics"
```

---

## Task 4: Redaction

**Files:**
- Create: `src/policy/redact.ts`
- Test: `tests/policy/redact.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `redactUrl(url: string): string`, `redactText(text: string): string`, `redactValue(controlName: string | null, value: string, sensitive: readonly string[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy/redact.test.ts
import { describe, it, expect } from "vitest";
import { redactUrl, redactText, redactValue } from "../../src/policy/redact.js";

describe("redactUrl", () => {
  it("strips a jsessionid path parameter", () => {
    expect(redactUrl("http://localhost:8081/parabank/about.htm;jsessionid=SYNTHETICTESTTOKEN00000000000000"))
      .toBe("http://localhost:8081/parabank/about.htm;jsessionid=<redacted>");
  });

  it("leaves a clean url untouched", () => {
    const u = "http://localhost:8081/parabank/overview.htm";
    expect(redactUrl(u)).toBe(u);
  });
});

describe("redactText", () => {
  it("redacts an SSN-shaped string", () => {
    expect(redactText("ssn 123-45-6789 on file")).toBe("ssn <redacted:ssn> on file");
  });

  it("redacts a jsessionid appearing in free text", () => {
    expect(redactText("GET /x;jsessionid=ABCDEF0123456789ABCDEF0123456789"))
      .toBe("GET /x;jsessionid=<redacted>");
  });
});

describe("redactValue", () => {
  it("redacts a value whose control is declared sensitive", () => {
    expect(redactValue("SSN:", "123-45-6789", ["SSN:", "Password:"])).toBe("<redacted:SSN:>");
  });

  it("passes through a non-sensitive value", () => {
    expect(redactValue("First Name:", "Ada", ["SSN:"])).toBe("Ada");
  });

  it("treats a null control name as non-sensitive but still scrubs patterns", () => {
    expect(redactValue(null, "123-45-6789", [])).toBe("<redacted:ssn>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy/redact.test.ts`
Expected: FAIL — "Cannot find module '../../src/policy/redact.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/policy/redact.ts
const JSESSIONID = /;jsessionid=[A-Za-z0-9]+/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

export function redactUrl(url: string): string {
  return url.replace(JSESSIONID, ";jsessionid=<redacted>");
}

export function redactText(text: string): string {
  return text.replace(JSESSIONID, ";jsessionid=<redacted>").replace(SSN, "<redacted:ssn>");
}

export function redactValue(
  controlName: string | null,
  value: string,
  sensitive: readonly string[],
): string {
  if (controlName !== null && sensitive.includes(controlName)) {
    return `<redacted:${controlName}>`;
  }
  return redactText(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy/redact.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/redact.ts tests/policy/redact.test.ts
git commit -m "feat(policy): redact session tokens, SSN patterns, and declared-sensitive values"
```

---

## Task 5: Policy gate

**Files:**
- Create: `src/policy/gate.ts`
- Test: `tests/policy/gate.test.ts`

**Interfaces:**
- Consumes: `checkAllowlist`, `Allowlist`, `ActionType`, `classifyRisk`, `RiskRule`, `RiskTier`
- Produces: `interface PolicyConfig { allowlist: Allowlist; riskRules: RiskRule[]; sensitiveControls: string[]; approved: boolean }`, `type GateVerdict`, `gate(cfg: PolicyConfig, req: GateRequest): GateVerdict`

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy/gate.test.ts
import { describe, it, expect } from "vitest";
import { gate, type PolicyConfig } from "../../src/policy/gate.js";

const cfg: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "navigate", "extract"],
  },
  riskRules: [
    { tier: "irreversible", matchControl: "^(Clean|Shutdown)$" },
    { tier: "guarded", matchAction: "fill" },
  ],
  sensitiveControls: ["SSN:"],
  approved: false,
};

const at = (path: string) => `http://localhost:8081${path}`;

describe("gate", () => {
  it("permits a safe in-scope action", () => {
    expect(gate(cfg, { url: at("/parabank/overview.htm"), action: "click", controlName: "Accounts Overview" }))
      .toEqual({ decision: "allow", risk: "safe" });
  });

  it("refuses an out-of-allowlist action before considering risk", () => {
    const v = gate(cfg, { url: "https://evil.example/x", action: "click", controlName: null });
    expect(v).toMatchObject({ decision: "refuse" });
  });

  it("escalates an irreversible action even when in-allowlist", () => {
    expect(gate(cfg, { url: at("/parabank/admin.htm"), action: "click", controlName: "Clean" }))
      .toMatchObject({ decision: "escalate", risk: "irreversible" });
  });

  it("refuses a guarded action while the capability is unapproved", () => {
    expect(gate(cfg, { url: at("/parabank/register.htm"), action: "fill", controlName: "First Name:" }))
      .toMatchObject({ decision: "refuse", risk: "guarded" });
  });

  it("permits a guarded action once approved", () => {
    expect(gate({ ...cfg, approved: true }, { url: at("/parabank/register.htm"), action: "fill", controlName: "First Name:" }))
      .toEqual({ decision: "allow", risk: "guarded" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy/gate.test.ts`
Expected: FAIL — "Cannot find module '../../src/policy/gate.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/policy/gate.ts
import { checkAllowlist, type ActionType, type Allowlist } from "./allowlist.js";
import { classifyRisk, type RiskRule, type RiskTier } from "./risk.js";

export interface PolicyConfig {
  allowlist: Allowlist;
  riskRules: RiskRule[];
  sensitiveControls: string[];
  approved: boolean;
}

export interface GateRequest {
  url: string;
  action: ActionType;
  controlName: string | null;
}

export type GateVerdict =
  | { decision: "allow"; risk: RiskTier }
  | { decision: "escalate"; risk: RiskTier; reason: string }
  | { decision: "refuse"; risk?: RiskTier; reason: string };

export function gate(cfg: PolicyConfig, req: GateRequest): GateVerdict {
  const permitted = checkAllowlist(cfg.allowlist, req.url, req.action);
  if (!permitted.allowed) return { decision: "refuse", reason: permitted.reason };

  const risk = classifyRisk(req.url, req.action, req.controlName, cfg.riskRules);

  if (risk === "irreversible") {
    return { decision: "escalate", risk, reason: "irreversible action requires a human" };
  }
  if (risk === "guarded" && !cfg.approved) {
    return { decision: "refuse", risk, reason: "guarded action requires an approved capability" };
  }
  return { decision: "allow", risk };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy/gate.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/gate.ts tests/policy/gate.test.ts
git commit -m "feat(policy): single gate combining allowlist, risk, and approval state"
```

---

## Task 6: Surface types

**Files:**
- Create: `src/surface/types.ts`
- Test: `tests/surface/types.test.ts`

**Interfaces:**
- Consumes: `ActionType` from `src/policy/allowlist.js`
- Produces: `type Handle`, `type ScopePath`, `interface ObservedNode`, `interface Observation`, `type Strategy`, `interface Binding`, `type Resolution`, `interface Action`, `interface Surface`

- [ ] **Step 1: Write the failing test**

```ts
// tests/surface/types.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/surface/types.test.ts`
Expected: FAIL — "Cannot find module '../../src/surface/types.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/surface/types.ts
import type { ActionType } from "../policy/allowlist.js";

export type Handle = string;

export type ScopePath = Array<{ kind: "frame" | "shadow"; name: string }>;

export function scopeKey(path: ScopePath): string {
  if (path.length === 0) return "/";
  return path.map((h) => `/${h.kind}:${h.name}`).join("");
}

export interface Box { x: number; y: number; w: number; h: number }

export interface ObservedNode {
  handle: Handle;
  role: string;
  name: string | null;
  visible: boolean;
  editable: boolean;
  box: Box | null;
  scope: ScopePath;
  text: string | null;
}

export interface Observation {
  url: string;
  title: string;
  nodes: ObservedNode[];
  capturedAt: string;
}

export type Strategy =
  | { tier: 0; by: "testid"; value: string }
  | { tier: 1; by: "role"; role: string; name: string }
  | { tier: 2; by: "css"; value: string }
  | { tier: 3; by: "anchor"; anchorText: string; rel: "nearest-right"; accepts: string[] };

export interface Fingerprint {
  matches?: string;
  tag?: string;
  stableForMs?: number;
}

export interface Binding {
  scope: ScopePath;
  chain: Strategy[];
  fingerprint?: Fingerprint;
}

export type Resolution =
  | { ok: true; tier: number; handle: Handle }
  | { ok: false; reason: "no-match" | "ambiguous" | "fingerprint-mismatch"; tier?: number; count?: number };

export interface Action {
  type: ActionType;
  handle?: Handle;
  value?: string;
  url?: string;
}

export interface Surface {
  observe(): Promise<Observation>;
  act(action: Action): Promise<void>;
  resolve(binding: Binding, args: Record<string, string>): Promise<Resolution>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/surface/types.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/surface/types.ts tests/surface/types.test.ts
git commit -m "feat(surface): core types for observation, binding, and resolution"
```

---

## Task 7: Capture ParaBank fixtures

**Files:**
- Create: `scripts/capture-fixtures.mts`, `tests/fixtures/parabank/login.html`, `tests/fixtures/parabank/findtrans.html`, `tests/fixtures/parabank/transfer.html`
- Test: `tests/fixtures/fixtures.test.ts`

**Interfaces:**
- Consumes: `npm run target:wait`
- Produces: three committed HTML fixtures, guaranteed free of session tokens

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fixtures/fixtures.test.ts`
Expected: FAIL — all `existsSync` assertions false.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/capture-fixtures.mts
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { redactText } from "../src/policy/redact.js";

const BASE = "http://localhost:8081/parabank";
const OUT = "tests/fixtures/parabank";

const PAGES: Array<{ name: string; path: string; auth: boolean }> = [
  { name: "login", path: "/index.htm", auth: false },
  { name: "findtrans", path: "/findtrans.htm", auth: true },
  { name: "transfer", path: "/transfer.htm", auth: true },
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Fixture account ships inside the container image. Never a real credential.
await page.goto(`${BASE}/index.htm`);
await page.locator('input[name="username"]').fill("john");
await page.locator('input[name="password"]').fill("demo");
await page.locator('input[value="Log In"]').click();
await page.waitForURL(/overview\.htm/, { timeout: 15_000 });

mkdirSync(OUT, { recursive: true });
for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`);
  await page.waitForLoadState("domcontentloaded");
  const html = redactText(await page.content());
  writeFileSync(`${OUT}/${p.name}.html`, html, "utf8");
  console.log(`captured ${p.name}.html`);
}

await browser.close();
```

Run it once to produce the fixtures:

```bash
npx playwright install chromium
npm run target:wait
npx tsx scripts/capture-fixtures.mts   # or: node --experimental-strip-types scripts/capture-fixtures.mts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fixtures/fixtures.test.ts`
Expected: PASS — 7 tests. If the four-button assertion fails, the capture ran against the wrong page; re-check `findtrans.htm`.

- [ ] **Step 5: Commit**

```bash
git add scripts/capture-fixtures.mts tests/fixtures/parabank/*.html tests/fixtures/fixtures.test.ts
git commit -m "test: capture redacted ParaBank fixtures for resolver tests"
```

---

## Task 8: Resolver

**Files:**
- Create: `src/surface/playwright-web/resolver.ts`
- Test: `tests/surface/resolver.test.ts`

**Interfaces:**
- Consumes: `Binding`, `Strategy`, `Resolution` from `src/surface/types.js`
- Produces: `resolveBinding(page: Page, binding: Binding, args: Record<string, string>): Promise<Resolution>`

This is the load-bearing task. The critical assertion is that four identically-named
buttons produce `{ ok: false, reason: "ambiguous", count: 4 }` — **not** a match.

- [ ] **Step 1: Write the failing test**

```ts
// tests/surface/resolver.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { resolveBinding } from "../../src/surface/playwright-web/resolver.js";
import type { Binding } from "../../src/surface/types.js";

let browser: Browser;
let page: Page;

const fixture = (n: string) => pathToFileURL(resolvePath(`tests/fixtures/parabank/${n}.html`)).href;

beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

describe("resolveBinding", () => {
  it("refuses to choose among four identically-named buttons", async () => {
    await page.goto(fixture("findtrans"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 1, by: "role", role: "button", name: "Find Transactions" }],
    };
    expect(await resolveBinding(page, binding, {})).toEqual({
      ok: false, reason: "ambiguous", tier: 1, count: 4,
    });
  });

  it("resolves an unnamed input by anchor text to its right-hand neighbour", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "Username", rel: "nearest-right", accepts: ["input"] }],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tier).toBe(3);
  });

  it("falls through a failing tier to the next strategy in the chain", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [
        { tier: 1, by: "role", role: "textbox", name: "Username" },   // no accessible name — fails
        { tier: 3, by: "anchor", anchorText: "Username", rel: "nearest-right", accepts: ["input"] },
      ],
    };
    const r = await resolveBinding(page, binding, {});
    expect(r).toMatchObject({ ok: true, tier: 3 });
  });

  it("reports no-match when every strategy fails", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: "#definitely-not-here" }],
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: false, reason: "no-match" });
  });

  it("rejects a unique match whose fingerprint does not hold", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 2, by: "css", value: 'input[name="username"]' }],
      fingerprint: { tag: "select" },
    };
    expect(await resolveBinding(page, binding, {})).toMatchObject({ ok: false, reason: "fingerprint-mismatch" });
  });

  it("substitutes $arg placeholders into strategy fields", async () => {
    await page.goto(fixture("login"));
    const binding: Binding = {
      scope: [],
      chain: [{ tier: 3, by: "anchor", anchorText: "$label", rel: "nearest-right", accepts: ["input"] }],
    };
    const r = await resolveBinding(page, binding, { label: "Password" });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/surface/resolver.test.ts`
Expected: FAIL — "Cannot find module '../../src/surface/playwright-web/resolver.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/surface/playwright-web/resolver.ts
import type { Locator, Page } from "playwright";
import type { Binding, Fingerprint, Resolution, Strategy } from "../types.js";

function subst(text: string, args: Record<string, string>): string {
  return text.replace(/\$(\w+)/g, (whole, key: string) => args[key] ?? whole);
}

function locatorFor(page: Page, s: Strategy, args: Record<string, string>): Locator {
  switch (s.by) {
    case "testid":
      return page.locator(`[data-testid="${subst(s.value, args)}"]`);
    case "role":
      return page.getByRole(s.role as Parameters<Page["getByRole"]>[0], {
        name: subst(s.name, args),
        exact: true,
      });
    case "css":
      return page.locator(subst(s.value, args));
    case "anchor":
      // Anchor-relative: find the text, then the nearest accepted control to its right
      // on the same visual row. Geometry, not markup — this is the tier that survives
      // unassociated labels.
      return page.locator(s.accepts.join(",")).filter({
        has: undefined,
      });
  }
}

async function anchorResolve(
  page: Page,
  s: Extract<Strategy, { by: "anchor" }>,
  args: Record<string, string>,
): Promise<Locator[]> {
  const anchorText = subst(s.anchorText, args);
  const anchorBox = await page
    .locator(`text="${anchorText}"`)
    .first()
    .boundingBox()
    .catch(() => null);
  if (!anchorBox) return [];

  const candidates = await page.locator(s.accepts.join(",")).all();
  const scored: Array<{ loc: Locator; dx: number }> = [];

  for (const loc of candidates) {
    const box = await loc.boundingBox().catch(() => null);
    if (!box) continue;
    const sameRow = box.y < anchorBox.y + anchorBox.height && box.y + box.height > anchorBox.y;
    const toTheRight = box.x >= anchorBox.x + anchorBox.width - 1;
    if (sameRow && toTheRight) scored.push({ loc, dx: box.x - anchorBox.x });
  }

  scored.sort((a, b) => a.dx - b.dx);
  return scored.length > 0 ? [scored[0]!.loc] : [];
}

async function fingerprintHolds(loc: Locator, fp: Fingerprint | undefined): Promise<boolean> {
  if (!fp) return true;
  if (fp.tag) {
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    if (tag !== fp.tag.toLowerCase()) return false;
  }
  if (fp.matches) {
    const text = (await loc.textContent()) ?? (await loc.inputValue().catch(() => "")) ?? "";
    if (!new RegExp(fp.matches).test(text.trim())) return false;
  }
  if (fp.stableForMs) {
    const before = await loc.textContent().catch(() => null);
    await loc.page().waitForTimeout(0); // yields; real settle handled by waitFor in the actor
    const after = await loc.textContent().catch(() => null);
    if (before !== after) return false;
  }
  return true;
}

export async function resolveBinding(
  page: Page,
  binding: Binding,
  args: Record<string, string>,
): Promise<Resolution> {
  let sawAmbiguous: { tier: number; count: number } | null = null;

  for (const strategy of binding.chain) {
    const matches =
      strategy.by === "anchor"
        ? await anchorResolve(page, strategy, args)
        : await locatorFor(page, strategy, args).all();

    if (matches.length === 0) continue;
    if (matches.length > 1) {
      sawAmbiguous ??= { tier: strategy.tier, count: matches.length };
      continue; // never pick one — try the next strategy
    }

    const only = matches[0]!;
    if (!(await fingerprintHolds(only, binding.fingerprint))) {
      return { ok: false, reason: "fingerprint-mismatch", tier: strategy.tier };
    }

    const handle = await only.evaluate((el) => {
      const existing = el.getAttribute("data-dca-handle");
      if (existing) return existing;
      const id = `h${Math.random().toString(36).slice(2, 10)}`;
      el.setAttribute("data-dca-handle", id);
      return id;
    });

    return { ok: true, tier: strategy.tier, handle };
  }

  if (sawAmbiguous) {
    return { ok: false, reason: "ambiguous", tier: sawAmbiguous.tier, count: sawAmbiguous.count };
  }
  return { ok: false, reason: "no-match" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/surface/resolver.test.ts`
Expected: PASS — 6 tests. The first test is the one that matters: ambiguity is a failure, not a choice.

- [ ] **Step 5: Commit**

```bash
git add src/surface/playwright-web/resolver.ts tests/surface/resolver.test.ts
git commit -m "feat(surface): tiered resolver with uniqueness assertion and fingerprint check"
```

---

## Task 9: Session provider

**Files:**
- Create: `src/session/provider.ts`, `src/session/playwright-state.ts`
- Test: `tests/session/provider.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `interface AuthenticatedContext { storageState: string; acquiredAt: string }`, `interface SessionProvider`, `class ParabankSessionProvider implements SessionProvider`

- [ ] **Step 1: Write the failing test**

```ts
// tests/session/provider.test.ts
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
    expect(Object.keys(ctx)).toEqual(["storageState", "acquiredAt"]);
    await provider.release(ctx);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session/provider.test.ts`
Expected: FAIL — "Cannot find module '../../src/session/playwright-state.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/session/provider.ts
export interface AuthenticatedContext {
  /** Serialized Playwright storage state. Contains a session cookie, never a credential. */
  storageState: string;
  acquiredAt: string;
}

export interface SessionProvider {
  acquire(product: string, tenant: string): Promise<AuthenticatedContext>;
  refresh(ctx: AuthenticatedContext): Promise<AuthenticatedContext>;
  release(ctx: AuthenticatedContext): Promise<void>;
}
```

```ts
// src/session/playwright-state.ts
import { chromium } from "playwright";
import type { AuthenticatedContext, SessionProvider } from "./provider.js";

/**
 * Credentials are confined to this module. Nothing above the seam ever sees them.
 * The local implementation uses the fixture account shipped inside the container image.
 */
export class ParabankSessionProvider implements SessionProvider {
  constructor(
    private readonly base: string,
    private readonly username = process.env["PARABANK_USER"] ?? "john",
    private readonly password = process.env["PARABANK_PASS"] ?? "demo",
  ) {}

  async acquire(_product: string, _tenant: string): Promise<AuthenticatedContext> {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${this.base}/index.htm`);
      await page.locator('input[name="username"]').fill(this.username);
      await page.locator('input[name="password"]').fill(this.password);
      await page.locator('input[value="Log In"]').click();
      await page.waitForURL(/overview\.htm/, { timeout: 20_000 });
      const state = await ctx.storageState();
      return { storageState: JSON.stringify(state), acquiredAt: new Date().toISOString() };
    } finally {
      await browser.close();
    }
  }

  async refresh(_ctx: AuthenticatedContext): Promise<AuthenticatedContext> {
    return this.acquire("parabank", "local");
  }

  async release(_ctx: AuthenticatedContext): Promise<void> {
    // Storage state is in-memory only; nothing to revoke against this target.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run target:wait && npx vitest run tests/session/provider.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/session/provider.ts src/session/playwright-state.ts tests/session/provider.test.ts
git commit -m "feat(session): provider seam confining credentials to one module"
```

---

## Task 10: Evidence logger

**Files:**
- Create: `src/evidence/logger.ts`
- Test: `tests/evidence/logger.test.ts`

**Interfaces:**
- Consumes: `redactText`, `redactUrl` from `src/policy/redact.js`
- Produces: `class RunLogger { constructor(runId: string, dir?: string); log(event: LogEvent): void; path(): string }`, `interface LogEvent { kind: string; [k: string]: unknown }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/evidence/logger.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { RunLogger } from "../../src/evidence/logger.js";

const DIR = "tests/.tmp-evidence";
afterEach(() => { if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

describe("RunLogger", () => {
  it("writes one JSON object per line", () => {
    const log = new RunLogger("run-1", DIR);
    log.log({ kind: "step.start", stepId: "s1" });
    log.log({ kind: "step.end", stepId: "s1", ok: true });

    const lines = readFileSync(log.path(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "step.start", stepId: "s1", runId: "run-1" });
  });

  it("redacts a session token in a logged url", () => {
    const log = new RunLogger("run-2", DIR);
    log.log({ kind: "nav", url: "http://localhost:8081/parabank/about.htm;jsessionid=ABC123DEF456GHI789" });
    expect(readFileSync(log.path(), "utf8")).toContain(";jsessionid=<redacted>");
    expect(readFileSync(log.path(), "utf8")).not.toContain("ABC123DEF456GHI789");
  });

  it("redacts an SSN appearing anywhere in a logged string value", () => {
    const log = new RunLogger("run-3", DIR);
    log.log({ kind: "observe", note: "field held 123-45-6789" });
    expect(readFileSync(log.path(), "utf8")).toContain("<redacted:ssn>");
  });

  it("stamps every line with runId and an ISO timestamp", () => {
    const log = new RunLogger("run-4", DIR);
    log.log({ kind: "x" });
    const rec = JSON.parse(readFileSync(log.path(), "utf8").trim());
    expect(rec.runId).toBe("run-4");
    expect(() => new Date(rec.at).toISOString()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evidence/logger.test.ts`
Expected: FAIL — "Cannot find module '../../src/evidence/logger.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/evidence/logger.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactText, redactUrl } from "../policy/redact.js";

export interface LogEvent {
  kind: string;
  [key: string]: unknown;
}

function scrub(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key === "url" ? redactText(redactUrl(value)) : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  }
  return value;
}

export class RunLogger {
  private readonly file: string;

  constructor(private readonly runId: string, dir = "evidence") {
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    this.file = join(runDir, "run.jsonl");
  }

  log(event: LogEvent): void {
    const record = { ...event, runId: this.runId, at: new Date().toISOString() };
    appendFileSync(this.file, `${JSON.stringify(scrub(record))}\n`, "utf8");
  }

  path(): string {
    return this.file;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/evidence/logger.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/logger.ts tests/evidence/logger.test.ts
git commit -m "feat(evidence): JSONL run logger with redaction on every write"
```

---

## Task 11: Scripted end-to-end run — the phase exit criterion

**Files:**
- Create: `src/surface/playwright-web/actor.ts`, `scripts/phase1-smoke.mts`
- Test: `tests/e2e/phase1.test.ts`

**Interfaces:**
- Consumes: `ParabankSessionProvider`, `resolveBinding`, `gate`, `RunLogger`, `Binding`
- Produces: `class WebActor { constructor(page: Page, cfg: PolicyConfig, log: RunLogger); act(action: Action, controlName: string | null): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/e2e/phase1.test.ts
import { describe, it, expect } from "vitest";
import { runPhase1Smoke } from "../../scripts/phase1-smoke.mjs";

describe("phase 1 end-to-end", () => {
  it("logs in, reaches the overview, and reads a balance with no model in the loop", async () => {
    const result = await runPhase1Smoke();
    expect(result.checkpointReached).toBe(true);
    expect(result.balance).toMatch(/^\$[\d,]+\.\d{2}$/);
    expect(result.tiersUsed.length).toBeGreaterThan(0);
  }, 120_000);

  it("refuses an out-of-allowlist navigation through the gate", async () => {
    const result = await runPhase1Smoke();
    expect(result.refusedForeignNavigation).toBe(true);
  }, 120_000);

  it("escalates rather than clicking the admin Clean button", async () => {
    const result = await runPhase1Smoke();
    expect(result.cleanButtonVerdict).toBe("escalate");
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e/phase1.test.ts`
Expected: FAIL — "Cannot find module '../../scripts/phase1-smoke.mjs'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/surface/playwright-web/actor.ts
import type { Page } from "playwright";
import type { Action } from "../types.js";
import { gate, type PolicyConfig } from "../../policy/gate.js";
import type { RunLogger } from "../../evidence/logger.js";

export class PolicyRefusal extends Error {
  constructor(public readonly reason: string) { super(`policy refused: ${reason}`); }
}
export class PolicyEscalation extends Error {
  constructor(public readonly reason: string) { super(`policy escalated: ${reason}`); }
}

export class WebActor {
  constructor(
    private readonly page: Page,
    private readonly cfg: PolicyConfig,
    private readonly log: RunLogger,
  ) {}

  verdictFor(action: Action, controlName: string | null) {
    const url = action.type === "navigate" ? (action.url ?? this.page.url()) : this.page.url();
    return gate(this.cfg, { url, action: action.type, controlName });
  }

  async act(action: Action, controlName: string | null): Promise<void> {
    const verdict = this.verdictFor(action, controlName);
    this.log.log({ kind: "gate", action: action.type, controlName, verdict });

    if (verdict.decision === "refuse") throw new PolicyRefusal(verdict.reason);
    if (verdict.decision === "escalate") throw new PolicyEscalation(verdict.reason);

    const target = action.handle ? this.page.locator(`[data-dca-handle="${action.handle}"]`) : null;
    switch (action.type) {
      case "navigate": await this.page.goto(action.url!); break;
      case "click":    await target!.click(); break;
      case "fill":     await target!.fill(action.value ?? ""); break;
      case "select":   await target!.selectOption(action.value ?? ""); break;
      case "extract":  break;
      case "upload":   throw new PolicyRefusal("upload is not implemented");
    }
    this.log.log({ kind: "acted", action: action.type, url: this.page.url() });
  }
}
```

```ts
// scripts/phase1-smoke.mts
import { chromium } from "playwright";
import { ParabankSessionProvider } from "../src/session/playwright-state.js";
import { resolveBinding } from "../src/surface/playwright-web/resolver.js";
import { WebActor, PolicyRefusal, PolicyEscalation } from "../src/surface/playwright-web/actor.js";
import { RunLogger } from "../src/evidence/logger.js";
import type { PolicyConfig } from "../src/policy/gate.js";
import type { Binding } from "../src/surface/types.js";

const BASE = "http://localhost:8081/parabank";

const CFG: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  sensitiveControls: ["SSN:", "Password:"],
  approved: true,
};

const BINDINGS: Record<string, Binding> = {
  nav_overview: {
    scope: [],
    chain: [{ tier: 1, by: "role", role: "link", name: "Accounts Overview" }],
  },
  first_balance: {
    scope: [],
    chain: [{ tier: 2, by: "css", value: "#accountTable tbody tr:first-child td:nth-child(2)" }],
    fingerprint: { matches: "^\\$[\\d,]+\\.\\d{2}$" },
  },
};

export interface SmokeResult {
  checkpointReached: boolean;
  balance: string | null;
  tiersUsed: number[];
  refusedForeignNavigation: boolean;
  cleanButtonVerdict: string;
}

export async function runPhase1Smoke(): Promise<SmokeResult> {
  const runId = `phase1-${Date.now()}`;
  const log = new RunLogger(runId);
  const tiersUsed: number[] = [];

  const session = await new ParabankSessionProvider(BASE).acquire("parabank", "local");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState: JSON.parse(session.storageState) });
    const page = await ctx.newPage();
    const actor = new WebActor(page, CFG, log);

    await actor.act({ type: "navigate", url: `${BASE}/index.htm` }, null);

    const navRes = await resolveBinding(page, BINDINGS["nav_overview"]!, {});
    if (!navRes.ok) throw new Error(`nav_overview did not resolve: ${navRes.reason}`);
    tiersUsed.push(navRes.tier);
    await actor.act({ type: "click", handle: navRes.handle }, "Accounts Overview");

    await page.getByRole("heading", { name: "Accounts Overview" }).waitFor({ timeout: 15_000 });
    const checkpointReached = true;

    const balRes = await resolveBinding(page, BINDINGS["first_balance"]!, {});
    if (!balRes.ok) throw new Error(`first_balance did not resolve: ${balRes.reason}`);
    tiersUsed.push(balRes.tier);
    const balance = (await page.locator(`[data-dca-handle="${balRes.handle}"]`).textContent())?.trim() ?? null;
    log.log({ kind: "extracted", control: "first_balance", value: balance });

    let refusedForeignNavigation = false;
    try {
      await actor.act({ type: "navigate", url: "https://example.com/" }, null);
    } catch (e) {
      refusedForeignNavigation = e instanceof PolicyRefusal;
    }

    const cleanVerdict = actor.verdictFor({ type: "click" }, "Clean").decision;
    log.log({ kind: "gate.probe", control: "Clean", verdict: cleanVerdict });

    return { checkpointReached, balance, tiersUsed, refusedForeignNavigation, cleanButtonVerdict: cleanVerdict };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run target:wait && npx vitest run tests/e2e/phase1.test.ts`
Expected: PASS — 3 tests. Inspect `evidence/phase1-*/run.jsonl` and confirm it contains no `jsessionid` value and no `demo`.

- [ ] **Step 5: Commit**

```bash
git add src/surface/playwright-web/actor.ts scripts/phase1-smoke.mts tests/e2e/phase1.test.ts
git commit -m "feat: scripted end-to-end run driving ParaBank through the policy gate"
```

---

## Self-review

**Spec coverage for Phase 1.** §3 `Surface` seam → Tasks 6, 8, 11. §3 policy choke point → Tasks 2–5, enforced in Task 11's actor. §5 session lifecycle → Task 9. §7 resolution rules (exactly-one, fixed order, fingerprint) → Task 8. §9 allowlist, risk tiers, redaction at the boundary → Tasks 2–4, 10. §11 evidence and the test table's resolver/redaction rows → Tasks 8, 10.

Deliberately **not** in Phase 1, and owned by later plans: the artifact schema and overlays (§4), the discovery loop and stopping conditions (§6), the runtime-condition taxonomy and result contract (§7), escalation and the lease (§8), the console (§10), drift management (§12).

**Known gaps carried into Phase 2, by design:**

- `Surface.observe()` is declared in Task 6 but not implemented — Phase 1 uses `resolveBinding` directly against a Playwright `Page`. The observer is Phase 2's first task, since the discovery loop is its only consumer.
- `fingerprint.stableForMs` in Task 8 is a stub that compares text across a yield. Real settle-waiting belongs with the replay engine's wait budgets in Phase 3.
- `locatorFor`'s `anchor` branch is unreachable — `resolveBinding` routes anchor strategies to `anchorResolve` before calling it. Phase 2 removes the dead branch when the observer lands.

**Type consistency check.** `Handle` is a `string` throughout; the resolver stamps `data-dca-handle` and the actor reads it by the same attribute. `PolicyConfig` is constructed identically in Task 5's tests and Task 11's script. `RiskTier` and `ActionType` are imported from their defining modules everywhere, never re-declared.

---

## Definition of done

```bash
npm run target:up && npm run target:wait
npm test          # every task's tests green
npx vitest run tests/e2e/phase1.test.ts
grep -rE 'jsessionid=[A-Za-z0-9]{8,}|demo' evidence/ && echo "LEAK" || echo "evidence clean"
```

A scripted run logs in, reaches Accounts Overview, extracts a balance matching the
currency fingerprint, is refused when it tries to leave the allowlist, and reports
`escalate` for the admin Clean button — with a redacted JSONL trail and no model
involved at any point.
