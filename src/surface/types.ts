import type { ActionType } from "../policy/allowlist.js";
import type { Observation } from "../observe/snapshot.js";

export type Handle = string;

export type ScopePath = Array<{ kind: "frame" | "shadow"; name: string }>;

export function scopeKey(path: ScopePath): string {
  if (path.length === 0) return "/";
  return path.map((h) => `/${h.kind}:${h.name}`).join("");
}

// `ObservedNode`, `Observation` and `Box` were declared here as Phase 1
// scaffolding, written before anything produced one. `src/observe/snapshot.ts`
// now owns those names with a different shape, so the declarations are gone
// and `Observation` is imported from there instead — `Surface.observe()` below
// is a real consumer, not dead code.
//
// Two differently shaped interfaces sharing a name is a trap under structural
// typing: an import from the wrong module can type-check while carrying the
// wrong fields. One definition is the only version of this that stays true.

export type Strategy =
  | { tier: 0; by: "testid"; value: string }
  | { tier: 1; by: "role"; role: string; name: string }
  | { tier: 2; by: "css"; value: string }
  | {
      tier: 3;
      by: "anchor";
      anchorText: string;
      rel: "nearest-right" | "nearest-below" | "nearest-above";
      accepts: string[];
    };

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

/**
 * One rung of the chain that was tried and did not win, in the order it was
 * tried. Phase 1 shipped a `Resolution` that reported only the winning tier, so
 * "the chain fell through tier 0 and landed on tier 2" was inferable at best —
 * nothing recorded that tier 0 was ever attempted. Task 6's record-time proving
 * orders a chain by observed reliability and needs exactly this history; Phase 3
 * drift detection wants it too.
 *
 * `reason` excludes `"fingerprint-mismatch"` deliberately. `resolveBinding`
 * returns immediately on a mismatch rather than pushing it here and continuing
 * the chain: the strategy resolved to something that is not what was recorded,
 * which is evidence the surface changed, and trying further rungs risks acting
 * on the wrong element. Failing loudly beats searching harder, so that outcome
 * only ever surfaces as `Resolution`'s own `ok:false` reason — never as an
 * `Attempt` — and the type says so instead of promising a state the resolver
 * cannot reach.
 */
export interface Attempt {
  tier: number;
  reason: "no-match" | "ambiguous";
}

/**
 * `candidates` carries the `HANDLE_ATTR` stamp of every element an ambiguous
 * rung matched, so a caller can ask which *elements* the rung was torn
 * between rather than only how many there were. Replay's corroboration
 * (`src/replay/identity.ts`) is the consumer that needs it: an ambiguous rung
 * whose match set still contains the element the rest of the chain agreed on
 * contradicts nothing and is ordinary drift, while one that resolves entirely
 * elsewhere is the chain disagreeing with itself — and `count` alone cannot
 * tell those apart. Reporting the handles rather than a candidate count is
 * what keeps that judgment in one place: the resolver owns matching, and the
 * caller compares identities it was handed instead of re-deriving a match set
 * of its own.
 *
 * Present only on `reason: "ambiguous"`, and `count` remains the number of
 * *elements* matched. The two can differ by exactly one route — a page that
 * cloned an already-stamped node, so two elements carry one handle — and that
 * is a case the resolver refuses rather than resolves (see `resolveBinding`).
 */
export type Resolution =
  | { ok: true; tier: number; handle: Handle; attempts: Attempt[] }
  | {
      ok: false;
      reason: "no-match" | "ambiguous" | "fingerprint-mismatch";
      tier?: number;
      count?: number;
      candidates?: Handle[];
    };

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
