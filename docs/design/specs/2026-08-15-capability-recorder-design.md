# Design: LLM-discovered, deterministically-replayed UI capabilities

**Status:** Approved — implementation not started
**Date:** 2026-08-15
**Revision:** 2 — adds session lifecycle, discovery loop, runtime-condition taxonomy, testing, traceability
**Scope:** Whole system

---

## 1. Problem

Back-office applications at banks and credit unions frequently expose no API. The
only integration surface is the UI a human operator drives. Using an LLM to
operate that UI on every invocation is slow, expensive, and non-reproducible.

This system separates the two concerns:

- **Discovery** — an LLM drives a live application once to accomplish a
  natural-language goal.
- **Replay** — the recorded flow re-executes deterministically, with no model in
  the decision loop, and returns typed outputs to its caller.

The recorded flow is a **capability**: a typed, versioned, reviewable artifact
that an agent invokes by name with typed arguments.

### Goals

1. Accept a goal plus a target and complete it via a real UI.
2. Emit a typed, versioned capability artifact from a successful run.
3. Replay that artifact deterministically with new inputs and return declared
   outputs.
4. Distinguish business outcomes, recoverable conditions, and hard failures in
   the result contract.
5. Escalate to a human on the same live session, and resume after handback.
6. Enforce an allowlist and never persist secrets or regulated data.

### Non-goals

- Automating applications that expose an API. API integration always wins.
- A production co-browsing operator console.
- Real multi-tenant infrastructure — queues, workers, tenant provisioning.
- Unattended recovery from an unrecognized UI state.

---

## 2. Target environment

Implementation targets **ParaBank** (`parasoft/parabank:baseline`) running
locally in Docker. It is a real third-party legacy banking application, not a
purpose-built stand-in, which means its pathologies were measured rather than
invented. All data is the image's own fixture data; no real credentials and no
real PII are used anywhere.

Findings from an accessibility-tree survey of the running application, each of
which drives a design decision below:

| Observation | Design consequence |
|---|---|
| Login, register, and lookup form inputs have **no accessible name** — labels are unassociated sibling text | Role+name cannot be the primary targeting strategy |
| Register form has **two `type="password"` inputs** distinguishable only by adjacent label | Anchor-relative resolution is required, not optional |
| Transfer page has **two comboboxes both named `13566`** — the accessible name is the *selected value* | Uniqueness assertion is load-bearing; names can be unstable |
| `findtrans.htm` has **four buttons named "Find Transactions"**, each running a different query | Ambiguous match must fail, never silently pick the first |
| Account tables expose **no `row`/`cell`/`columnheader` roles** — a flat run of generic nodes | Extraction needs its own strategy, separate from targeting |
| Pages ship **hidden `Transfer Complete!`, validation-error, and `Error!` nodes** present in the tree before any interaction | Every detector and checkpoint must be visibility-gated |
| `;jsessionid=…` appears in hrefs until the session cookie round-trips, then disappears | URL-keyed locators and checkpoints are unsound; session tokens need redaction |
| Account links carry concrete ids — `activity.htm?id=13566` | Recorded routes are canonicalized to `activity.htm?id=:accountId` |
| `admin.htm` is reachable unauthenticated and exposes `Clean` (drops the database) and `Shutdown` | Concrete irreversible actions reachable during discovery |
| The application requires login, and sessions expire | Replay needs a session it does not own — see §5 |

Fault injection uses the application's own admin console — database clean for
not-found, JMS shutdown and out-of-order deep links for backend errors, and
balance/threshold settings for validation errors. No injection harness is built.

Parasoft publishes `baseline` and `feature` variants of the same image. These
serve as two tenants running the same vendor product at different versions.

---

## 3. Architecture

Discovery and replay have opposing requirements — discovery needs generality and
runs once; replay needs determinism and only ever executes flows already
recorded. They are therefore separate engines sharing exactly three things: the
action vocabulary, the policy gate, and the session provider.

```
src/
  surface/          THE SURFACE SEAM
    types.ts          Surface = { observe(), act(), resolve() }
    playwright-web/
      observer.ts     ARIA snapshot + visibility + geometry
      resolver.ts     binding chain -> element          (replay only)
      actor.ts        dispatch primitive actions

  session/          THE AUTHENTICATION SEAM
    provider.ts       SessionProvider = { acquire(), refresh(), release() }
    playwright-state/ storage-state acquisition; credentials never leave it

  capability/       THE ARTIFACT
    schema.ts         Zod definitions; JSON Schema derived from them
    io.ts             load, validate, version-check
    overlay.ts        tenant overlay merge

  discover/         MODEL IN THE LOOP
    loop.ts           observe -> decide -> act, via SDK tool runner
    tools.ts          the model's action vocabulary
    recorder.ts       successful trace -> capability, proving every binding

  replay/           NO MODEL
    engine.ts         step walker
    detect.ts         outcome and recovery detection (visibility-gated)
    extract.ts        typed output extraction
    result.ts         result contract

  policy/           SHARED GATE — all engines pass through
    allowlist.ts · risk.ts · redact.ts

  escalate/         lease.ts · intervention.ts
  console/          local web app: capability catalog, invoke, intervention inbox
  evidence/         logger.ts (JSONL) · capture.ts
```

### The four boundaries that carry the design

**`Surface`** — three methods, one implementation today. A desktop adapter
implements the same interface against the OS accessibility API; nothing above it
changes. This is the heterogeneity seam.

**`SessionProvider`** — replay never authenticates. See §5.

**`policy`** — a single choke point every engine calls before every action. One
place to audit, and simultaneously the allowlist, the risk gate, and the
escalation trigger.

**`recorder`** — enforces the invariant that **the model never writes a
locator**. During discovery the model targets opaque `ref` handles from the
observation. The recorder then takes each chosen handle, tries every strategy
against the live page, keeps only those that resolve uniquely, and writes them as
a proven chain. That indirection is what makes deterministic replay achievable:
the model's guesswork never becomes a durable dependency.

### Replay data flow

```
capability + inputs
  -> validate inputs against schema
  -> acquire session via SessionProvider
  -> per step:
       reveal (if declared)
       resolve binding chain  — assert unique, assert fingerprint, assert stable
       detect interrupts      — visibility-gated
       policy check
       act
       verify postcondition
  -> final checkpoint
  -> extract outputs
  -> result
```

### Stack, and why

| Choice | Rationale |
|---|---|
| TypeScript + Zod | The schema is the centrepiece. Zod gives runtime validation and derives the JSON Schema for the agent-facing contract from one definition — no second source of truth to drift. |
| Playwright | Pierces frames and shadow roots, exposes ARIA snapshots and element geometry (both tiers need it), ships tracing, and supports headed mode — which the live-session handoff in §7 requires. |
| Claude Sonnet 5 | Adaptive thinking on by default; tool-calling loop via the SDK tool runner, whose per-turn hooks are where the policy gate belongs. Model id is config, not code. |
| Single process | The brief does not reward scaling infrastructure, and nothing here needs it. Boundaries are drawn so services could be split later without reshaping the artifact. |

---

## 4. Capability artifact

Three blocks with three different scopes. That separation is the design.

```jsonc
{
  "schemaVersion": "1.0.0",

  "capability": {                        // THE CONTRACT — per vendor product
    "id": "parabank.account.read-balance",
    "version": "1.0.0",
    "status": "draft",                   // draft | approved
    "product": { "name": "parabank", "variant": "baseline" },
    "surface": "web",
    "requires": { "session": "authenticated" }
  },

  "inputs":  { "accountId": { "type": "string", "pattern": "^\\d{5}$" } },
  "outputs": { "balance":   { "type": "number", "unit": "USD" } },

  "flow": [                              // THE LOGIC — shared across tenants
    { "id": "s1", "intent": "Open Accounts Overview",
      "action": { "type": "click" }, "control": "nav_accounts_overview",
      "risk": "safe",
      "expect": { "control": "overview_heading", "state": "visible" } },

    { "id": "s2", "intent": "Read the balance for the requested account",
      "action": { "type": "extract", "into": "balance", "as": "currency" },
      "control": "account_row_balance",
      "args": { "accountId": { "$input": "accountId" } } }
  ],

  "bindings": {                          // THE SURFACE — per tenant / variant
    "account_row_balance": {
      "scope": [ { "kind": "frame", "name": "main" } ],
      "reveal": null,
      "chain": [
        { "tier": 3, "by": "row-anchor", "anchor": { "$arg": "accountId" },
          "scope": "table", "column": "Balance*", "provenUnique": true }
      ],
      "fingerprint": { "matches": "^\\$[0-9,]+\\.[0-9]{2}$", "stableFor": "250ms" }
    }
  },

  "checkpoint": { "control": "overview_heading", "state": "visible" },
  "outcomes":   [ /* see §7 */ ],
  "recoveries": [ /* see §7 */ ],

  "provenance": { "recordedAt": "…", "model": "…", "runId": "…",
                  "surfaceDigest": "parabank:baseline@sha256:…",
                  "redacted": true }
}
```

### Design decisions

**Flow references controls semantically; bindings resolve them.** The flow
contains no selector. This is what makes tenant reuse an overlay instead of a
fork.

**`"state": "visible"` is mandatory on every detector and checkpoint.** Direct
consequence of hidden success and error nodes in the target application. Encoded
in the schema so it cannot be forgotten in an ad-hoc detector.

**`provenUnique` and `fingerprint`.** Every strategy in the file was proven to
resolve uniquely at record time. At replay, a match that fails its fingerprint is
a hard failure — this is the guard against resolving *an* element rather than
*the* element, which the two identically-named comboboxes make a live risk.
`stableFor` additionally rejects a value that is still settling.

**Bindings take arguments** (`$arg`), so one binding expresses "the Balance cell
in the row for account X" rather than one binding per account.

**`scope` is a path, not a frame name.** Nested browsing contexts of any kind —
framesets, iframes, shadow roots — are expressed the same way.

**`reveal` is a declared phase.** Some controls do not exist until revealed:
virtualized grids, paginated tables, collapsed sections. Recording the reveal
rather than improvising it keeps replay deterministic.

**`requires.session`** declares the precondition rather than embedding a login
flow. See §5.

**Routes are canonicalized at record time.** `activity.htm?id=13566` is stored as
`activity.htm?id=:accountId`, bound to an input. A concrete id recorded from one
session is never replayed literally.

**`risk` per step** drives the policy gate and the escalation trigger from one
field.

**`surfaceDigest`** records the exact image the capability was proven against,
giving the cross-variant drift check a reference point.

### Storage and serialization

```
capabilities/
  parabank/
    account.read-balance/
      1.0.0.json                 # immutable once status = approved
      1.1.0.json
  _schema/
    capability.schema.json       # derived from Zod, committed for consumers
overlays/
  feature/
    account.read-balance.json    # bindings only
```

JSON, one file per version, human-diffable. A version is immutable once
`approved`; changes cut a new version. The derived JSON Schema is committed so an
agent runtime can validate arguments without importing our code.

### Overlay invariant

A tenant override may modify `bindings` only. `flow`, `inputs`, and `outputs` are
immutable in an overlay.

```jsonc
{ "extends": "parabank.account.read-balance@1.0.0",
  "product": { "variant": "feature" },
  "bindings": { "nav_accounts_overview": { "chain": [ /* … */ ] } } }
```

If a variant needs a different *flow*, that is a new capability, not an override.
Without this invariant, "overlay" degrades into "fork".

---

## 5. Session lifecycle

Replay is invoked by an agent in production with no browser and no session. The
target requires authentication. Two constraints collide: something must
authenticate, and nothing may persist credentials or tokens into an artifact or a
log.

**Capabilities never authenticate.** A capability declares
`requires: { session: "authenticated" }` and receives an already-authenticated
context from an injected `SessionProvider`:

```ts
interface SessionProvider {
  acquire(product: string, tenant: string): Promise<AuthenticatedContext>;
  refresh(ctx: AuthenticatedContext): Promise<AuthenticatedContext>;
  release(ctx: AuthenticatedContext): Promise<void>;
}
```

Consequences:

- **Credentials stay in one module** that the artifact layer cannot reach. No
  capability, overlay, log line, or evidence file can contain one.
- **Session expiry becomes recoverable rather than fatal.** Detecting a login
  screen where a checkpoint was expected triggers `refresh()`, re-verification of
  the last passed checkpoint, and resumption — the mechanism in §7, not a special
  case.
- **The seam matches production reality.** In a real deployment the agent
  platform already holds institution credentials; capabilities are the wrong
  place to duplicate that responsibility.

The local implementation acquires a Playwright storage state against the
container's fixture account. A production implementation would fetch from a
secrets manager behind the same interface, with no change above the seam.

---

## 6. Discovery loop

**Input.** A goal in natural language plus a target — application id and entry
URL. The target resolves an allowlist and a `SessionProvider` binding.

**Structure.** A small per-turn loop drives a typed vocabulary. *(Revised after
implementation: this said "the SDK tool runner drives the loop". It does not.
The runner owns the agent loop, and ours has three per-turn obligations the
runner has no seam for — gate an action before it executes, prove each touched
control into a binding before recording it, and re-observe between turns.
Adopting it would also dissolve the `ModelDriver` seam the loop calls instead
of calling Anthropic, and that seam is what let eleven of twelve implementation
tasks be built and tested for nothing. We call `messages.create` per turn.)*

| Tool | Purpose |
|---|---|
| `observe` | Return the current semantic snapshot |

*(Revised: `observe` took a `screenshot` flag, the loop discarded it, and no
screenshot was ever taken — the model was offered a parameter that did nothing.
Removed rather than implemented, because a screenshot lets the model **see**
page content but not **address** it: handles are minted for controls only, so a
model could read a balance off an image and still have no handle to `extract`
it. It returns when content nodes get handles, which is the same change that
lets a checkpoint certify an outcome rather than an element's existence.)*
| `click` · `fill` · `select` · `navigate` | Act on a handle from the last observation |
| `extract` | Mark a value as a declared output |
| `done` | Assert the goal is met, naming the checkpoint that proves it |
| `stuck` | Declare a dead end, with a reason |

Every observation carries opaque handles; the model addresses handles and never
writes a locator. The policy gate runs in the tool runner's per-turn hook —
before execution, not after.

**Prompting.** The system prompt carries the goal, the allowlist in force, the
risk classes and what happens at each, and the instruction to call `stuck` rather
than guess when the next step is not evident. Step history is kept in the message
thread; the observation is refreshed each turn rather than accumulated, so
context stays bounded on long flows.

**What the model can see, and what follows from it.** The observation walks
**controls** — things that can be clicked, filled, or read as a label — not page
content. That keeps the snapshot small and the token cost bounded, and it is the
right default. It also has two consequences that were discovered by running this
against a real application and belong here rather than in a report:

A goal whose target is page *content* cannot be expressed. On the reference
target, account balances render in bare table cells, so "find the account
balance" is not a goal this loop can pursue — the model cannot see the answer
and could only fail or invent one. It bounds what `extract` can ever return.

More sharply, it caps how strong a *checkpoint* can be. A checkpoint names
something the model observed, so it can only ever name a control. On a flow
whose real success condition is "the transaction list now shows debits only",
the strongest available checkpoint is the dropdown that was set — which holds
whether or not the list changed. A checkpoint asserting only that an element
resolves and is rendered is barely stronger than none, and a capability whose
checkpoint cannot fail will report success at replay no matter what happened.
Checkpoints therefore need an expected *state*, and the observer needs a way to
see rendered text, before a recorded capability can certify a business outcome.

**Stopping conditions.** The loop halts on any of:

| Condition | Threshold | Result |
|---|---|---|
| Goal reached | `done` called and checkpoint verified | Record artifact |
| Max steps | configurable, default 40 | Escalate |
| Wall clock | configurable, default 10 min | Escalate |
| Dead end | no observable state change across 3 consecutive actions | Escalate |
| Model declares stuck | `stuck` called | Escalate |
| Policy refusal | action outside allowlist, or `irreversible` | Escalate |

Every halt that is not "goal reached" raises an intervention (§7). Discovery
never fails silently and never records a partial artifact.

---

## 7. Determinism & error handling

### Perception

The observation given to the model is a compact semantic snapshot plus a
semantic snapshot, with each node addressed by an opaque handle. No screenshot
— see the note on the tool table in §6.

Note that in a browser the accessibility tree is *derived from the DOM* — on a
legacy application it is exactly as impoverished as the markup. It is used for
token economy and because the same abstraction exists on desktop, not because it
solves the no-clean-DOM problem.

### Targeting tiers

Tier order is **recorded per binding**, decided by what proved unique at record
time — not fixed globally. On this target that usually yields anchor-first; on a
modern application with test IDs it would yield tier 0 first. Same machinery.

| Tier | Strategy | Replay-legal |
|---|---|---|
| 0 | Test ID / stable app attribute | yes |
| 1 | Role + accessible name | yes |
| 2 | DOM / structural | yes |
| 3 | Anchor-relative geometry | yes |
| 4 | Visual / model-assisted | **no** |

**Tier 4 exists only in discovery and escalation.** When replay exhausts tiers
0–3 it stops and escalates rather than improvising. That single rule is what
makes "deterministic replay" a claim rather than a hope, and it places the
determinism guarantee, the safety boundary, and the escalation trigger at the
same seam.

### Resolution rules

1. Exactly one match, or fail. Never take the first of several.
2. Fixed chain order. No scoring or best-match at replay time.
3. Fingerprint and stability must both hold.
4. Condition-based waits with explicit budgets. No sleeps.

**What a fingerprint is for.** A fingerprint answers one question: *is this the
kind of thing I recorded?* It is a shape check on the resolved node — element
type, attributes, and for extracted text the format class (currency, date,
account number). It catches a surface change that leaves the binding resolving
to a structurally different node.

Two things it is explicitly **not**. It is not a row- or record-identity check —
that is the binding's job, and a fingerprint narrow enough to identify one record
would fail on every other record the same capability is meant to handle. And it
is not a business-range assertion. A fingerprint that encodes what a value *ought
to be* rather than what shape it takes converts a legitimate business state into
a resolution failure — an overdrawn balance reported as a broken selector. That
is a worse failure than the one the fingerprint prevents, because it is
misattributed: the operator is sent to debug a targeting problem that does not
exist. Currency fingerprints therefore accept the sign.

### Runtime conditions

The environment produces a known set of exceptional states. Each is declared in
the artifact, classified, and given a response. The mechanism is uniform; only
the data differs.

| Condition | Class | Detection | Response |
|---|---|---|---|
| Validation error | business | Visible field-level error region | Terminal outcome with code and message |
| Record not found | business | Visible empty-result text | Terminal outcome |
| Permission denial | business | Visible denial, or redirect to an unauthorized view | Terminal outcome — the caller needs this answer |
| Unexpected dialog | recoverable | Visible dialog not named in the flow | Dismiss per declared recovery, bounded by `maxAttempts` |
| Session expiry | recoverable | Login screen where a checkpoint was expected | `SessionProvider.refresh()`, re-verify last checkpoint, resume |
| Transient slowness | recoverable | Checkpoint unmet within its budget | One bounded re-wait, then escalate |
| Application error | recoverable → hard | Visible error banner | Renavigate once; if it persists, hard failure |

Two rules make the table honest. Every detector is **visibility-gated** —
non-negotiable after finding that the target ships hidden success and error nodes
in the tree. And every recovery is **bounded**; an unbounded retry is a hang
wearing a costume.

### Result contract

```ts
type ReplayResult =
  | { status: "success";          outputs: TOut;  evidence: Evidence }
  | { status: "business_outcome"; code: string;   message: string; evidence: Evidence }
  | { status: "escalated";        interventionId: string; reason: string; evidence: Evidence }
  | { status: "failed";           stepId: string; expected: string; observed: string;
                                  classification: FailureKind; evidence: Evidence }
```

A business outcome is a successful call carrying an outcome code. "No such
account" is an answer the caller asked for, not a crash.

### Stability harness

Replay N times and report which tier resolved each control on each run. A control
that resolves via a different tier across runs is a drift or flake signal. This
is how determinism is evidenced rather than asserted.

---

## 8. Escalation & handoff

**Detect.** Five mechanical triggers, spanning both engines:

| Trigger | Engine |
|---|---|
| Discovery halts without reaching the goal (§6) | Discovery |
| Binding chain exhausted | Replay |
| Checkpoint budget expired after bounded retry | Replay |
| Unclassified visible dialog | Replay |
| Step marked `risk: "irreversible"` | Both |

**Route.** An intervention record carries the capability or goal, the step,
the reason and the current ARIA snapshot. (An escalation is the one place a
screenshot would earn its cost, since a human is about to look at it — not yet
built; see §6.)

**Transfer.** A lease — a single `controller: "automation" | "human"` value.
Automation awaits the lease rather than acting. The browser is headed and
visible, so the operator uses the same live session directly; no co-browsing
infrastructure is required.

**Hand back.** On resume, automation re-verifies a checkpoint *before* acting.
The human may have navigated elsewhere, and continuing from a stale assumption is
the failure this design exists to prevent.

**Record.** The ARIA snapshot is diffed across the handoff window and logged as
the human's contribution to the run. On a discovery escalation, the human's
demonstrated steps are recorded into the artifact under construction.

The operator surface is a local web page listing open interventions with take-
control and resume. It is the same application that serves the capability catalog
(§10). It is deliberately minimal — the handoff mechanism is real, the operator's
screen is not.

---

## 9. Safety

**Allowlist** of origins, path patterns, and action types, enforced inside
`gate()` in `policy/gate.ts`. *(Revised after implementation: this named
`executor.dispatch`, an identifier that exists nowhere in the tree.)*

There are two **act** paths — discovery addresses an element by the observation
handle the model was given, replay by a proven binding — and that is correct:
those namespaces are deliberately separate, because a handle is valid only for
the observation that minted it. What the claim requires is narrower and does
hold: one **decision** function, called by every path that acts. The failure
mode is not two act paths; it is a third added later that decides for itself,
so the property is pinned by test rather than asserted here — exactly one `gate`
implementation, no module that drives the page without calling it, and an
exemption list that has to justify itself.

**Risk tiers.**

| Tier | Examples on this target | Handling |
|---|---|---|
| `safe` | Reads, in-allowlist navigation | Runs freely |
| `guarded` | Submitting a form that mutates state | Requires `status: "approved"` |
| `irreversible` | `Database → Clean`, `JMS → Shutdown`, funds transfer | Always escalates |

Routing irreversible actions to escalation makes the safety model and the
handoff model one mechanism rather than two.

**Redaction at the observation boundary.** The redactor sits at perception, not
at the log sink: a sensitive value never enters the pipeline, so there is no sink
that can leak it. Concrete cases on this target are `;jsessionid=` session tokens
in hrefs, the `SSN` field on the registration form, and any input declared
`sensitive` in the schema. Credentials never reach this layer at all — they are
confined to `session/` (§5).

**Limits.** Pattern-based redaction is a backstop, not a guarantee — it catches
shapes it knows. Allowlisting constrains where the agent may act, not what a
compromised page may render. Neither defends against a target application that
lies about its own state. The `approved` gate is an honest-actor control: it
stops an unreviewed capability from running unattended, not a malicious one from
being written.

Fault injection runs only against the local container. The public ParaBank
instance shares one database across all users; destructive admin actions are
never fired at it.

---

## 10. Invocation surface

A local web application with three views:

- **Catalog** — capabilities with their typed input and output schemas.
- **Invoke** — typed argument form, replay, structured result.
- **Interventions** — open escalations, take control, resume.

The same JSON Schema derived from the artifact drives the invocation form and
would drive an agent's tool definition. Nothing about the contract is
UI-specific.

---

## 11. Evidence & testing

### Evidence

`evidence/<runId>/` contains a JSONL structured log, a per-step ARIA snapshot and
resolved-tier telemetry, and the final artifact or result. Failures
capture additional context. Discovery logs record the model's stated reason for
each action alongside the action itself — the "what and why" — which requires
requesting summarized thinking explicitly, since the default omits it.

### Testing

Tests target the pieces where a silent regression would be invisible:

| Under test | Why it earns a test |
|---|---|
| Schema round-trip and JSON Schema derivation | The contract is the product; drift between Zod and derived schema is silent |
| Resolver, per tier, against saved DOM fixtures | Fixtures captured from the real application, including the four identically-named buttons — the assertion is that resolution **fails**, not that it picks one |
| Visibility gating | Fixture containing a hidden success node; the detector must not fire |
| Overlay merge | Bindings-only merges apply; a flow or contract override is rejected |
| Outcome classification | Each of the seven runtime conditions maps to its declared class |
| Input validation | Arguments failing the declared schema are rejected before the browser opens |

**What fixture testing cannot cover.** Tier 3 resolves against *rendered* layout,
and rendered layout depends on CSS. A saved HTML fixture does not load its
stylesheets, so an offline fixture only reproduces label/control adjacency that
is already inline in the markup. Layouts positioned by CSS — a table-based form,
a flex row, anything where the visual relationship is not the document
relationship — collapse to vertical stacking in the fixture and cannot be
asserted there. The consequence is a real coverage boundary, not a test-harness
inconvenience: geometry is the tier most likely to break on a surface change, and
it is the tier fixtures test least. Tier-3 coverage therefore requires either a
served page or fixtures captured with computed styles, and until one exists,
tier-3 tests carry an honest asterisk. Tiers 0–2 read the DOM and are unaffected.

Not unit-tested: the discovery loop. Its correctness is demonstrated by evidence
from a real run, which is the only honest way to assess it.

---

## 12. Heterogeneity & multi-tenant

**Other surfaces.** The `Surface` interface is the seam. A desktop adapter
implements `observe`/`act`/`resolve` against the OS accessibility API; flow and
contract are untouched, and only `bindings` differ. A terminal-emulator adapter
resolves by row and column against a character grid.

**Modern web applications** push on `bindings` only — `scope` covers shadow
roots, `reveal` covers virtualized grids, `fingerprint.stableFor` covers
optimistic UI. That the modern-framework case required no change to flow or
contract is evidence the seam is in the right place.

**Known limit.** Canvas-rendered and pixel-only surfaces — published desktop
sessions, canvas grids — have no tree to bind to. Tiers 0–3 have nothing to
resolve and tier 4 is gated out of replay by policy. They can be discovered and
escalated, but cannot become unattended capabilities. Stated rather than papered
over.

**Demonstrated versus designed.** Web is implemented and demonstrated, including
two variants of one vendor product. Desktop and terminal adapters are designed
against the same seam but not built. That line is drawn deliberately and is worth
stating plainly rather than letting the design story imply more coverage than
exists.

### Detecting and managing drift

**Detect.** Every replay records which tier resolved each control. A binding that
resolves below its recorded tier — primary failed, a fallback carried the step —
emits a degradation signal naming the control, the tenant, and the variant. Drift
is therefore located per control, not per capability.

**Manage.** Degradation drives a defined response rather than a dashboard:

| Signal | Response |
|---|---|
| One control degrades on one tenant | Log; capability continues |
| A control degrades on every run for a tenant | Emit a re-record request for that binding only; the flow is untouched |
| Any control fails its full chain | Capability flips out of `approved` for that tenant, which the §9 risk gate already blocks unattended replay on |
| A control degrades across all tenants of a product | The vendor shipped a change; the base bindings need re-recording, not the overlays |

Re-recording a binding is a single-control discovery run, not a re-recording of
the capability.

---

## 13. Alternatives considered

**Explicit state graph instead of a linear flow.** Handles branching natively,
but the discovery run produces a linear trace — a graph would be structure
inferred from a path never observed. Triples the schema, complicates review, and
breaks sparse per-tenant overlays. Unexpected dialogs and business outcomes are
better modelled as interrupts than as graph edges. Revisit when flows need
genuine conditionals or sub-capability composition.

**Compiling artifacts to Playwright code.** Maximum expressiveness, but each
tenant becomes a forked script — the rebuild-per-tenant outcome the design exists
to avoid — and the error taxonomy scatters into control flow instead of sitting
in one auditable place. Code generation remains available later as a *view* over
the artifact.

**Replay performing its own login.** Simplest to build and wrong on both axes: it
puts credentials in reach of the artifact layer, and it makes every capability
carry an authentication flow that has nothing to do with what the capability
does. The `SessionProvider` seam costs one interface and removes both problems.

**Building a purpose-made target application.** Rejected after measuring
ParaBank: a real third-party application supplies harder and more credible
pathologies than invented ones, ships its own fault injection, and cannot be
accused of being shaped to fit the locator strategy.

---

## 14. Cuts, and what comes next

| Cut | Rationale | Next with more time |
|---|---|---|
| Production operator console | Lease and handoff are real; the operator's screen is minimal | Live view of the session, action timeline, multi-operator queue |
| Desktop surface implementation | Designed; the `Surface` seam is what makes it credible | macOS accessibility adapter against a native app |
| Real multi-tenant infrastructure | One overlay demonstration instead | Tenant registry, per-tenant binding packs, drift dashboard |
| Queues, workers, service decomposition | Single process, deliberately | Split replay into a worker once concurrency demands it |
| Secret management | Environment variables plus redaction | `SessionProvider` backed by a secrets manager — the seam already exists |
| Open-ended LLM recovery during replay | Escalate instead; policy boundary, not a limitation | Bounded single-step recovery, policy-checked, recorded as evidence |
| Confidence scoring | Stability harness reports raw signal | Score capabilities by replay reliability; gate `approved` on the score |

### On stretch goals

Four of the brief's optional items fall out of the core design rather than being
added to it: the capability catalog is the invocation surface (§10), `draft →
approved` is the risk gate (§9), the cross-variant overlay is the multi-tenant
proof (§12), and the stability harness is how determinism is evidenced (§7).
Each is load-bearing for a core requirement. None is pursued for its own sake,
and none would be built if it were not.

---

## 15. Delivery

| Phase | Work | Exit criterion |
|---|---|---|
| 1 | Surface abstraction, session provider, schema, policy gate, target harness | Scripted run drives the target end to end, no model |
| 2 | Discovery loop, tool vocabulary, recorder, binding proving | A real model-driven run writes a valid artifact |
| 3 | Replay engine, runtime-condition taxonomy, stability harness, evidence | Success, business-outcome, and hard-failure replays recorded |
| 4 | Lease, console, cross-variant overlay, write-up | Full thread runs from a clean clone |

Optional, if phase 4 completes early: a second `Surface` adapter against the
macOS accessibility API, resolving the same semantic controls on a native
application. This converts §12 from a design argument into a demonstration.

---

## 16. Requirements traceability

Where each requirement in the brief is satisfied, and where each write-up heading
draws from.

| Requirement | Section |
|---|---|
| 3.1 Goal-driven agent loop | §6 |
| 3.2 Structured artifact | §4 |
| 3.3 Deterministic replay | §7 |
| 3.4 Safety & policy guardrails | §9 |
| 3.5 Evidence / observability | §11 |
| 3.6 Human-in-the-loop escalation | §8 |
| 3.7 Heterogeneity & scale | §12 |

| `REPORT.md` heading | Draws from |
|---|---|
| 1 Architecture | §3, §5 |
| 2 Artifact schema | §4 |
| 3 Determinism & error handling | §7 |
| 4 Heterogeneity & multi-tenant | §12 |
| 5 Escalation & handoff | §8 |
| 6 Safety | §9 |
| 7 Cuts | §14 |

---

## 17. Open questions

1. Which capability is recorded for the primary demonstration. The system is
   built for a class of back-office flows; the specific one is chosen at test
   time. It must have a typed input, a typed output, a natural not-found branch,
   and at least one irreversible neighbour.
2. Whether the anchor-relative resolver needs OCR for the desktop adapter, or
   whether the OS accessibility API supplies sufficient geometry.
3. Whether `reveal` needs a strategy beyond filter, scroll-until, paginate-until,
   and expand.
4. Whether a single `SessionProvider` per product is sufficient, or whether
   per-capability session scoping is needed for permission-differentiated flows.
