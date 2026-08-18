# Phase 1 decision record

Every judgment call made while building the deterministic substrate, why it was
made, and what it costs if it turns out wrong. Written during execution rather
than reconstructed afterward — the reasoning is what a reviewer cannot recover
from a diff.

**State at close:** 32 commits on `feat/agent-loop`. 100 unit tests
(container-free), 11 end-to-end, `tsc --noEmit` clean, `npm run smoke`
completes against a live ParaBank.

---

## 1. The pattern worth reading first

Phase 1 shipped **six** defects of a single shape: *something that looks
verified and is not.* They are listed here together because the pattern matters
more than any individual fix.

| # | What looked verified | What was actually true | Caught by |
|---|---|---|---|
| 1 | A test asserting an invalid CSS selector throws | Playwright's parser rejected `$` independently, so it passed before any implementation existed | Implementer |
| 2 | 21 green tests over the allowlist | `**` glob expansion was broken; no test used a nested path | Controller, reading the code |
| 3 | The `escalate` assertion on the irreversible control | A pure function of static config — it would pass if the button were clicked | Final review |
| 4 | The first fix for #3's tier ladder | Reported tier is the *winning* strategy's declared number; it reads 2 whether or not tier 0 was tried | Implementer, mutation-testing their own fix |
| 5 | The tier-order guard | Pinned *ascending* order, which spec §7 explicitly rejects — Phase 2's first anchor-first chain would delete it | Final review |
| 6 | The entire test suite | `tsx` ships with esbuild `keepNames`; vitest does not. Every serialized `page.evaluate` body under test **was not the body that ships** | Implementer, running the real entry point |

Number 6 is the one that changes practice. `npm run smoke` died on its first
click with `ReferenceError: __name is not defined` while every test was green,
because `keepNames` hoists inner named bindings into a module-scope helper that
a serialized callback cannot see. The suite had been exercising code that does
not ship.

**Standing rule adopted:** any function serialized into the page must be
verified through the *shipping* transform, not only under the test runner. This
is enforced by a guard that walks `src/`, discovers every such callback by AST,
and checks each survives in a scope as bare as the page's. It was proven by
reintroducing the defect, by adding a fifth callback in a file no test mentions
(discovered, and red), and by checking out the *previous* guard and running it
against the same defect — which passed, demonstrating its blindness rather than
arguing it.

The general lesson: **a test is not done when it passes, it is done when it has
been watched to fail.** Every fix in the final rounds was mutation-verified.

---

## 2. Safety and policy

**The irreversible gate is keyed on the resolved element, not the caller's
word.** Originally `act(action, controlName)` classified risk from a
caller-supplied string with no connection to `action.handle`, so
`act({click, handle: cleanHandle}, null)` returned `allow` and would have
dropped the database. `classifyRisk` now matches over a *set* of names: the
element's own names always go in, the caller's claim goes in alongside. This
makes classification monotone by construction — an added name can never lower a
tier — so a label can narrow a verdict and never widen it. Unclassifiable
actions refuse.
*Cost if wrong:* none identified; the property was verified exhaustively over
100 name-superset pairs and 15 adversarial claims.

**Irreversible actions escalate rather than being forbidden.** This is a design
claim, not an implementation detail: `Clean` routes to a human instead of being
silently blocked, because a system that quietly refuses is a system operators
route around.

**Redaction generalizes by position, not by pattern.** The original redactor
matched only the `;jsessionid=` URL form and missed `Set-Cookie:
JSESSIONID=` and Playwright storage state — the only two forms an authenticated
session actually produces. The replacement keys on structural position (a
`{name, value}` sibling pair), covering nesting, arrays, reordered keys, class
instances, and `localStorage`.
*Known residual:* a bare token with no surrounding structure is unredactable by
position and needs entropy detection or an allowlist. Phase 2 design question.

**An unbound `$placeholder` throws instead of passing through.** It previously
fell through as a literal into CSS and test-id selectors, where it could
silently match the wrong element. Same class as an over-permissive allowlist:
failing loudly is the only safe behavior at a targeting boundary.

**`acquire()` rejects a product it does not serve.** The signature implied
multi-tenant support the implementation did not provide, and a function that
silently ignores its arguments is a quiet lie. An explicit rejection turns it
into a declared constraint.
*Cost if wrong:* a caller passing an unexpected product gets a clear error
instead of the wrong tenant's session — the safer failure by a wide margin in
this domain.

**`binding.scope` refuses rather than resolving elsewhere.** It was accepted and
ignored, so a binding naming a nonexistent frame returned
`{ok:true, tier:2, handle}` against the top document. Frame descent is still
deferred to Phase 2; the guard is not. A wrong answer delivered confidently is
worse than a refusal.

---

## 3. Determinism

**Exactly one match, or fail.** Never `[0]` on a multi-match. Verified against
captured fixtures containing four identically-named buttons: the assertion is
that resolution *fails*, not that it picks one.

**Fixed chain order, pinned to what was recorded.** An earlier version asserted
*ascending* tier order, contradicting spec §7 — tier order is recorded per
binding and on this target usually yields anchor-first. The guard now pins the
chain against its recorded order, so the reorder mutant still fails while a
legitimate anchor-first chain passes.

**Fingerprints are shape checks.** A fingerprint answers *"is this the kind of
thing I recorded"* — element type, attributes, format class. It is explicitly
**not** a record-identity check (that is the binding's job) and **not** a
business-range assertion. Phase 1 shipped a currency fingerprint that rejected
negative balances, which would have reported a valid overdrawn account as a
resolution failure — sending an operator to debug a targeting problem that did
not exist. Currency fingerprints accept the sign.

**Condition-based waits with explicit budgets, no sleeps.** A discovered
subtlety: ParaBank's "Accounts Overview" heading is server-rendered and present
*before* the account XHR fills the table, so it is not a valid readiness signal.
Readiness now gates on the data.

**Failures are named.** A readiness timeout previously surfaced as Playwright's
own message — a `locator.waitFor` exceeding 20000ms, naming neither the control
nor the page. It now names both and keeps the original error as `cause`. An
anonymous timeout is what makes an on-call page expensive.

---

## 4. Evidence

**The evidence log's `runId` and `at` are not caller-overridable.** The original
spread `...event` last, letting any caller overwrite both — reproduced live as
`{"runId":"SPOOFED","at":{}}`. A JSONL trail whose lines are not attributable to
a run, in order, is not evidence.

**Run output is gitignored; the source module is not.** This reverses an earlier
ruling of mine that conflated `src/evidence/` (the logger, tracked) with
`evidence/<runId>/` (runtime output). Auto-committing unreviewed run output is a
leak vector: every run writes JSONL that would carry a token if redaction
regressed.
*Carried to Phase 4:* one curated, re-audited sample run must be committed
explicitly, so the observability claim has a visible artifact.

**Schema records the disagreement.** `controlName` became `claimedName` +
`controlNames`, so when a caller's belief about a control differs from the
element's own names, the evidence shows it.

---

## 5. Testing and fixtures

**Captured fixtures and synthetic fixtures live in separate directories.** The
captured-fixture rule exists so nobody hand-writes convenient markup and calls it
evidence. A geometry unit fixture makes no evidentiary claim and is a different
thing; keeping them physically separate preserves the distinction.
*Residual:* nothing structurally enforces that `tests/fixtures/synthetic/` stays
hand-authored — the separation is conventional.

**Fixture credentials come from `PARABANK_USER` / `PARABANK_PASS`.** Two
conventions for the same fixture credential is how someone later hardcodes a real
one.

**Tier-3 coverage has an honest boundary.** Anchor resolution reads *rendered*
layout, and rendered layout depends on CSS. Offline fixtures load no stylesheets,
so they can only cover adjacency already inline in the markup. Geometry is the
tier most likely to break on a surface change and the tier fixtures test least.
Recorded in spec §11.

---

## 6. What this target actually taught us

ParaBank was chosen as a legacy-shaped target, and two of its properties shaped
the design:

- **Hidden success and error nodes ship in the accessibility tree.** Every
  detector and checkpoint must assert the node is rendered, not merely present.
- **Labels are unassociated with their inputs** (`<b>Username</b>` and a bare
  `<input>`, no `<label for=>`). This is the entire reason tier 3 exists.

A measurement that corrected an earlier assumption: ParaBank's **login form**
stacks label above field (anchor y=287–302, field y=305–323, same x), so
`nearest-right` genuinely cannot reach it. But `register.htm`'s table-based forms
measure same-row and to-the-right with a 5px gap on the live page. So the missing
relation misses this target's *login form*, not this target.
*Phase 2 scope input:* `nearest-below` / `nearest-above` are missing relations.

---

## 7. Errors made while running this phase

Recorded because a decision record that only lists good calls is marketing.

**Told the user the captured session token was in 3 commits. It is in 10.** I
counted commits that *touched* it rather than commits whose *tree contains* it —
it was committed once and removed later, so everything in between carries it. The
commit whose message reads "replace captured session token with a synthetic
fixture" still carries it, having replaced it in the test but not the plan.

**Stopped the Docker VM to prove the unit suite doesn't need it.** The proof was
valid; the method was destructive where a read-only check would have done. It
killed the target container. Restored, seed data re-verified.

**Claimed the anchor relation gap was broader than measurement supports.** See §6
— corrected by the implementer with live numbers.

**Wrote NUL bytes into my own plan file**, which made `grep` silently skip the
line, truncated the extracted brief mid-line, and led an implementer to invent a
substitute that shipped a broken glob. I initially blamed the tooling; the tooling
was behaving correctly.

**Inferred DOM markup from an accessibility-tree reading, twice** — once for a
fixture assertion that could never hold, once for `#accountTable`. The second was
flagged in advance precisely because of the first, and still needed correcting.

---

## 8. Deliberately deferred to Phase 2

Each was triaged as safe to carry, with a reason:

- No visibility gate on tiers 0–2; a hidden node resolves at tier 2 and is
  rejected at tier 1, so the ladder disagrees with itself. No detector consumes
  it yet — detection is Phase 2, and it lands with the observer's visibility
  model.
- `Surface` has no implementation and no `satisfies` check.
- `sensitiveControls` is configured and never read.
- Clicks are gated against where the page *is*, with no post-action re-check.
- An element with an *empty* name set classifies `safe` (icon-only buttons) — a
  real gap once discovery meets a modern UI.
- Tiers 0–2 still resolve through lazy locators, leaving a narrower TOCTOU
  window than tier 3's in-page stamping.
- `Resolution` records no failed rungs, so tier degradation is inferred rather
  than observed. Adding `attempts: Array<{tier, reason}>` would make it visible
  and is wanted by Phase 3 drift detection.

---

## 9. Open decision — resolved 2026-08-18

**Resolved.** The squash performed before the first push rebuilt the branch from
the scaffold commit, so the ten commits carrying the captured token were never
pushed and are no longer reachable from any ref. Verified twice, independently:
by the Phase 2 whole-branch review, and by scanning all 34 reachable commits
plus both remote branches — zero occurrences, local or upstream.

The token never left the machine. What follows is the reasoning as it stood
while the decision was live, kept because the decision was a real one and the
argument is the part worth re-reading.

---

### The decision as it stood

A real captured session token from Parasoft's **public demo instance** exists in
10 commits of this branch's history. It is absent from `HEAD` and the working
tree. The branch is unpushed and the repository is public, so **push is the
moment this becomes disclosure.**

The practical risk is nil — an expired session cookie from a demo site that
issues one to any visitor, with nothing behind it. The reason to act anyway is
that a project whose headline claim is *"no credential reaches any log"* should
not ship a real captured token in its own history.

Options: squash the branch (simplest, drops it naturally), rewrite history
(preserves granularity, invalidates the SHAs this record cites), or push as-is.
