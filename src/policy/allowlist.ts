export type ActionType = "click" | "fill" | "select" | "navigate" | "extract" | "upload";

export interface Allowlist {
  origins: string[];
  paths: string[]; // glob: * within a segment, ** across segments
  actions: ActionType[];
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function checkAllowlist(list: Allowlist, url: string, action: ActionType): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `unparseable url: ${url}` };
  }
  if (!list.origins.includes(parsed.origin)) {
    return { allowed: false, reason: `origin not allowed: ${parsed.origin}` };
  }
  if (!list.paths.some((p) => globToRegExp(p).test(parsed.pathname))) {
    return { allowed: false, reason: `path not allowed: ${parsed.pathname}` };
  }
  if (!list.actions.includes(action)) {
    return { allowed: false, reason: `action not allowed: ${action}` };
  }
  return { allowed: true };
}
