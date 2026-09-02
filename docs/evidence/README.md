# Evidence

## `stability-report.json`

Twenty replays of the recorded capability against a live ParaBank, produced by
`npm run stability -- --runs 20`. Every run succeeded; every control resolved at
the same tier in every run, including `combobox_all_credit_debit` at **tier 3** —
anchor-relative geometry, measured against rendered layout.

No model is involved. Replay has no model in the loop, which is the property the
report exists to demonstrate, and the whole run costs nothing but wall clock.

### What it shows, and what it does not

A report of N agreeing runs, on its own, **fails to disprove non-determinism**.
It does not establish determinism, and the difference matters: runs taken
sequentially in one process, sharing one session, seconds apart, hold most of the
environment still. A weak instrument returning a clean result is not evidence.

So the instrument was calibrated rather than trusted. A wait known to be
load-bearing was removed to induce flake of a rate measured elsewhere at between
1.4% and 7% per run, and the harness was run over the damaged engine:

```
agreed:      false
statuses:    …12 successes, failed, …3 successes, failed, …3 successes
divergences: 4
```

It detected the induced fault — two failures in twenty, and four divergences
named rather than averaged into a pass rate. That is what makes the clean report
above worth reading: the harness has been shown to report a divergence it was
given, not merely to have found none.

The honest summary is therefore narrower than "replay is deterministic" and
stronger than "twenty runs passed": **an instrument demonstrated capable of
detecting a known fault of this size reported no divergence across twenty runs.**

### Strengthening it further

More runs, and more varied conditions — separate processes, separate sessions,
runs spaced apart, a target under load. Twenty runs at a 7% per-run fault rate
still miss it roughly a quarter of the time; the fix for that is sample size, not
a more confident sentence.
