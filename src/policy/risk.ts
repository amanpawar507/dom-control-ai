import type { ActionType } from "./allowlist.js";

export type RiskTier = "safe" | "guarded" | "irreversible";

export interface RiskRule {
  tier: RiskTier;
  matchPath?: string;    // regex against URL pathname
  matchAction?: ActionType;
  matchControl?: string; // regex against any name the control goes by
}

const SEVERITY: Record<RiskTier, number> = { safe: 0, guarded: 1, irreversible: 2 };

/**
 * `controlNames` is a set rather than a single string because one element
 * legitimately answers to several names — `<button aria-label="Clean">Purge
 * everything</button>` is named both ways, and a rule may be written against
 * either. A `matchControl` rule fires when *any* of them matches.
 *
 * That makes classification monotone in the name set: adding a name can only
 * raise the tier, never lower it. It is the property that lets a caller's
 * claimed label be passed in alongside the name read off the element without
 * reintroducing the hazard — a caller can narrow the verdict (be more cautious
 * than the element warrants) and cannot widen it. An empty set is the honest
 * representation of "nothing is known about this control", and no
 * `matchControl` rule fires against it.
 */
export function classifyRisk(
  url: string,
  action: ActionType,
  controlNames: readonly string[],
  rules: RiskRule[],
): RiskTier {
  const pathname = new URL(url).pathname;
  let worst: RiskTier = "safe";

  for (const rule of rules) {
    if (rule.matchPath && !new RegExp(rule.matchPath).test(pathname)) continue;
    if (rule.matchAction && rule.matchAction !== action) continue;
    if (rule.matchControl) {
      const re = new RegExp(rule.matchControl);
      if (!controlNames.some((name) => re.test(name))) continue;
    }
    if (SEVERITY[rule.tier] > SEVERITY[worst]) worst = rule.tier;
  }
  return worst;
}
