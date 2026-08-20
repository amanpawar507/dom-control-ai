import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArtifact } from "../../src/artifact/schema.js";

/**
 * Every artifact committed to the capability store must parse against the
 * schema that is in the tree right now.
 *
 * Without this, the store is the one place a green suite actively hides a
 * broken deliverable. It happened: adding the mandatory `state` field to
 * checkpoints invalidated the only committed artifact, nothing in 285 tests
 * read it, and the suite went on passing while `saveArtifact` would have
 * thrown on the next re-record.
 *
 * The store is the product. A schema change that orphans what is already in it
 * is a migration nobody performed, and this is what says so.
 */
function artifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? artifacts(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : [],
  );
}

const committed = artifacts("capabilities");

describe("the committed capability store", () => {
  it("holds at least one artifact, or this suite is guarding nothing", () => {
    // A vacuous guard is worse than none: it reports coverage of an empty set
    // and reads as protection.
    expect(committed.length).toBeGreaterThan(0);
  });

  it.each(committed)("%s parses against the current schema", (path) => {
    expect(() => parseArtifact(JSON.parse(readFileSync(path, "utf8")))).not.toThrow();
  });

  it.each(committed)("%s carries no credential or session token", (path) => {
    const raw = readFileSync(path, "utf8").toLowerCase();
    for (const bad of ["jsessionid", "sk-ant-", '"password"', "demo", "john"]) {
      expect(raw).not.toContain(bad);
    }
  });
});
