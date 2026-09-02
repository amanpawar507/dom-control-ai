// Container-free. No browser, no target, no network — the point of these tests
// is that the actor's refuse and escalate branches can be proved *without*
// firing the thing they guard. The escalate branch stops an irreversible action
// against a live database; testing it end-to-end would mean clicking the button
// that drops the database and hoping the guard held.
//
// The stub page answers the actor's "what is this element called?" from a table
// supplied per test. That is the right seam for *these* tests, which are about
// what the actor does with the answer; it is emphatically not where the answer
// itself can be trusted, so how a name is derived from real markup is pinned
// against a real DOM in actor-element-risk.test.ts instead.
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PolicyEscalation, PolicyRefusal, WebActor } from "../../src/surface/playwright-web/actor.js";
import type { PolicyConfig } from "../../src/policy/gate.js";
import { StubLogger } from "../support/stubs.js";

interface StubCall {
  method: string;
  args: unknown[];
}

/**
 * A Page that performs nothing and remembers everything reached on it.
 *
 * The assertion these tests care about is not "an error was thrown" — that is
 * satisfied by an actor that clicks and *then* throws. It is "the page was
 * never touched", which needs a page that can say what was touched. Reading
 * `url()` is recorded like any other call so a test can state the exact
 * boundary: for an escalated action the only method reached is `url`, meaning
 * no locator was even constructed, so no click could have occurred.
 *
 * That claim rests on what this class *omits* as much as on what it records.
 * Any `Page` member not implemented here is `undefined`, so reaching for one
 * throws a `TypeError` — which is not a `PolicyEscalation`, so the test fails
 * rather than passing on a route nobody was watching. Do not give this stub a
 * permissive `Proxy` or a no-op fallback: that silently weakens
 * `methods === ["url"]` from "nothing else was reachable" to "nothing else was
 * recorded", which is a different and much weaker statement.
 */
class StubPage {
  readonly calls: StubCall[] = [];

  /**
   * @param names What the page says each stamped handle is called. A handle
   *   absent from this table is an element that is not on the page, which the
   *   actor must treat as unclassifiable rather than as unnamed.
   */
  constructor(
    private readonly href: string,
    private readonly names: Record<string, string[]> = { h1: ["Accounts Overview"], h2: ["Account:"], h3: ["Balance"] },
  ) {}

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  url(): string {
    this.rec("url");
    return this.href;
  }

  async goto(url: string): Promise<null> {
    this.rec("goto", url);
    return null;
  }

  locator(selector: string): {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    selectOption(value: string): Promise<void>;
    count(): Promise<number>;
    evaluate(): Promise<string[]>;
  } {
    this.rec("locator", selector);
    const rec = this.rec.bind(this);
    const handle = /\[data-dca-handle="([^"]*)"\]/.exec(selector)?.[1] ?? "";
    const named = this.names[handle];
    return {
      async click(): Promise<void> {
        rec("click", selector);
      },
      async fill(value: string): Promise<void> {
        rec("fill", selector, value);
      },
      async selectOption(value: string): Promise<void> {
        rec("selectOption", selector, value);
      },
      async count(): Promise<number> {
        rec("count", selector);
        return named === undefined ? 0 : 1;
      },
      // The actor passes the real in-page name function; this stub does not run
      // it, because a fake element would only prove that a fake element can be
      // read. It answers with what the page is defined to say instead.
      async evaluate(): Promise<string[]> {
        rec("evaluate", selector);
        return named ?? [];
      },
    };
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  /** `Page` is far too wide to implement; the actor uses three of its members. */
  asPage(): Page {
    return this as unknown as Page;
  }
}

/** Reading the control's name: one locator, one count, one evaluate. */
const READ_NAME = ["locator", "count", "evaluate"];

const CFG: PolicyConfig = {
  allowlist: {
    origins: ["http://localhost:8081"],
    paths: ["/parabank/**"],
    actions: ["click", "fill", "select", "navigate", "extract"],
  },
  riskRules: [{ tier: "irreversible", matchControl: "^(Clean|Shutdown)$" }],
  approved: true,
};

const ON_ADMIN = "http://localhost:8081/parabank/admin.htm";

function build(
  href = ON_ADMIN,
  names?: Record<string, string[]>,
): { page: StubPage; log: StubLogger; actor: WebActor } {
  const page = new StubPage(href, names);
  const log = new StubLogger();
  return { page, log, actor: new WebActor(page.asPage(), CFG, log.asLogger()) };
}

/** A page whose `h1` is the control that drops the database. */
const onCleanButton = (href = ON_ADMIN) => build(href, { h1: ["Clean"] });

describe("WebActor — escalate", () => {
  it("throws PolicyEscalation instead of clicking an irreversible control", async () => {
    const { page, actor } = onCleanButton();

    await expect(actor.act({ type: "click", handle: "h1" }, null)).rejects.toBeInstanceOf(
      PolicyEscalation,
    );

    // The whole claim: the only thing done to the page was reading what the
    // control is called. No `click` — and because the stub implements nothing
    // else, any other route would have thrown a TypeError rather than passing.
    expect(page.methods).toEqual(["url", ...READ_NAME]);
  });

  it("carries the reason and is not confusable with a refusal", async () => {
    const { actor } = onCleanButton();

    const err: unknown = await actor.act({ type: "click", handle: "h1" }, null).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PolicyEscalation);
    // An escalation goes to a human and a refusal ends the attempt. A catch site
    // that cannot tell them apart cannot route them differently.
    expect(err).not.toBeInstanceOf(PolicyRefusal);
    expect((err as PolicyEscalation).reason).toBe("irreversible action requires a human");
  });

  it("records what the caller claimed and what the gate judged, but never an `acted` event", async () => {
    const { log, actor } = onCleanButton();

    await actor.act({ type: "click", handle: "h1" }, "Accounts Overview").catch(() => undefined);

    expect(log.kinds).toEqual(["gate"]);
    expect(log.events[0]).toMatchObject({
      kind: "gate",
      // The disagreement is the audit trail: the caller said one thing, the
      // page said another, and the verdict followed the page. Both halves are
      // still here — `claimedName` is what the caller said, `controlNames` is
      // what made the verdict what it is.
      claimedName: "Accounts Overview",
      // Only the name a rule matched. The gate was handed both names and
      // classified on both; the file records the one that did the work, because
      // the other is page text and page text is how a `<select>`'s options —
      // account numbers, on the real target — used to reach disk through this
      // very line. See `controlNameEvidence`.
      controlNames: ["Clean"],
      verdict: { decision: "escalate", risk: "irreversible" },
    });
    // The gate saw more than the file shows, and the file says so rather than
    // implying "Clean" was all there was to read.
    expect(typeof log.events[0]?.["controlNamesDigest"]).toBe("string");
  });

  it("escalates on what the element is, wherever the page happens to be", async () => {
    const { page, actor } = onCleanButton("http://localhost:8081/parabank/overview.htm");

    const verdict = await actor.verdictFor({ type: "click", handle: "h1" }, null);

    expect(verdict.decision).toBe("escalate");
    // verdictFor is a question, not an instruction: asking reads, never acts.
    expect(page.methods).toEqual(["url", ...READ_NAME]);
  });
});

describe("WebActor — refuse", () => {
  it("throws PolicyRefusal and never navigates outside the allowlist", async () => {
    const { page, actor } = build();

    await expect(actor.act({ type: "navigate", url: "https://example.com/" }, null)).rejects.toBeInstanceOf(
      PolicyRefusal,
    );

    // Not even `url()` — a navigate is judged against where it is going.
    expect(page.methods).toEqual([]);
  });

  it("is not confusable with an escalation", async () => {
    const { actor } = build();

    const err: unknown = await actor
      .act({ type: "navigate", url: "https://example.com/" }, null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PolicyRefusal);
    expect(err).not.toBeInstanceOf(PolicyEscalation);
    expect((err as PolicyRefusal).reason).toContain("origin not allowed");
  });

  it("refuses an action type the allowlist does not carry", async () => {
    const { page, actor } = build();

    await expect(actor.act({ type: "upload", handle: "h1" }, null)).rejects.toBeInstanceOf(PolicyRefusal);

    expect(page.methods).toEqual(["url", ...READ_NAME]);
  });

  it("refuses a targeted action with no handle rather than judging the caller's label", async () => {
    const { page, actor } = build();

    // No handle is no element, and no element is nothing to classify. Judging
    // it by the label alone is exactly the hazard the gate was rekeyed to
    // close, so the unclassifiable case fails closed — and the page is never
    // reached for a name that could not be read anyway.
    const err: unknown = await actor.act({ type: "click" }, "Accounts Overview").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PolicyRefusal);
    expect((err as PolicyRefusal).reason).toContain('click requires "handle"');
    expect(page.methods).toEqual(["url"]);
  });
});

describe("WebActor — allow", () => {
  it("clicks exactly the resolved handle", async () => {
    const { page, log, actor } = build();

    await actor.act({ type: "click", handle: "h1" }, "Accounts Overview");

    // The trailing `url` is the `acted` record reading back where it landed.
    expect(page.methods).toEqual(["url", ...READ_NAME, "locator", "click", "url"]);
    expect(page.calls[1]?.args[0]).toBe('[data-dca-handle="h1"]');
    expect(log.kinds).toEqual(["gate", "acted"]);
  });

  it("threads a value through fill", async () => {
    const { page, actor } = build();

    await actor.act({ type: "fill", handle: "h2", value: "12345" }, "Account:");

    expect(page.methods).toEqual(["url", ...READ_NAME, "locator", "fill", "url"]);
    expect(page.calls[5]?.args).toEqual(['[data-dca-handle="h2"]', "12345"]);
  });

  it("navigates to an allowlisted url", async () => {
    const { page, actor } = build();

    await actor.act({ type: "navigate", url: "http://localhost:8081/parabank/overview.htm" }, null);

    expect(page.methods).toEqual(["goto", "url"]);
    expect(page.calls[0]?.args).toEqual(["http://localhost:8081/parabank/overview.htm"]);
  });

  it("treats extract as a read: gated, logged, and no effect on the page", async () => {
    const { page, log, actor } = build();

    await actor.act({ type: "extract", handle: "h3" }, "Balance");

    expect(page.methods).toEqual(["url", ...READ_NAME, "url"]);
    expect(log.kinds).toEqual(["gate", "acted"]);
  });
});
