import { checkAllowlist, type ActionType, type Allowlist } from "./allowlist.js";
import { classifyRisk, type RiskRule, type RiskTier } from "./risk.js";

export interface PolicyConfig {
  allowlist: Allowlist;
  riskRules: RiskRule[];
  sensitiveControls: string[];
  approved: boolean;
}

export interface GateRequest {
  url: string;
  action: ActionType;
  /**
   * Every name the control being acted on goes by — read off the element by the
   * caller of `gate`, not asserted about it. The plural is the point: risk
   * classification is monotone in this set (see `classifyRisk`), so a name
   * supplied on top of the element's own can only make the verdict stricter.
   */
  controlNames: readonly string[];
}

export type GateVerdict =
  | { decision: "allow"; risk: RiskTier }
  | { decision: "escalate"; risk: RiskTier; reason: string }
  | { decision: "refuse"; risk?: RiskTier; reason: string };

export function gate(cfg: PolicyConfig, req: GateRequest): GateVerdict {
  const permitted = checkAllowlist(cfg.allowlist, req.url, req.action);
  if (!permitted.allowed) return { decision: "refuse", reason: permitted.reason };

  const risk = classifyRisk(req.url, req.action, req.controlNames, cfg.riskRules);

  if (risk === "irreversible") {
    return { decision: "escalate", risk, reason: "irreversible action requires a human" };
  }
  if (risk === "guarded" && !cfg.approved) {
    return { decision: "refuse", risk, reason: "guarded action requires an approved capability" };
  }
  return { decision: "allow", risk };
}
