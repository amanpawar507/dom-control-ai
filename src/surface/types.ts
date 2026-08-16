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
