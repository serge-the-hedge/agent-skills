import { describe, expect, it } from "bun:test";
import { WatcherQueryError } from "./github.ts";
import {
  assessGitHubMerge,
  classifyPr,
  readSnapshot,
  runQueued,
  selectTierMajorStackDecision,
} from "./policy.ts";
import {
  fakeReader,
  failedCheck,
  passingCheck,
  pendingCheck,
} from "./fakes.test-helper.ts";
import type {
  GitHubReader,
  PrContext,
  ProgressVerdict,
  PullRequestFacts,
  RollupState,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

const context = (number: number): PrContext => ({
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(number),
});

describe("readiness truth table", () => {
  it("covers every specified row and every UNKNOWN rollup value", () => {
    const cases: readonly [
      PullRequestFacts["mergeStateStatus"],
      RollupState,
      "allowed" | "refused",
    ][] = [
      ["BLOCKED", "FAILURE", "refused"],
      ["BLOCKED", "ERROR", "refused"],
      ["BLOCKED", "PENDING", "allowed"],
      ["UNSTABLE", "FAILURE", "allowed"],
      ["UNKNOWN", "ERROR", "allowed"],
      ["UNKNOWN", "EXPECTED", "allowed"],
      ["UNKNOWN", "FAILURE", "allowed"],
      ["UNKNOWN", "PENDING", "allowed"],
      ["UNKNOWN", "SUCCESS", "allowed"],
      ["UNKNOWN", null, "allowed"],
      ["CLEAN", "SUCCESS", "allowed"],
    ];
    for (const [mergeStateStatus, headRollupState, expected] of cases) {
      expect(
        assessGitHubMerge({ mergeStateStatus, headRollupState }).kind
      ).toBe(expected);
    }
  });

  it("turns a clean visible list plus GitHub refusal into an explicit CI blocker", async () => {
    const reader = fakeReader({
      facts: { mergeStateStatus: "BLOCKED" },
      fastPath: { kind: "checks", checks: [passingCheck()] },
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    });
    const snapshot = await readSnapshot({
      reader,
      context: context(1),
      pendingHistory: "include",
      allowDraft: false,
    });
    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") throw new Error("expected open snapshot");
    expect(snapshot.ci.kind).toBe("ci-github-rejected");
    expect(classifyPr(snapshot)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "failing-checks" },
    });
  });
});

describe("snapshot query planning", () => {
  it("does not query commit rollups while queued checks are pending", async () => {
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [pendingCheck()] },
    });
    const snapshot = await readSnapshot({
      reader,
      context: context(2),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") throw new Error("expected open snapshot");
    expect(snapshot.ci.kind).toBe("ci-pending");
    expect(reader.calls).toEqual([
      "pullRequest",
      "reviewThreadPage:null",
      "checksFastPath",
    ]);
  });

  it("queries rollups for settled and failed lists", async () => {
    const settled = fakeReader();
    await readSnapshot({
      reader: settled,
      context: context(3),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(settled.calls).toContain("commitRollups");

    const failed = fakeReader({
      fastPath: { kind: "checks", checks: [failedCheck()] },
    });
    await readSnapshot({
      reader: failed,
      context: context(4),
      pendingHistory: "omit",
      allowDraft: false,
    });
    expect(failed.calls).toContain("commitRollups");
  });

  it("short-circuits merged rows before threads and checks", async () => {
    const reader = fakeReader({
      facts: { state: "MERGED", mergedAt: "2026-07-26T00:00:00Z" },
    });
    expect(
      (
        await readSnapshot({
          reader,
          context: context(5),
          pendingHistory: "include",
          allowDraft: false,
        })
      ).kind
    ).toBe("merged");
    expect(reader.calls).toEqual(["pullRequest"]);
  });
});

it("scans stacks tier-major so an upstack conflict outranks frontier CI", async () => {
  const frontier = await readSnapshot({
    reader: fakeReader({
      fastPath: { kind: "checks", checks: [failedCheck()] },
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    }),
    context: context(10),
    pendingHistory: "omit",
    allowDraft: false,
  });
  const upstack = await readSnapshot({
    reader: fakeReader({ facts: { mergeable: "CONFLICTING" } }),
    context: context(11),
    pendingHistory: "omit",
    allowDraft: false,
  });
  const decision = selectTierMajorStackDecision([frontier, upstack]);
  expect(decision).toMatchObject({
    kind: "blocker",
    blocker: { kind: "merge-conflicts", pr: { number: 11 } },
  });
});

it("attributes a stack wait to the PR whose checks are pending, not the bottom", async () => {
  const readyBottom = await readSnapshot({
    reader: fakeReader(),
    context: context(20),
    pendingHistory: "omit",
    allowDraft: false,
  });
  const pendingUpstack = await readSnapshot({
    reader: fakeReader({
      fastPath: { kind: "checks", checks: [pendingCheck("upstack-build")] },
    }),
    context: context(21),
    pendingHistory: "omit",
    allowDraft: false,
  });
  const decision = selectTierMajorStackDecision([readyBottom, pendingUpstack]);
  expect(decision).toMatchObject({
    kind: "waiting",
    frontier: { number: 21 },
    pending: [{ name: "upstack-build" }],
  });
});

it("waits on a draft while checks are pending, then reports the draft gate", async () => {
  const pending = await readSnapshot({
    reader: fakeReader({
      facts: { isDraft: true },
      fastPath: { kind: "checks", checks: [pendingCheck()] },
    }),
    context: context(12),
    pendingHistory: "omit",
    allowDraft: false,
  });
  expect(classifyPr(pending).kind).toBe("waiting");

  const settled = await readSnapshot({
    reader: fakeReader({ facts: { isDraft: true } }),
    context: context(12),
    pendingHistory: "omit",
    allowDraft: false,
  });
  expect(classifyPr(settled)).toMatchObject({
    kind: "blocker",
    blocker: { kind: "merge-gate", reason: "draft-pr" },
  });
});

describe("queued-stack one-shot", () => {
  function queuedRun(reader: GitHubReader, contexts: readonly PrContext[]) {
    const emitted: ProgressVerdict[] = [];
    const [first, ...rest] = contexts;
    if (first === undefined) throw new Error("queue cannot be empty");
    const running = runQueued({
      dependencies: {
        reader,
        clock: { observedAt: () => "2026-07-26T00:00:00.000Z" },
        emit: (verdict) => emitted.push(verdict),
      },
      contexts: [first, ...rest],
      allowDraft: false,
    });
    return { running, emitted };
  }

  function readerMerging(merged: readonly number[]) {
    const base = fakeReader();
    const reads: number[] = [];
    const reader = {
      ...base,
      async pullRequest(pr: PrContext) {
        reads.push(pr.number);
        const facts = await base.pullRequest(pr);
        return merged.includes(pr.number)
          ? {
              ...facts,
              state: "MERGED" as const,
              mergedAt: "2026-07-26T00:00:00Z",
            }
          : facts;
      },
    } satisfies GitHubReader;
    return { reader, reads };
  }

  it("reads each PR once and stops a blocker-free frontier at merge-queue WAITING", async () => {
    const { reader, reads } = readerMerging([]);
    const { running, emitted } = queuedRun(reader, [context(30), context(31)]);
    expect(await running).toMatchObject({
      kind: "WAITING",
      terminal: false,
      exitCode: 5,
      frontier: { number: 30 },
      reason: { kind: "merge-queue", unmergedCount: 2 },
    });
    expect(reads).toEqual([30, 31]);
    expect(emitted.map((event) => event.kind)).toEqual(["QUEUE", "STATUS"]);
  });

  it("reports ADVANCE when the frozen list's bottom has merged", async () => {
    const { reader } = readerMerging([40, 41]);
    const { running, emitted } = queuedRun(reader, [
      context(40),
      context(41),
      context(42),
    ]);
    expect(await running).toMatchObject({
      kind: "WAITING",
      frontier: { number: 42 },
      reason: { kind: "merge-queue", unmergedCount: 1 },
    });
    expect(emitted.at(-1)).toMatchObject({
      kind: "ADVANCE",
      merged: { number: 41 },
      frontier: { number: 42 },
      remaining: 1,
    });
  });

  it("returns COMPLETE once every queued PR has merged", async () => {
    const { reader } = readerMerging([50, 51]);
    const { running, emitted } = queuedRun(reader, [context(50), context(51)]);
    expect(await running).toMatchObject({
      kind: "COMPLETE",
      terminal: true,
      exitCode: 0,
      merged: [{ context: { number: 50 } }, { context: { number: 51 } }],
    });
    expect(emitted.some((event) => event.kind === "ADVANCE")).toBe(false);
  });

  it("turns a query failure into a status-query BLOCKER without retrying", async () => {
    const base = fakeReader();
    const reads: number[] = [];
    const reader = {
      ...base,
      async pullRequest(pr: PrContext) {
        reads.push(pr.number);
        if (pr.number === 61)
          throw new WatcherQueryError({
            kind: "command-exit",
            retryable: true,
            detail: "rate limited",
            code: 1,
          });
        return base.pullRequest(pr);
      },
    } satisfies GitHubReader;
    const { running } = queuedRun(reader, [context(60), context(61)]);
    expect(await running).toMatchObject({
      kind: "BLOCKER",
      exitCode: 7,
      blocker: { kind: "status-query", failure: { detail: "rate limited" } },
    });
    expect(reads).toEqual([60, 61]);
  });
});
