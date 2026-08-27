// src/replay/load.ts
import { readFileSync } from "node:fs";
import { capabilityPath } from "../artifact/store.js";
import { parseArtifact, type CapabilityArtifact } from "../artifact/schema.js";

/**
 * The four fields a tenant overlay is permitted to touch — exactly
 * `BindingsSchema`'s keys in `src/artifact/schema.ts`. Everything else
 * belongs to `capability` or `flow`, both immutable in an overlay (spec §4):
 * the contract and the logic are shared across every tenant running the
 * product, and an overlay that could edit either of them would not be an
 * overlay, it would be a fork wearing an overlay's name.
 */
const OVERLAY_KEYS = new Set(["tenant", "variant", "entryUrl", "controls"]);

/**
 * Read a recorded capability artifact off disk and validate it on the way
 * in. `capabilityPath` (`src/artifact/store.ts`) is the store's one
 * implementation of the `capabilities/<product>/<id>/<version>.json`
 * convention; this is that convention's read side, so both directions share
 * one join instead of two copies that could drift.
 *
 * The file is `unknown` until `parseArtifact` runs on it — it never went
 * through the type system on the way to disk, and having once been written
 * by `saveArtifact` is no guarantee it still parses against the schema in
 * the tree today (`tests/artifact/store-contents.test.ts` exists because
 * that drift happened once already). Failing here, at load, beats
 * discovering it mid-replay.
 */
export function loadCapability(root: string, product: string, id: string, version: number): CapabilityArtifact {
  const path = capabilityPath(root, product, id, version);
  const raw = readFileSync(path, "utf8");
  return parseArtifact(JSON.parse(raw));
}

/**
 * Merge a tenant overlay into a loaded artifact's `bindings`, and nowhere
 * else. This is the one place spec §4's overlay invariant is enforced at
 * load time: any key outside `OVERLAY_KEYS` is rejected **by name** — a
 * rejection that only says "invalid overlay" sends whoever hits it hunting
 * through a file they didn't touch.
 *
 * `controls` merges per control name rather than replacing the whole map. A
 * sparse overlay names only the controls a tenant's markup actually differs
 * on — the spec's own overlay example overrides a single control out of
 * several (§4) — and every control the overlay stays silent about keeps the
 * binding proven at record time. `tenant`, `variant` and `entryUrl` are
 * plain per-tenant scalars: a present key replaces the base's value, an
 * absent one keeps it, so a caller only has to say what changed.
 *
 * The merged result is re-validated through `parseArtifact`, so a
 * syntactically permitted overlay that still produces something that cannot
 * replay (an `entryUrl` that is not an absolute http(s) URL, a malformed
 * chain under `controls`) is caught here too, rather than at replay.
 */
export function applyOverlay(base: CapabilityArtifact, overlay: unknown): CapabilityArtifact {
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new Error("invalid overlay: must be an object carrying only tenant, variant, entryUrl and controls");
  }

  const rec = overlay as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!OVERLAY_KEYS.has(key)) {
      throw new Error(
        `invalid overlay: key "${key}" is not permitted — a tenant overlay may modify bindings only ` +
          `(tenant, variant, entryUrl, controls); "${key}" belongs to capability or flow, both of which ` +
          `are immutable in an overlay (spec §4)`,
      );
    }
  }

  // A present, well-formed `controls` object merges over the base per
  // control name. Anything else present under `controls` (wrong shape, or
  // simply absent) is left to fall through to `parseArtifact` below, which
  // reports it against the real schema rather than being silently
  // swallowed here.
  const overlayControls = rec.controls;
  const controls: unknown =
    overlayControls === undefined
      ? base.bindings.controls
      : typeof overlayControls === "object" && overlayControls !== null && !Array.isArray(overlayControls)
        ? { ...base.bindings.controls, ...(overlayControls as Record<string, unknown>) }
        : overlayControls;

  const mergedBindings = {
    tenant: "tenant" in rec ? rec.tenant : base.bindings.tenant,
    variant: "variant" in rec ? rec.variant : base.bindings.variant,
    entryUrl: "entryUrl" in rec ? rec.entryUrl : base.bindings.entryUrl,
    controls,
  };

  return parseArtifact({
    capability: base.capability,
    flow: base.flow,
    bindings: mergedBindings,
  });
}
