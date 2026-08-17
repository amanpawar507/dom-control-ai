// src/artifact/schema.ts
import { z } from "zod";

/**
 * Mirrors `Strategy` in `src/surface/types.ts` — tiers 0 through 3 only.
 * Tier 4 (visual/model-assisted) exists solely in discovery and escalation;
 * a chain that could carry one could not replay deterministically, so it
 * must be unrepresentable here rather than merely rejected at runtime.
 *
 * A `z.discriminatedUnion` over four literal `tier` values gives that for
 * free: `z.infer` on this schema has no tier-4 member, so TypeScript code
 * that builds a `Strategy` from the inferred type cannot name tier 4 — a
 * compile error, not a validation failure. `parseArtifact` below is the
 * runtime backstop for input that never went through the type system at all
 * (an artifact loaded from disk, `unknown` at the call site).
 *
 * There is no automatic derivation from `types.ts`'s `Strategy` union to a
 * Zod schema, so this is a hand-kept mirror, not an import. It has already
 * diverged from a stale copy once this phase (Task 3 widened tier 3's `rel`
 * to three relations) — re-read `types.ts` before trusting this comment.
 */
const Tier0Schema = z
  .object({
    tier: z.literal(0),
    by: z.literal("testid"),
    value: z.string(),
  })
  .strict();

const Tier1Schema = z
  .object({
    tier: z.literal(1),
    by: z.literal("role"),
    role: z.string(),
    name: z.string(),
  })
  .strict();

const Tier2Schema = z
  .object({
    tier: z.literal(2),
    by: z.literal("css"),
    value: z.string(),
  })
  .strict();

const Tier3Schema = z
  .object({
    tier: z.literal(3),
    by: z.literal("anchor"),
    anchorText: z.string(),
    rel: z.enum(["nearest-right", "nearest-below", "nearest-above"]),
    accepts: z.array(z.string()),
  })
  .strict();

export const StrategySchema = z.discriminatedUnion("tier", [
  Tier0Schema,
  Tier1Schema,
  Tier2Schema,
  Tier3Schema,
]);

/** Mirrors `ScopePath` in `src/surface/types.ts`. */
const ScopePathSchema = z.array(
  z.object({ kind: z.enum(["frame", "shadow"]), name: z.string() }).strict(),
);

/** Mirrors `Fingerprint` in `src/surface/types.ts`. */
const FingerprintSchema = z
  .object({
    matches: z.string().optional(),
    tag: z.string().optional(),
    stableForMs: z.number().optional(),
  })
  .strict();

/**
 * Mirrors `Binding` in `src/surface/types.ts`. No handle appears here — a
 * handle is a one-turn discovery-time token; a binding is what a handle
 * gets proven into at record time (Task 6). This file only describes what a
 * recorded, replayable artifact holds, downstream of that proving step.
 */
const BindingSchema = z
  .object({
    scope: ScopePathSchema,
    chain: z.array(StrategySchema),
    fingerprint: FingerprintSchema.optional(),
  })
  .strict();

const ParamSchema = z.object({ type: z.string() }).strict();

/** THE CONTRACT — per vendor product. Carries no tenant-scoped field. */
const CapabilitySchema = z
  .object({
    id: z.string(),
    product: z.string(),
    version: z.number().int().positive(),
    goal: z.string(),
    inputs: z.record(z.string(), ParamSchema),
    outputs: z.record(z.string(), ParamSchema),
    status: z.enum(["draft", "approved"]),
  })
  .strict();

/**
 * A flow step never carries a selector or a handle — only a semantic
 * `control` name, resolved against `bindings` at replay time. That
 * indirection is what makes `flow` shareable across tenants: the same steps
 * replay under any tenant's `bindings` overlay.
 *
 * `value` is required for `fill` and `select`, and absent from `click` —
 * modelled as a discriminated union on `action` rather than one shape with
 * an optional field, so "a fill step with nothing to fill" is unrepresentable
 * rather than merely discouraged. A click carries no `value` at all (not
 * even as an allowed-but-unused field): `click` legitimately has none, and
 * `.strict()` on each branch closes off a stray `value` sneaking onto it.
 */
const ActStepSchema = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("act"), action: z.literal("click"), control: z.string() }).strict(),
  z
    .object({ kind: z.literal("act"), action: z.literal("fill"), control: z.string(), value: z.string() })
    .strict(),
  z
    .object({ kind: z.literal("act"), action: z.literal("select"), control: z.string(), value: z.string() })
    .strict(),
]);

const CheckpointStepSchema = z
  .object({
    kind: z.literal("checkpoint"),
    control: z.string(),
  })
  .strict();

const ExtractStepSchema = z
  .object({
    kind: z.literal("extract"),
    control: z.string(),
    as: z.string(),
  })
  .strict();

const StepSchema = z.discriminatedUnion("kind", [
  ActStepSchema,
  CheckpointStepSchema,
  ExtractStepSchema,
]);

/** THE LOGIC — shared across tenants. */
const FlowSchema = z
  .object({
    steps: z.array(StepSchema).min(1),
  })
  .strict();

/**
 * THE SURFACE — per tenant/variant. This is the only block a tenant
 * override may touch (the overlay invariant, spec §4). That invariant holds
 * by construction here, not by convention: `CapabilitySchema` and
 * `FlowSchema` have no `tenant`/`variant` field and are both closed to
 * unknown keys (`.strict()`), and the top-level schema below is closed too
 * — so there is no field anywhere outside `bindings` a tenant-scoped value
 * could occupy, valid or not.
 */
/**
 * `entryUrl` lives here, in the per-tenant block, and that placement is the
 * three-block model doing its job rather than an arbitrary choice.
 *
 * `capability` is the contract, shared across every tenant running the vendor
 * product. `flow` is the logic, likewise shared. `bindings` is the surface —
 * the part that differs per tenant and per variant. A starting URL is squarely
 * surface: tenant A's install of the same product does not sit at tenant B's
 * host. Putting it in `capability` or `flow` would make one tenant's hostname
 * part of a contract every other tenant inherits, and the overlay invariant
 * (§4: a tenant override may modify `bindings` only) would then be unable to
 * correct it.
 *
 * It is required, not optional. An artifact that cannot say where it starts is
 * not replayable standalone — something outside it has to know, and that
 * knowledge has nowhere to live.
 *
 * Whether the URL is *permitted* is deliberately not checked here. The
 * allowlist is policy, it is evaluated per run against the config in force,
 * and the same artifact can be legal for one caller and refused for another.
 * Baking that verdict into parse time would freeze a decision that belongs to
 * the gate at replay.
 */
const BindingsSchema = z
  .object({
    tenant: z.string(),
    variant: z.string(),
    entryUrl: z.string().url(),
    controls: z.record(z.string(), BindingSchema),
  })
  .strict();

export const CapabilityArtifactSchema = z
  .object({
    capability: CapabilitySchema,
    flow: FlowSchema,
    bindings: BindingsSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    // The three blocks are separable but not independent: flow logic is
    // shared across tenants and bindings are per-tenant, so a step naming a
    // control with no binding is an artifact that cannot replay anywhere.
    // This is the one piece of cross-block validation the per-block schemas
    // above cannot express on their own.
    const bound = new Set(Object.keys(artifact.bindings.controls));
    artifact.flow.steps.forEach((step, i) => {
      if (!bound.has(step.control)) {
        ctx.addIssue({
          code: "custom",
          message: `flow step ${i} ("${step.kind}") references control "${step.control}", which has no binding in bindings.controls`,
          path: ["flow", "steps", i, "control"],
        });
      }
    });
  });

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/**
 * The only entry point this module exposes for turning `unknown` — an
 * artifact just read off disk, never having passed through the type system
 * — into a `CapabilityArtifact`. Throws with every issue's path and message
 * joined into one string, so a caller's `.message` reliably contains
 * whatever detail (a control name, a bad status value) the failure turns on.
 */
export function parseArtifact(u: unknown): CapabilityArtifact {
  const result = CapabilityArtifactSchema.safeParse(u);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid capability artifact: ${detail}`);
  }
  return result.data;
}
