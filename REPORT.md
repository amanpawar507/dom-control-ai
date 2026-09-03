# Design write-up

An LLM drives a bank UI once. What it learned becomes a typed artifact that replays deterministically, with no model in the loop.

## 1. Architecture

Back-office banking software has no API, a legacy UI, real error states, and many institutions running the same vendor product. An agent that re-reasons its way through such a screen on every invocation is slow, expensive, and irreproducible. So the problem is split in two: **discovery** happens once under a model, **replay** happens forever without one.

```
observe/    what the model sees — semantic snapshot, opaque handles, visibility
discover/   the loop, tool vocabulary, model-driver seam, budget, cassettes
artifact/   schema, record-time proving, the capability store
surface/    resolver with the tier ladder, actor gated on the resolved element
replay/     loading, corroborated identity, conditions, recovery, the engine
policy/     allowlist, risk, redaction — one decision function every path calls
session/    the seam where credentials live; capabilities never authenticate
evidence/   append-only JSONL whose runId and timestamp cannot be forged
```

Four decisions carry the design.

**The model never receives a selector.** It gets roles, names and opaque handles (`o3n17`). It cannot smuggle a brittle CSS string into a recording because it was never given one — which is what makes record-time proving meaningful rather than decorative.

**Handles expire structurally.** Each observation clears prior stamps and renumbers with a new epoch, so a handle held across turns matches *nothing* rather than silently resolving to a different element. No call site has to remember to check. An earlier version relied on callers being careful; that is not enforcement.

**One decision function, called by every path that acts.** There are two *act* paths — discovery addresses by observation handle, replay by proven binding — and merging them would undo the namespace separation above. What matters is that both consult the same `gate()`, pinned by a test that fails if any module drives a page without calling it.

**A `ModelDriver` seam, not a direct API call.** The loop calls an interface. Scripted drivers exercise every stopping condition at zero cost; a cassette replays one real exchange to guard the wire shape. Eleven of twelve implementation tasks in the discovery phase were built and tested for **$0.00**, and total spend across the project is **$0.55**.

The trade-off worth naming: discovery is expensive and non-deterministic by nature, so everything valuable must be extracted from it *once* and frozen. That pushes complexity into the artifact and into proving — which is where it belongs, because that is the part a human can review.

## 2. Artifact schema

Three blocks, separated by what varies:

| Block | Contains | Varies by |
|---|---|---|
| `capability` | id, version, goal, inputs, outputs, status | vendor product |
| `flow` | the steps — act, extract, checkpoint, navigate | nothing; shared across tenants |
| `bindings` | `entryUrl` and a targeting chain per control | tenant and variant |

The **overlay invariant** falls out of that: a tenant override may modify `bindings` only, enforced at load time and by construction — `capability` and `flow` carry no tenant-scoped field and every block is closed to unknown keys. A tenant that could edit the logic is a fork wearing an overlay's name.

`entryUrl` lives in `bindings` for the same reason: tenant A's install is not at tenant B's host, so a starting URL in `capability` would make one tenant's hostname part of a contract the others inherit.

Two details do most of the work.

**Values are parameters, never literals.** The recorder cannot distinguish a password field from a search box — on this target the password input has no accessible name at all, so no denylist could catch it. Recording every typed value as `$parameter` costs replay an argument; that is the price of a credential never reaching a committed file.

**Tier 4 is unrepresentable.** The strategy union admits tiers 0–3 only, so a visual/model-assisted strategy is a compile error rather than a runtime rejection. Replay cannot improvise, by construction.

Storage is one file per version under `capabilities/<product>/<id>/<version>.json`, human-diffable and in git — so a change to a binding is reviewable in a pull request. A version is immutable once `approved`; re-recording a draft is ordinary.

## 3. Determinism & error handling

**Exactly one match, or fail.** Never the first of several — proven against captured fixtures carrying four identically-named buttons, where the assertion is that resolution *fails*.

**Targeting is a recorded ladder**: test-id, role+name, DOM/CSS, anchor-relative geometry. Order is recorded per binding by what proved unique at record time, not fixed globally — on this target that usually yields anchor-first, because it associates no labels with its inputs.

**Record-time proving** verifies each strategy resolves uniquely *and to the same element* the model touched. An earlier version proved only uniqueness, and a strategy landing on exactly one *wrong* element passes that test.

**Replay-time corroboration** is the counterpart, and closing it was the replay phase's central task. Proving happens at record time; replay runs months later against a page that may have moved, and its only guard was a `tag` fingerprint — which tier 3 defeats *by construction*, since `accepts: [tag]` guarantees a wrong element carries the right tag. The chain answers it: every rung was independently proven against one element, so **two rungs naming different elements is evidence the surface moved**, and neither answer can be trusted. The ladder becomes a corroboration set, using evidence the artifact already holds.

**Runtime conditions** are declared, classified and given a response — three business, four recoverable. Every detector is visibility-gated (this target ships hidden success *and* error nodes), and every recovery is bounded. Recovery is judged by the triggering condition being *gone*, not by the recovery reporting success: a session provider can refresh a token perfectly and leave the login screen exactly where it was.

**Four result shapes.** A business outcome is a successful call carrying a code — "no such account" is the answer a caller asked for, not a crash.

**Determinism is evidenced, and the instrument was calibrated first.** Twenty live runs agreeing on status and on resolved tier per control proves less than it looks: a weak instrument returning a clean result is not evidence. So a known fault was induced first — removing a load-bearing wait produced `agreed: false`, two failures in twenty, four divergences *named* rather than averaged into a pass rate. The honest claim is therefore: *an instrument demonstrated capable of detecting a fault of this size reported no divergence across twenty runs.*

## 4. Heterogeneity & multi-tenant

`Surface` is a three-method seam — observe, act, resolve. The web implementation is Playwright; a desktop adapter implements the same interface against the OS accessibility API and nothing above it changes. That seam is the heterogeneity argument, and it is deliberately an argument rather than a demonstration: a second adapter was cut.

The legacy/modern split is handled by the ladder rather than by branching. A modern surface with test ids records tier-0-first chains; this legacy target records anchor-first ones. Same machinery, different recorded order — and the order is evidence, not configuration.

Multi-tenancy is the three-block split plus the overlay invariant. One recorded `flow` serves every institution running the vendor product; each supplies only its `bindings`. Sparse by design — an overlay names only the controls whose markup differs, because requiring a full restatement makes the overlay a copy, and copies drift.

## 5. Escalation & handoff

Discovery halts on ten named conditions — max steps, wall clock, dead end, model-stuck, policy refusal, budget, unverified checkpoint, unusable model output, unprovable control, unknown entry — and **never records a partial artifact**. There is no incremental sink to leave half-written, so that property holds by construction rather than by each path remembering to clean up.

Replay escalates rather than improvising: when the ladder is exhausted, when a chain disagrees with itself, or when an irreversible action is reached. Irreversible actions **escalate to a human rather than being silently forbidden** — a system that quietly refuses is one operators route around.

The control lease and the operator console are cut (§7). What exists is the boundary they would attach to: every halt is classified, every run leaves an append-only trail carrying which control resolved at which tier and how many rungs corroborated it, and a failure names the step, the expectation and what was observed.

## 6. Safety

**The gate runs before the action, keyed on the resolved element** — not on a name the caller supplies. An earlier version classified risk from a caller-supplied string with no connection to the element being clicked, so `act({click, handle: cleanHandle}, null)` returned `allow`. Classification is now monotone in the element's own names: a caller's label can narrow a verdict, never widen it.

**Credentials never reach a capability.** The `SessionProvider` is the only module that sees one; what crosses back is a storage state. Typed values are parameters. Session tokens are stripped at perception — not redacted at the sink — so every consumer inherits a working, token-free URL.

**Guard the act, not the doorway.** A guarded list naming navigation links is not a guardrail: a live run moved real fixture money through a gate returning `allow/safe` at every step, because the link was called `Bill Pay` and the button was called `Send Payment`. Submit controls are named now.

### Limits

Corroboration proves *consistency*, not correctness. A single-rung binding has nothing to corroborate it and reports `agreed: 1` rather than pretending otherwise. Correlated drift — a page that moves as a whole, where every rung agrees on the wrong element — is not closable with the evidence an artifact holds.

The observation walks controls plus headings and status regions, not all page text. That bounds token cost and is why a checkpoint can now certify an outcome; it also means content outside those shapes is invisible.

## 7. Cuts

Deliberately not built: the control lease and operator console; a second `Surface` adapter; a cross-tenant overlay demonstration (the invariant is enforced and tested, but no second tenant has been recorded); queues and service decomposition; a secrets manager behind the existing `SessionProvider` seam; open-ended LLM recovery during replay, which is a policy boundary rather than a limitation.

What would come next, in order:

1. **Replay-time identity beyond corroboration.** Consistency is not correctness; correlated drift needs a second, independent source.
2. **The lease.** Escalation currently ends a run. A human taking control of the live session and handing it back — with checkpoint re-verification on resume — is the missing half.
3. **A second tenant**, to convert the overlay from an enforced invariant into a demonstration.
4. **Stability at scale** — more runs, separate processes and sessions, a target under load. Twenty runs at a 7% fault rate still miss it about a quarter of the time.

### A note on how this was built

The project shipped **nineteen** tests or claims that passed while proving the wrong thing — several found inside the code written to catch earlier ones, and two of them comments justified as "measured" from a single probe. The working rule that came out of it: **a test is not done when it passes, it is done when it has been watched to fail.** Every fix in the later phases was mutation-verified, with the mutation asserting its target was found, because a silent no-op produced a false green twice.

The full reasoning trail, including every judgment call and the errors made along the way, is in [`docs/design/2026-08-16-phase-1-decision-record.md`](docs/design/2026-08-16-phase-1-decision-record.md) and the design spec.
