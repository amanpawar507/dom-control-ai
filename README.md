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

Scaffold. Nothing is implemented yet — see [REPORT.md](./REPORT.md) for the design and
[the checklist](#core-requirements-checklist) below for progress.

## Setup

```bash
# TODO: runtime + dependency install
cp .env.example .env   # add your model API key
```

## Demo path

```bash
# 1. Discovery: LLM-driven run against a live surface
# TODO: exact command

# 2. Replay: re-run the saved artifact deterministically with input params
# TODO: exact command

# 3. Replay hitting an exceptional state (e.g. record-not-found)
# TODO: exact command
```

Running without live services: TODO (document the offline/mock path).

## Layout

| Path         | What's in it                                                       |
| ------------ | ------------------------------------------------------------------ |
| `src/`       | Agent loop, artifact schema, replay engine, guardrails, escalation |
| `evidence/`  | Saved example artifact + logs from a discovery run and replay runs |
| `REPORT.md`  | Design write-up (architecture, schema, determinism, safety, cuts)  |

## Core requirements checklist

- [ ] 3.1 Goal-driven agent loop (observe → decide → act against a real UI)
- [ ] 3.2 Typed, versioned capability artifact (steps, targeting, params, outputs, checkpoint)
- [ ] 3.3 Deterministic replay with an explicit error taxonomy
- [ ] 3.4 Safety guardrails (allowlist, risky-action handling, redaction)
- [ ] 3.5 Evidence / observability
- [ ] 3.6 Human-in-the-loop escalation & live-session handoff
- [ ] 3.7 Design for heterogeneity & multi-tenant reuse (write-up)
