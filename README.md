# dom-control-ai

**An LLM drives a bank UI once. What it learned becomes a typed artifact that replays deterministically — with no model in the loop.**

Back-office banking software has no API, a legacy UI, real error states, and many tenants running the same vendor product. An agent that re-reasons its way through such a screen on every invocation is slow, expensive, and non-reproducible. So this system splits the problem in two: **discovery** happens once under a model, and **replay** happens forever without one.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the agent invokes it.

---

## Watch it work

▶ **[discovery-run.webm](docs/demo/discovery-run.webm)** — Claude Sonnet 5 driving a live ParaBank instance, addressing every element by opaque handle, five turns, ending in a proven artifact.

*(Plays inline on the [walkthrough page](https://claude.ai/code/artifact/b633d72f-57ac-470a-9495-45b0930b272e), alongside what the recording can't show.)*


The run cost **$0.031**. Every action passed a policy gate *before* it executed. Nothing in the recording is staged.

What the video does not show, because it happens between frames:

| | |
|---|---|
| **The model never sees a selector** | It receives roles, names and opaque handles (`o3n17`). It cannot smuggle a brittle CSS string into a recording, because it was never given one. |
| **Every action is judged first** | The gate runs before execution and is keyed on the *resolved element*, not on a name the caller claims. |
| **Every binding was proven** | On `done`, each touched handle is turned into a chain of strategies, and each was verified to resolve **uniquely and to that same element** on the recording surface. |

---

## The artifact it produced

```jsonc
{
  "capability": { "id": "…", "product": "parabank", "version": 1, "status": "draft" },
  "flow": [
    { "kind": "extract",    "control": "link_12345", "as": "first_account_number" },
    { "kind": "act",        "action": "click",  "control": "link_12345" },
    { "kind": "act",        "action": "select", "control": "combobox_all_credit_debit",
                            "value": "$combobox_all_credit_debit" },
    { "kind": "act",        "action": "click",  "control": "button_go" },
    { "kind": "checkpoint", "control": "combobox_all_credit_debit", "state": "visible" }
  ],
  "bindings": {
    "tenant": "local", "variant": "baseline",
    "entryUrl": "http://localhost:8081/parabank/overview.htm",
    "controls": {
      "combobox_all_credit_debit": {
        "chain": [
          { "tier": 3, "by": "anchor", "anchorText": "Type:", "rel": "nearest-right", "accepts": ["select"] },
          { "tier": 2, "by": "css",    "value": "select[name=\"transactionType\"]" }
        ],
        "fingerprint": { "tag": "select" }
      }
    }
  }
}
```

Two details carry most of the design.

**That control resolved by geometry, not by name.** ParaBank associates no `<label>` with its inputs — the canonical legacy pathology. Tier 3 finds the field by measuring which rendered element sits nearest the text `Type:`. A CSS rung is proven behind it as a fallback, and the order is *recorded*, not fixed globally.

**The value is `$parameter`, never a literal.** The recorder cannot tell a password field from a search box, so it records none of them. That is how a credential fails to end up inside a committed artifact.

Live in the repo: [`capabilities/parabank/…/1.0.0.json`](capabilities/).

---

## Status

**Phases 1, 2 and 3 are complete.** Record a capability with a model; replay it without one.

```
360  unit tests    container-free, zero network calls
 35  end-to-end    against a local ParaBank in Docker
$0.06 total spend  across every live model run in the project
```

**Replay is deterministic, and that is evidenced rather than asserted.** Five live runs of the recorded capability, every one succeeding, every control resolving at the same tier every time — including the dropdown at tier 3, anchor geometry measured against rendered layout, reproducing identically five times. The report is committed at [`docs/evidence/stability-report.json`](docs/evidence/stability-report.json).

Phase 3 opened by closing the hole Phase 2 shipped knowingly. Record-time proving verified that every rung of a chain named the *same* element; replay had no counterpart, and its only guard was a `tag` fingerprint that tier 3 defeats by construction — `accepts: [tag]` guarantees a wrong element carries the right tag. The chain turned out to carry its own answer: every rung was independently proven against one element, so **two rungs naming different elements is evidence the surface moved**, and neither answer can be trusted. The ladder became a corroboration set, using evidence the artifact already held.

**Phase 4 is next**: the human-in-the-loop lease, the operator console, and the cross-tenant overlay demonstration.

Full reasoning, including every judgment call and the errors made along the way:
[**Phase 1 decision record**](docs/design/2026-08-16-phase-1-decision-record.md) · [design spec](docs/design/specs/2026-08-15-capability-recorder-design.md)

---

## Replay it

```bash
npm run stability -- --runs 5     # replay the recorded capability N times, live
```

No model, no API key, no spend. The four outcomes it can reach — success, a business outcome, a hard failure, and a refusal when two proven rungs disagree — are exercised against the live application in `tests/e2e/replay-outcomes.test.ts`.

A business outcome is a *successful call carrying a code*: "no such account" is the answer a caller asked for, not a crash, and the contract keeps them distinguishable.

## Run it yourself

```bash
npm install
npx playwright install chromium

npm run target:up          # ParaBank in Docker on :8081
npm run target:wait

npm test                   # 360 unit tests — no container, no network
npm run test:e2e           # 18 against the live target
```

Then drive a model at it. This is the only command that spends money:

```bash
cp .env.example .env       # add ANTHROPIC_API_KEY
npm run discover -- \
  --id account.read-activity \
  --goal "Open the first account's activity page and narrow it to debits" \
  --budget 0.50 --video /tmp/run
```

A 15-step run costs roughly **$0.23**. `Budget` throws *before* a charge crosses its ceiling, so overspend is structurally impossible rather than merely watched for.

---

## Why the tests are the interesting part

This project shipped **seventeen** tests that passed while proving the wrong thing — the last few found in the code written to catch the earlier ones. A test asserting the model cannot smuggle a selector that only proved a required field was missing. A guard whose regex matched `loc.click(` but not `page.locator(x).click(`. A committed artifact that stopped parsing while 285 tests stayed green, because nothing read it.

So the working rule here is: **a test is not done when it passes, it is done when it has been watched to fail.** Every fix in the later phases was mutation-verified — break the code deliberately, confirm the intended test goes red, revert.

That discipline is also why `tsx` shipping esbuild `keepNames` while vitest does not — meaning every serialized `page.evaluate` body under test *was not the body that ships* — was caught by a guard that now walks `src/`, applies the shipping transform, and checks each callback survives in a scope as bare as the page's.

---

## Layout

```
src/observe/     what the model sees — snapshot, visibility, opaque handles
src/discover/    the loop, tool vocabulary, model-driver seam, budget, cassettes
src/artifact/    schema, record-time proving, the capability store
src/surface/     resolver with the tier ladder, actor gated on the resolved element
src/policy/      allowlist, risk, redaction — one gate every path calls
src/session/     the seam where credentials live; capabilities never authenticate
src/evidence/    append-only JSONL whose runId and timestamp cannot be forged
capabilities/    recorded artifacts, one file per version, human-diffable
```

---

## Not built yet, deliberately

Human-in-the-loop lease and operator console (Phase 4). Cross-tenant overlay demonstration — `applyOverlay` enforces the invariant that a tenant may modify bindings only, but no second tenant has been recorded against. Desktop surface adapter — the `Surface` seam exists to make it credible without building it.

Two limits worth naming rather than discovering. A single-rung binding has nothing to corroborate it, and reports so. And correlated drift — where a whole page moves together and every rung agrees on the wrong element — is not closable with the evidence an artifact holds.

[REPORT.md](./REPORT.md) is the submission write-up and is assigned to Phase 4, once there is a whole system to describe.
