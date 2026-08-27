import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArtifact, type CapabilityArtifact } from "./schema.js";

/**
 * Where a recorded capability lives once it is more than a run's by-product.
 *
 * Until this existed, discovery wrote its artifact into the run's evidence
 * directory — which is gitignored, because unreviewed run output is a leak
 * vector and every run writes JSONL that would carry a token if redaction ever
 * regressed. That reasoning still holds for the JSONL. It was wrong for the
 * artifact: the design's claim is that the artifact IS the product, and the
 * product was being written to scratch.
 *
 * The layout is the spec's (§4), and each part of it is load-bearing rather
 * than decorative:
 *
 *   capabilities/<product>/<id>/<version>.json
 *
 * One file per version, human-diffable, in git. That is what makes a change to
 * a binding reviewable — a pull request can show that a control moved from a
 * stable test id to anchor-relative geometry, and someone can ask why. A row
 * in a table cannot be reviewed that way.
 */
export class ApprovedVersionImmutable extends Error {
  constructor(readonly path: string) {
    super(
      `${path} is already recorded with status "approved" and will not be overwritten. ` +
        `An approved version is a promise something else may already depend on; ` +
        `record a new version instead of editing this one.`,
    );
    this.name = "ApprovedVersionImmutable";
  }
}

/** `1` -> `"1.0.0"`. Versions are integers in the artifact and semver on disk. */
function versionFile(version: number): string {
  return `${version}.0.0.json`;
}

export function artifactPath(root: string, artifact: CapabilityArtifact): string {
  const { product, id, version } = artifact.capability;
  return join(root, "capabilities", product, id, versionFile(version));
}

/**
 * Write an artifact to the capability store, returning the path written.
 *
 * Refuses to overwrite a version already on disk with status `approved`.
 * Overwriting a `draft` is allowed on purpose: a draft is what discovery
 * produces, re-recording one is ordinary, and treating every re-record as a
 * new version would fill the store with numbered near-duplicates nobody chose.
 * Approval is the moment the contract stops moving, and that is exactly where
 * immutability starts.
 *
 * The artifact goes through `parseArtifact` on the way in. Anything the schema
 * rejects is a bug in whoever built it, and failing at the moment of writing
 * beats discovering it when a replay reads the file back months later.
 */
export function saveArtifact(root: string, artifact: CapabilityArtifact): string {
  const validated = parseArtifact(artifact);
  const path = artifactPath(root, validated);

  if (existsSync(path)) {
    const existing = parseArtifact(JSON.parse(readFileSync(path, "utf8")));
    if (existing.capability.status === "approved") throw new ApprovedVersionImmutable(path);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return path;
}
