import { createHash } from "node:crypto";
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
  let worst: RiskTier = "safe";
  for (const firing of firings(url, action, controlNames, rules)) {
    if (SEVERITY[firing.tier] > SEVERITY[worst]) worst = firing.tier;
  }
  return worst;
}

/**
 * Every rule that fires on this request, and which of the names made it fire.
 *
 * One implementation, two questions: `classifyRisk` asks for the worst tier and
 * `controlNameEvidence` asks which names it turned on. Splitting them into two
 * loops over the same predicate would be a second copy of the matching, and two
 * copies of a rule are two chances to disagree about what "matched" means —
 * which is the failure the resolver's single choke point exists to avoid.
 */
function firings(
  url: string,
  action: ActionType,
  controlNames: readonly string[],
  rules: RiskRule[],
): Array<{ tier: RiskTier; matched: string[] }> {
  const pathname = new URL(url).pathname;
  const fired: Array<{ tier: RiskTier; matched: string[] }> = [];

  for (const rule of rules) {
    if (rule.matchPath && !new RegExp(rule.matchPath).test(pathname)) continue;
    if (rule.matchAction && rule.matchAction !== action) continue;
    let matched: string[] = [];
    if (rule.matchControl) {
      const re = new RegExp(rule.matchControl);
      matched = controlNames.filter((name) => re.test(name));
      if (matched.length === 0) continue;
    }
    fired.push({ tier: rule.tier, matched });
  }
  return fired;
}

/** What a log may record about the names a gate decision was taken on. */
export interface ControlNameEvidence {
  /** The names a configured rule matched. Possibly empty, which is itself the explanation of a `safe` verdict. */
  controlNames: string[];
  /** A stable handle on the whole set, and `null` when there was no name to read. */
  controlNamesDigest: string | null;
}

/**
 * The names a gate decision may be written down with.
 *
 * The gate is handed every name the element answers to, because risk
 * classification is monotone in that set and a name withheld from it can only
 * make the verdict laxer. The *log* is a different question, and this codebase
 * answered it the wrong way round for a phase: `controlNames` went into the
 * evidence file verbatim, and for a `<select>` that set is the element's
 * `textContent` — every option, concatenated. Measured on the reference target,
 * a `from account` dropdown reads as the single name
 * "1234512456125671267812789129001301113122132331334454321". A `select` step's
 * argument is by construction one of those options, so the phase's binding
 * constraint — no argument value in any log — was broken for every select step
 * by construction, along with every other account number in the list.
 *
 * What is recorded instead is the names a *rule* matched. That is not a
 * narrowing of the audit trail so much as a statement of what it was ever for:
 * the verdict is a pure function of the url, the action, the rules and this
 * set, and the only thing about the names that can change it is which rules
 * they fire. So the matched set is sufficient to explain — and to re-derive —
 * the decision, while every string that can appear in it is one the policy
 * author's own pattern selected. An author who writes a rule matching account
 * numbers does log account numbers; that is a deliberate act with the pattern
 * sitting next to it in the config, not a leak that arrives by construction
 * from an unrelated element being a dropdown.
 *
 * The digest is what "the gate saw names the log is not showing" looks like
 * when it has to be said safely. Same reasoning and same shape as `observe()`'s
 * `valueDigest` (`src/observe/snapshot.ts`): the only question anyone asks of
 * it is "the same as last time?", and an empty set stays empty because *that*
 * is a fact about the page rather than about its contents — a control with no
 * accessible name is worth knowing about, and it is also the shape a
 * `matchControl` rule can never fire on.
 *
 * Note what this deliberately does not do: change what `controlNamesOf` reads.
 * A blanket "do not read a select's options" would silently weaken the gate on
 * every caller of it, including Phase 2's discovery loop, and this is not the
 * seam where that judgement belongs. Note also what a select-shaped fix would
 * have missed: on the same target, `link_12345`'s only name is the account
 * number it displays, and it reaches the log through an `<a>`.
 */
export function controlNameEvidence(
  url: string,
  action: ActionType,
  controlNames: readonly string[],
  rules: RiskRule[],
): ControlNameEvidence {
  const matched: string[] = [];
  for (const firing of firings(url, action, controlNames, rules)) {
    for (const name of firing.matched) if (!matched.includes(name)) matched.push(name);
  }
  return {
    controlNames: matched,
    controlNamesDigest:
      controlNames.length === 0 ? null : createHash("sha256").update(JSON.stringify(controlNames)).digest("hex").slice(0, 16),
  };
}
