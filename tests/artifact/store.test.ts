import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { saveArtifact, artifactPath, ApprovedVersionImmutable } from "../../src/artifact/store.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";

const artifact = (over: Partial<CapabilityArtifact["capability"]> = {}): CapabilityArtifact =>
  ({
    capability: {
      id: "find-transaction",
      product: "parabank",
      version: 1,
      goal: "Find a transaction",
      inputs: {},
      outputs: { amount: { type: "string" } },
      status: "draft",
      ...over,
    },
    flow: { steps: [{ kind: "extract", control: "amount_cell", as: "amount" }] },
    bindings: {
      tenant: "local",
      variant: "baseline",
      entryUrl: "http://localhost:8081/parabank/index.htm",
      controls: {
        amount_cell: { scope: [], chain: [{ tier: 2, by: "css", value: "td.amount" }] },
      },
    },
  }) as CapabilityArtifact;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dca-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("capability store", () => {
  it("writes to the spec's layout, one file per version", () => {
    const path = saveArtifact(root, artifact());
    expect(path).toBe(join(root, "capabilities", "parabank", "find-transaction", "1.0.0.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).capability.id).toBe("find-transaction");
  });

  it("writes human-diffable JSON, because binding changes are meant to be reviewed", () => {
    // The point of a file-per-version store over a database: a pull request can
    // show that a control moved from a stable test id to anchor geometry, and
    // someone can ask why. That only works if the file is readable.
    const raw = readFileSync(saveArtifact(root, artifact()), "utf8");
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("keeps versions side by side rather than replacing", () => {
    saveArtifact(root, artifact({ version: 1 }));
    const second = saveArtifact(root, artifact({ version: 2 }));
    expect(second).toContain("2.0.0.json");
    expect(() => readFileSync(join(root, "capabilities", "parabank", "find-transaction", "1.0.0.json"))).not.toThrow();
  });

  it("refuses to overwrite a version already approved", () => {
    // An approved version is a promise something else may already depend on.
    // Immutability starts at approval, not at first write.
    const path = saveArtifact(root, artifact({ status: "approved" }));
    expect(readFileSync(path, "utf8")).toContain("approved");
    expect(() => saveArtifact(root, artifact({ status: "draft" }))).toThrow(ApprovedVersionImmutable);
    // and the approved file on disk is untouched by the refused write
    expect(JSON.parse(readFileSync(path, "utf8")).capability.status).toBe("approved");
  });

  it("allows re-recording a draft, which is what discovery produces", () => {
    // Treating every re-record as a new version would fill the store with
    // numbered near-duplicates nobody chose.
    saveArtifact(root, artifact());
    expect(() => saveArtifact(root, artifact({ goal: "Find a transaction, revised" }))).not.toThrow();
    const path = artifactPath(root, artifact());
    expect(JSON.parse(readFileSync(path, "utf8")).capability.goal).toBe("Find a transaction, revised");
  });

  it("rejects an artifact the schema would reject, at write time", () => {
    // Failing when the file is written beats discovering it when a replay
    // reads it back months later.
    const broken = artifact() as unknown as Record<string, any>;
    delete broken["bindings"].entryUrl;
    expect(() => saveArtifact(root, broken as CapabilityArtifact)).toThrow();
  });

  it("refuses to read back a corrupted file as if it were valid", () => {
    // The overwrite check parses what is already there. A file someone edited
    // by hand into something invalid must not be silently treated as
    // non-approved and clobbered.
    const path = artifactPath(root, artifact());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"capability":{"status":"approved"}}', "utf8");
    expect(() => saveArtifact(root, artifact())).toThrow();
  });
});
