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

export type Resolution =
  | { ok: true; tier: number; handle: Handle; attempts: Attempt[] }
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
