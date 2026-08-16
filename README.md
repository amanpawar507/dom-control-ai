# dom-control-ai

A computer-use automation system: an LLM discovers how to accomplish a goal against a live
application surface, the successful run is recorded as a typed, versioned **capability artifact**,
and that artifact is then **replayed deterministically** — no model in the decision loop — so an
AI agent can invoke it reliably and cheaply in production.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how
> the agent invokes it.

Built for the environment described in the brief: back-office bank/credit-union apps with no API,
stable-but-legacy UIs, real runtime error states, and many tenants running the same vendor product.

## Status

**Phase 1 (foundations) is complete.** What exists is the deterministic substrate — the half of the
system that runs with no model in the loop — driving a real legacy application end to end.

There is **no LLM and no capability artifact yet**. Bindings are hand-written in
`src/e2e/phase1-smoke.ts` rather than recorded, which is exactly what Phase 2 replaces. Nothing here
discovers anything; it proves that once something *is* discovered, replaying it can be made
deterministic, gated, and auditable.

Design: [`docs/design/specs/2026-08-15-capability-recorder-design.md`](docs/design/specs/2026-08-15-capability-recorder-design.md).
Phase 1 plan: [`docs/design/plans/2026-08-15-phase-1-foundations.md`](docs/design/plans/2026-08-15-phase-1-foundations.md).
[REPORT.md](./REPORT.md) is the submission write-up and is deliberately still a skeleton — it is
assigned to Phase 4, once there is a whole system to describe.

## What is implemented

| Area | What it does | Where |
| --- | --- | --- |
| **Targeting ladder** | Tiers 0–3 (`data-testid` → role+name → CSS → anchor-relative geometry), tried in the order the binding declares. Exactly one match or fail — never "first of many". Tier 4 (visual/model-assisted) is unrepresentable in the type, not merely unhandled. | `src/surface/playwright-web/resolver.ts` |
| **Policy gate** | One choke point every action passes: origin/path/action allowlist, then risk classification, then allow / refuse / escalate. | `src/policy/` |
| **Irreversible-action escalation** | Risk is classified from the **resolved element's own names**, read through the handle at action time — not from a label the caller passes alongside. A caller's label can only make the verdict stricter. | `src/surface/playwright-web/actor.ts`, `src/policy/risk.ts` |
| **Session boundary** | Credentials live inside one provider; what leaves it is a storage state and a timestamp. Proven empirically on the failure path, where a login error is the likeliest place for a credential to surface. | `src/session/` |
| **Redaction** | Session token and SSN-shaped values scrubbed on every evidence write, in all three forms the token takes here: URL path parameter, cookie header, and Playwright storage state (where it is an object *value*, not a matchable string). | `src/policy/redact.ts` |
| **Evidence** | One JSONL file per run, every line stamped with a run id and timestamp that a caller cannot override. | `src/evidence/logger.ts` |
| **End-to-end run** | Logs in, walks to Accounts Overview, reads a balance, is refused when it tries to leave the allowlist, and asks the gate about the admin `Clean` button without touching it. | `src/e2e/phase1-smoke.ts` |

### What the run demonstrates

- **Deterministic replay.** No model is consulted at any point. Every binding is written down ahead
  of time; every decision comes from the policy.
- **Degradation is observed, not assumed.** `first_balance` declares a tier-0 rung that matches
  nothing on this target, so the chain falls through to tier 2 — and the test asserts both the
  outcome and the declared order, so a reordered chain fails.
- **Irreversible actions escalate.** The admin `Clean` button drops the database. It is resolved on
  the live page and put to the gate three times — labelled truthfully, not labelled at all, and
  labelled as something harmless — and escalates every time. It is never clicked.
- **The allowlist holds.** A navigation off-allowlist is refused *before* Playwright is asked to go
  anywhere; the URL afterwards is the proof, not the exception.
- **Failures are legible.** A readiness timeout names the control, the page and the budget, and
  keeps Playwright's own error (call log intact) as `cause`.

## Setup

Requires Node **≥ 24** and Docker.

```bash
npm ci
npx playwright install chromium
cp .env.example .env      # only ANTHROPIC_API_KEY is for later phases; replay needs none
```

The target is ParaBank (`parasoft/parabank:baseline`) — a real third-party legacy banking app, not a
purpose-built stand-in:

```bash
npm run target:up         # docker compose up -d  (host port 8081)
npm run target:wait       # polls /parabank/index.htm, 180s budget, no sleeps
npm run target:down
```

## Running it

```bash
npm test                  # 92 tests, container-free: no target, no network
npm run test:e2e          # 11 tests against the live container
npm run smoke             # the end-to-end run on its own, printing its result as JSON
```

`npm test` is container-free by construction and must stay that way — it is the suite that can run
anywhere. Some of it launches a headless chromium against local HTML fixtures, which is not the same
thing as needing the target. Everything that touches the running container lives under `tests/e2e/`.

Each run writes `evidence/<runId>/run.jsonl`. Run output is gitignored; the directory is tracked so
a run has somewhere to write. Curating one audited run into the repo is a Phase 4 deliverable.

Waits are conditions with explicit budgets throughout. There are no sleeps.

## Layout

| Path | What's in it |
| --- | --- |
| `src/policy/` | Allowlist, risk classification, the gate, redaction |
| `src/surface/` | `Surface` seam types, and the Playwright web resolver + actor |
| `src/session/` | Session provider seam; the only module that sees a credential |
| `src/evidence/` | Run logger (JSONL, redacted on every write) |
| `src/e2e/` | The Phase 1 end-to-end run, importable so tests and the CLI share one path |
| `tests/` | Container-free suites; `tests/e2e/` needs the target; `tests/fixtures/` holds captured ParaBank markup and hand-authored synthetic markup, kept strictly apart |
| `evidence/` | Run output (gitignored) |
| `docs/design/` | Spec and phase plans |

## Deliberately not built yet

These are deferred with reasons recorded in the phase ledger, not overlooked:

- **The observer.** `Surface.observe()` is declared and unimplemented; Phase 1 resolves bindings
  directly against a page. Two things wait on it: a single visibility model (today tiers 0 and 2
  apply no visibility filter, and tier 1 is gated only as an accident of Playwright's role engine),
  and moving redaction from the log sink to the perception boundary, where the spec argues it
  belongs.
- **Frame and shadow descent.** `binding.scope` is *refused* rather than ignored — a binding naming a
  frame that cannot be honoured now fails loudly instead of quietly resolving against the top
  document.
- **The artifact schema, the discovery loop, the runtime-condition taxonomy, escalation leases, and
  the operator console** — Phases 2–4.
- **`fingerprint.stableForMs`** is declared and not enforced. Settle-waiting belongs with the replay
  engine's wait budgets, not with targeting, which must never sleep.
- **Multi-tenancy.** The session provider serves one tenant and says so rather than pretending
  otherwise.

## Core requirements checklist

- [ ] 3.1 Goal-driven agent loop (observe → decide → act against a real UI) — *no model in the loop
      yet; the act and resolve halves exist, `observe()` does not*
- [ ] 3.2 Typed, versioned capability artifact (steps, targeting, params, outputs, checkpoint) —
      *the binding and strategy types exist; nothing records or versions them*
- [ ] 3.3 Deterministic replay with an explicit error taxonomy — *replay is deterministic and its
      resolution failures are typed; the runtime-condition taxonomy is not built*
- [x] 3.4 Safety guardrails (allowlist, risky-action handling, redaction) — *allowlist enforced on
      every action, irreversible actions escalate on the element's own identity, redaction on every
      evidence write*
- [x] 3.5 Evidence / observability — *per-run JSONL with non-overridable run id and timestamps*
- [ ] 3.6 Human-in-the-loop escalation & live-session handoff — *the gate escalates; there is no
      human queue or session handoff*
- [ ] 3.7 Design for heterogeneity & multi-tenant reuse (write-up) — *the `Surface` seam is declared
      but has no implementation checked against it; the argument is in the spec, not the code*
