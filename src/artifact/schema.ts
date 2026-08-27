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

/**
 * What the run verified, so a replay can verify the same thing.
 *
 * `state` is spec §4's mandatory field and was missing: the artifact named a
 * control and said nothing about what was true of it, leaving a replay engine
 * to invent its own criterion — or, worse, to check nothing and call that
 * agreement.
 *
 * `"visible"` is the only value the recorder can produce, and that is a
 * statement about `checkpointHolds`, not a placeholder: the loop verifies
 * exactly one *rendered* match and nothing else, so it is the only claim
 * discovery is entitled to write down. A literal rather than an open string
 * keeps it that way — a recorder that learns to verify more has to widen this
 * type deliberately, and a replay reading an artifact will never meet a state
 * nobody implemented.
 *
 * What this does NOT fix, stated plainly because encoding a field invites the
 * belief that the problem is solved: a checkpoint asserting an element is
 * visible holds whether or not the steps before it achieved anything. On a
 * flow whose real success condition is "the list now shows debits only", the
 * strongest checkpoint available is the dropdown that was set — which is
 * visible either way. Certifying an *outcome* needs an expected value, and an
 * expected value needs an observer that can see rendered content rather than
 * only controls. See §6.
 */
const CheckpointStepSchema = z
  .object({
    kind: z.literal("checkpoint"),
    control: z.string(),
    state: z.literal("visible"),
  })
  .strict();

const ExtractStepSchema = z
  .object({
    kind: z.literal("extract"),
    control: z.string(),
    as: z.string(),
  })
  .strict();

/**
 * The one step that names a place rather than a control, and therefore the
 * one that has no `control` field for `superRefine` below to check.
 *
 * Without it a recorded flow silently drops every navigation the model
 * performed: `discover()` executed the `goto` and had nowhere to write it
 * down, so an artifact whose goal is reachable only by navigating replayed as
 * a sequence of clicks against whatever page the replay engine happened to
 * open. The gap was real and shipped — see the entry-URL note on
 * `BindingsSchema`.
 *
 * `url` is resolved against `bindings.entryUrl` at replay time
 * (`new URL(step.url, bindings.entryUrl)`), and the recorder writes it as a
 * root-relative path whenever the destination shares the entry's origin.
 * That is the three-block model doing its job, not a convenience: `flow` is
 * the logic and is shared across every tenant running this product, so one
 * tenant's hostname must not be baked into it. A cross-origin destination
 * (legal, if the allowlist permits more than one origin) is recorded
 * absolute, and `new URL` resolves both forms with the same single call.
 */
const NavigateStepSchema = z
  .object({
    kind: z.literal("navigate"),
    url: z.string(),
  })
  .strict();

const StepSchema = z.discriminatedUnion("kind", [
  ActStepSchema,
  CheckpointStepSchema,
  ExtractStepSchema,
  NavigateStepSchema,
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
 * Whether a string is somewhere a replay could actually be told to start.
 *
 * Exported because `discover()` needs the identical test while the run is
 * still in progress — it has to know whether the page it is looking at
 * counts as an entry, and it must reach that verdict with the same predicate
 * the schema will apply at the end. Two copies of "is this a usable URL"
 * would be one copy too many, and the one that disagreed would be the one
 * that recorded the artifact.
 */
export function isEntryUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

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
 * Required is not the same as *usable*, which is what `isEntryUrl` below adds
 * and why it is here rather than in the loop that produces the value. The
 * first version of this field was `z.string().url()`, which accepts
 * `"about:blank"` — and `about:blank` is exactly what a run records when the
 * model's opening move is a navigate, because the loop read `page.url()`
 * before the first turn and a fresh Playwright page is on `about:blank`.
 * A committed artifact shipped that way, with three proven bindings for pages
 * under `http://localhost:8081/parabank/` and a `bindings.entryUrl` of
 * `about:blank`, and every e2e assertion over it passed. Requiring an
 * absolute http(s) URL makes the value that was recorded unrepresentable, so
 * the same mistake cannot be made silently a second time in a different
 * caller.
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
    entryUrl: z.string().refine(isEntryUrl, {
      message: 'must be an absolute http(s) URL a replay can open (e.g. "about:blank" is not somewhere to start)',
    }),
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
    //
    // A `navigate` step names a place rather than a control, so it has
    // nothing to check here. The narrowing is on the field's presence in the
    // discriminated union rather than on `step.kind`, so a future step that
    // also carries no control needs no edit here and a future step that does
    // carry one is checked without being remembered.
    const bound = new Set(Object.keys(artifact.bindings.controls));
    artifact.flow.steps.forEach((step, i) => {
      if (!("control" in step)) return;
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
