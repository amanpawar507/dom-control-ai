// Container-dependent: every test here replays the capability Phase 2 recorded
// against the live ParaBank container, so this lives under tests/e2e
// (npm run test:e2e) and is excluded from `npm test`.
//
// This is spec §15's exit criterion — success, business-outcome and
// hard-failure replays, recorded against the real thing — and there is no model
// in the loop in any of them. The artifact was written months ago by a live
// Sonnet 5 run; nothing here calls an API, and the only thing driving the
// browser is a JSON file and `replay()`.
//
// Two disciplines carry over from tests/replay/engine.test.ts and matter more
// here, not less:
//
//   * **Assert against the page.** A result saying `success` is equally
//     consistent with a flow that resolved nothing and did nothing, and a page
//     that happened to already be in the right state proves less than it looks.
//     So the success case asserts the transaction list actually changed shape,
//     which the unfiltered page it started from does not satisfy.
//   * **Prove the mutation landed.** The two hard-failure cases move the surface
//     by rewriting the served page. A rewrite whose search string has drifted
//     out of the markup is a no-op, and a no-op rewrite produces a green test
//     for a page nobody changed — so every edit records whether it found its
//     target, and every case asserts the page really is different.
//
// Nothing here touches ParaBank's database. The surface is moved by rewriting
// responses in flight; the fixture data is read but never written, and the
// first and last tests in this file bracket the run with the seed account's
// exact balance.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  BASE,
  openParabankTarget,
  seedAccountIsIntact,
  TYPE_ARGUMENT,
  type ParabankTarget,
  type ReplayRun,
} from "../../src/e2e/replay-parabank.js";

let target!: ParabankTarget;

beforeAll(async () => {
  target = await openParabankTarget();
}, 120_000);

afterAll(async () => {
  await target?.close();
});

/** What the account activity page says about itself, read after a run rather than inferred from its status. */
async function activityState(page: Page): Promise<{
  url: string;
  selectedType: string | null;
  typeSelectPresent: boolean;
  monthSelectPresent: boolean;
  goButtonPresent: boolean;
  rowCount: number;
  creditAmounts: string[];
  debitAmounts: string[];
  tableVisible: boolean;
  noTransactionsVisible: boolean;
}> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#transactionTable tbody tr"));
    const table = document.querySelector("#transactionTable");
    const none = document.querySelector("#noTransactions");
    const type = document.querySelector('select[name="transactionType"]') as HTMLSelectElement | null;
    // Columns are Date | Transaction | Debit (-) | Credit (+), and ParaBank
    // leaves the cell for the other kind empty — so "which amounts landed in
    // which column" is what says whether the filter was really applied.
    const cells = (index: number): string[] =>
      rows.map((row) => (row.children[index]?.textContent ?? "").trim()).filter((text) => text !== "");
    return {
      url: location.pathname + location.search,
      selectedType: type === null ? null : type.value,
      typeSelectPresent: type !== null,
      monthSelectPresent: document.querySelector('select[name="month"]') !== null,
      goButtonPresent: document.querySelector('input[type="submit"][value="Go"]') !== null,
      rowCount: rows.length,
      debitAmounts: cells(2),
      creditAmounts: cells(3),
      tableVisible: table !== null && window.getComputedStyle(table).display !== "none",
      noTransactionsVisible: none !== null && window.getComputedStyle(none).display !== "none",
    };
  });
}

function readEvents(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf8").trim();
  return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Move the surface by rewriting the activity page on its way to the browser.
 *
 * Spec-mandated shape: the fixture database every phase depends on must not be
 * touched, so a control is taken away from the *response* rather than from the
 * application. The returned `misses` is the guard against the failure mode this
 * technique invites — a search string that no longer occurs in the served markup
 * rewrites nothing, the page arrives exactly as ParaBank sent it, and the test
 * then passes or fails for reasons that have nothing to do with the edit it
 * believes it made.
 */
function rewritingActivityPage(edits: Array<{ find: string; replace: string }>): {
  prepare: (page: Page) => Promise<void>;
  misses: string[];
  served: number;
} {
  const state = { misses: [] as string[], served: 0 };
  const prepare = async (page: Page): Promise<void> => {
    await page.route(/\/parabank\/activity\.htm/, async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      for (const edit of edits) {
        if (!body.includes(edit.find)) {
          state.misses.push(edit.find);
          continue;
        }
        body = body.replaceAll(edit.find, edit.replace);
      }
      state.served += 1;
      await route.fulfill({ status: response.status(), contentType: "text/html;charset=UTF-8", body });
    });
  };
  return {
    prepare,
    get misses() {
      return state.misses;
    },
    get served() {
      return state.served;
    },
  };
}

/** The three strings this file's rewrites reach for, as ParaBank actually serves them. */
const TYPE_LABEL = "<b>Type:</b>";
const TYPE_SELECT = '<select id="transactionType" name="transactionType" class="input">';
const TYPE_READ = "$('#transactionType').val()";

describe("live replay — before", () => {
  it("starts against an intact fixture database", async () => {
    // Bracketing the file. If this is already false, nothing below is
    // interpretable, and the failure belongs here rather than in whichever
    // assertion happens to notice the data is wrong.
    expect(await seedAccountIsIntact()).toBe(true);
  });
});

describe("replays the recorded capability to success", () => {
  let run!: ReplayRun;

  beforeAll(async () => {
    // One run, several independent assertions over it — the pattern
    // tests/e2e/phase1.test.ts established. Re-running per assertion would
    // triple the cost and leave three evidence files where the audit wants one.
    run = await target.run({ args: { [TYPE_ARGUMENT]: "Debit" } });
  }, 120_000);

  it("succeeds, and returns the account number it extracted", () => {
    expect(run.result.status).toBe("success");
    if (run.result.status !== "success") return;
    // The recorded flow's one declared output, read off the live overview page.
    expect(run.result.outputs).toEqual({ first_account_number: "12345" });
  });

  it("really walked the flow: it is on that account's page, with the argument applied", async () => {
    const state = await activityState(run.page);
    // Step 2 clicked the account link it had just extracted.
    expect(state.url).toBe("/parabank/activity.htm?id=12345");
    // Step 3 supplied the argument the recorder left as `$combobox_all_credit_debit`.
    expect(state.selectedType).toBe("Debit");
  });

  it("really submitted: the application's answer is narrowed to debits", async () => {
    // The load-bearing assertion in this file. The page arrives *unfiltered* —
    // ParaBank renders every transaction on load, and this account's history
    // contains a credit — so a run that resolved the dropdown, never clicked
    // `Go`, and reported success would leave a credit amount in the table. This
    // is what distinguishes "the flow ran" from "the page was already fine".
    const state = await activityState(run.page);
    expect(state.rowCount).toBeGreaterThan(0);
    expect(state.debitAmounts).toHaveLength(state.rowCount);
    expect(state.creditAmounts).toEqual([]);
    expect(state.tableVisible).toBe(true);
    expect(state.noTransactionsVisible).toBe(false);
  });

  it("resolved every control through a recorded rung, and says which", () => {
    // §7's determinism claim, per control, read back out of the trail rather
    // than asserted about the result — which names no control at all.
    const resolved = readEvents(run.logPath).filter((e) => e["kind"] === "replay.resolved");
    const tiers = Object.fromEntries(resolved.map((e) => [e["control"], e["tier"]]));
    expect(tiers).toEqual({ link_12345: 1, combobox_all_credit_debit: 3, button_go: 1 });

    // `button_go`'s chain has two rungs and both name the same element on this
    // page, so the answer is corroborated rather than merely uncontradicted.
    // `link_12345` has a single rung and can only ever report 1 — recorded, not
    // hidden, because a one-rung binding is exactly the case corroboration
    // cannot help with.
    const go = resolved.find((e) => e["control"] === "button_go");
    expect(go?.["agreed"]).toBe(2);
    const link = resolved.find((e) => e["control"] === "link_12345");
    expect(link?.["agreed"]).toBe(1);
  });

  it("writes neither a session token nor the argument value into the evidence trail", () => {
    const raw = readFileSync(run.logPath, "utf8");
    // The session is the one thing above this seam that could leak a credential
    // by proxy. `ParabankSessionProvider` is the only module that sees one.
    expect(raw).not.toMatch(/jsessionid/i);
    expect(raw).not.toMatch(/\bdemo\b/i);

    // The argument value. Replay takes the values discovery refused to record,
    // and logging them would undo that discipline at the sink.
    //
    // `controlNames` is excluded from the search rather than exempted by
    // hand-waving: it holds the names read *off the element*, and this
    // dropdown's own text is "All Credit Debit" whatever argument is passed —
    // it is there on the run that passed `Credit` and on the runs that passed
    // nothing to it at all. Everything outside that field is searched.
    for (const event of readEvents(run.logPath)) {
      const { controlNames: _readOffThePage, ...rest } = event;
      expect(JSON.stringify(rest)).not.toContain("Debit");
    }
    // And the argument's *name* is recorded, because a run whose inputs are
    // unknowable is not auditable.
    expect(raw).toContain(TYPE_ARGUMENT);
  });
});

describe("returns a business outcome when the application answers with no records", () => {
  let run!: ReplayRun;
  let emptyAnswer = "";
  let served = 0;

  beforeAll(async () => {
    // The same artifact, a different argument — and an answer that is
    // ParaBank's rather than this test's.
    //
    // The seeded account has transactions of *every* type the dropdown offers,
    // so no value of the one argument this capability parameterises produces an
    // empty answer by itself. The activity form has a second control — the
    // activity period — that the recording never bound, so the other half of a
    // legitimately empty question is asked here directly: what this account's
    // credits look like in a month it has none. That question goes to the live
    // server over the run's own authenticated session, and its answer is what
    // the page is given, byte for byte. Nothing about the page is rewritten and
    // no data is invented; the application follows its own empty-result branch,
    // which is the difference between an answer and a broken page.
    //
    // Fetched once up front rather than proxied mid-request, and that ordering
    // is load-bearing. Detection happens at step boundaries, so an answer that
    // arrives after the boundary is an answer this run cannot see — measured on
    // this target, an upstream round trip inside the route handler lands late
    // often enough to make the outcome a coin flip. Pre-fetching removes the
    // *test's* latency from the experiment; it does not paper over the engine's
    // limit, which is written up in the task report rather than hidden here.
    const prepare = async (page: Page): Promise<void> => {
      const answer = await page
        .context()
        .request.get(`${BASE}/services_proxy/bank/accounts/12345/transactions/month/February/type/Credit`);
      emptyAnswer = await answer.text();
      await page.route(
        /\/services_proxy\/bank\/accounts\/\d+\/transactions\/month\/[^/]+\/type\/Credit$/,
        async (route) => {
          served += 1;
          await route.fulfill({ status: 200, contentType: "application/json", body: emptyAnswer });
        },
      );
    };
    run = await target.run({ args: { [TYPE_ARGUMENT]: "Credit" }, prepare });
  }, 120_000);

  it("asked the live application a real question, and got a real empty answer", () => {
    // The claim that this is the application's own answer is checkable, so it
    // is checked: `[]` is what ParaBank's own transactions endpoint returns for
    // a month with no matching records.
    expect(emptyAnswer).toBe("[]");
    expect(served).toBe(1);
  });

  it("reports the application's answer as an outcome, not a failure", () => {
    expect(run.result.status).toBe("business_outcome");
    if (run.result.status !== "business_outcome") return;
    expect(run.result.code).toBe("RECORD_NOT_FOUND");
  });

  it("shows the application's own empty answer on the page", async () => {
    const state = await activityState(run.page);
    // The argument was applied first — the outcome is an answer to the question
    // this run asked, not a page that was empty to begin with.
    expect(state.selectedType).toBe("Credit");
    expect(state.noTransactionsVisible).toBe(true);
    expect(state.tableVisible).toBe(false);
    expect(state.rowCount).toBe(0);
  });

  it("ends on the outcome, having asked the whole question first", () => {
    const events = readEvents(run.logPath);
    const kinds = events.map((e) => e["kind"]);

    // Every step of the recorded flow ran: the account was opened, the argument
    // applied, the filter submitted, the checkpoint verified. So the outcome is
    // an answer to the question this run actually asked, rather than something
    // seen on a page it never got past.
    const acted = events.filter((e) => e["kind"] === "replay.acted");
    expect(acted.map((e) => e["control"])).toEqual(["link_12345", "combobox_all_credit_debit", "button_go"]);
    expect(kinds).toContain("replay.checkpoint");

    // And it ended there, reported as an outcome rather than as a completed run.
    // The two are mutually exclusive by construction and the trail shows which
    // one this was.
    expect(kinds).not.toContain("replay.success");
    const outcome = events.find((e) => e["kind"] === "replay.business_outcome");
    expect(outcome).toMatchObject({ code: "RECORD_NOT_FOUND" });

    // Which step saw it, recorded because it is a fact about this artifact
    // worth knowing: the condition is not detected on the step that submits the
    // filter but on the one after it — ParaBank has not answered yet when the
    // click returns. The recorded flow's last step is therefore the one that
    // catches the answer, which is why "the walk stops here" has nothing after
    // it to demonstrate on this capability. That property is proven
    // container-free in tests/replay/engine.test.ts, on a flow with a step
    // after the trigger.
    expect(outcome?.["step"]).toBe("s5:checkpoint:combobox_all_credit_debit");
  });
});

describe("fails hard, with a classification, when the surface has genuinely moved", () => {
  let run!: ReplayRun;
  let rewrite!: ReturnType<typeof rewritingActivityPage>;

  beforeAll(async () => {
    // A redesign, not a demolition: the transaction-type dropdown is renamed and
    // its label reworded, and the page's own script is updated to match, so what
    // arrives is a *working* application whose surface no longer answers to the
    // recorded binding. Both rungs miss it — the anchor rung looks for the exact
    // text "Type:" and the CSS rung for `select[name="transactionType"]` — which
    // is what makes this drift rather than a broken page.
    rewrite = rewritingActivityPage([
      { find: TYPE_LABEL, replace: "<b>Transaction type:</b>" },
      { find: TYPE_SELECT, replace: '<select id="txnType" name="txnType" class="input">' },
      { find: TYPE_READ, replace: "$('#txnType').val()" },
    ]);
    run = await target.run({ args: { [TYPE_ARGUMENT]: "Debit" }, prepare: rewrite.prepare });
  }, 120_000);

  it("rewrote the page it meant to rewrite", async () => {
    // The mutation is the experiment, so its landing is asserted rather than
    // assumed. Every search string was found, the rewritten page really was
    // served, and the control the recording binds is really not there.
    expect(rewrite.misses).toEqual([]);
    expect(rewrite.served).toBeGreaterThan(0);
    const state = await activityState(run.page);
    expect(state.typeSelectPresent).toBe(false);
    // And the application is otherwise intact — this is a surface that moved,
    // not one that fell over.
    expect(state.monthSelectPresent).toBe(true);
    expect(state.goButtonPresent).toBe(true);
    expect(await run.page.locator('select[name="txnType"]').count()).toBe(1);
  });

  it("reports which step, what it expected and what it saw — rather than throwing", () => {
    expect(run.result.status).toBe("failed");
    if (run.result.status !== "failed") return;
    expect(run.result.classification).toBe("no-match");
    // Named, not numbered: the step of the recorded flow to go and look at.
    expect(run.result.stepId).toBe("s3:select:combobox_all_credit_debit");
    expect(run.result.expected).toContain("combobox_all_credit_debit");
    expect(run.result.observed).toMatch(/no rung of the chain/i);
    expect(run.result.observed).toContain("combobox_all_credit_debit");
    // And it points at the trail that explains it.
    expect(run.result.evidence.logPath).toBe(run.logPath);
  });

  it("acts on nothing after the step that failed", () => {
    const acted = readEvents(run.logPath).filter((e) => e["kind"] === "replay.acted");
    // It clicked through to the account page, then stopped at the control it
    // could not find. `button_go` — the step after — never ran.
    expect(acted.map((e) => e["control"])).toEqual(["link_12345"]);
  });
});

describe("refuses to act when a moved surface makes two proven rungs disagree", () => {
  let run!: ReplayRun;
  let rewrite!: ReturnType<typeof rewritingActivityPage>;

  beforeAll(async () => {
    // The failure this phase exists for, on a real page.
    //
    // A second `<select>` is inserted between the "Type:" label and the real
    // dropdown. Both rungs of the recorded chain still resolve, uniquely, and
    // both satisfy the recorded `tag: "select"` fingerprint — so every guard
    // that existed before corroboration passes this page. They now name
    // *different* elements: the anchor rung takes the nearest select to the
    // right of "Type:", which is the newcomer, while the CSS rung still takes
    // `select[name="transactionType"]`. One of them is wrong and nothing on the
    // page can say which, so the only safe answer is to act on neither.
    rewrite = rewritingActivityPage([
      {
        find: TYPE_SELECT,
        replace:
          '<select id="typeHint" name="typeHint" class="input"><option value="All">All</option></select>' + TYPE_SELECT,
      },
    ]);
    run = await target.run({ args: { [TYPE_ARGUMENT]: "Debit" }, prepare: rewrite.prepare });
  }, 120_000);

  it("rewrote the page it meant to rewrite", async () => {
    expect(rewrite.misses).toEqual([]);
    expect(rewrite.served).toBeGreaterThan(0);
    // Two selects where the recording proved one, both still there.
    expect(await run.page.locator('select[name="typeHint"]').count()).toBe(1);
    expect(await run.page.locator('select[name="transactionType"]').count()).toBe(1);
  });

  it("names the disagreement and the rungs that disagreed", () => {
    expect(run.result.status).toBe("failed");
    if (run.result.status !== "failed") return;
    expect(run.result.classification).toBe("chain-disagreement");
    expect(run.result.stepId).toBe("s3:select:combobox_all_credit_debit");
    // The whole value of the field is knowing which two rungs to compare.
    expect(run.result.observed).toMatch(/tier 3/);
    expect(run.result.observed).toMatch(/tier 2/);
  });

  it("selects neither candidate — the refusal is a claim about the page", async () => {
    // A result saying `failed` is equally consistent with the engine having
    // acted on one of the two and then reported. Both dropdowns are still on
    // their untouched default.
    const values = await run.page.evaluate(() => [
      (document.querySelector('select[name="typeHint"]') as HTMLSelectElement).value,
      (document.querySelector('select[name="transactionType"]') as HTMLSelectElement).value,
    ]);
    expect(values).toEqual(["All", "All"]);
  });
});

describe("live replay — after", () => {
  it("leaves the fixture database intact", async () => {
    // Never `Clean`, never `Shutdown`, and no write of any kind: the surface was
    // moved by rewriting responses in flight. Read back rather than asserted in
    // prose, so "we never went near admin" is falsifiable.
    expect(await seedAccountIsIntact()).toBe(true);
  });
});
