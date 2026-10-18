import {
  WatcherQueryError,
  resolveChecks,
  resolveReviewThreads,
} from "./github.ts";
import type * as T from "./types.ts";
import { nonEmpty } from "./types.ts";
export function assessGitHubMerge(args: {
  readonly mergeStateStatus: T.MergeStateStatus;
  readonly headRollupState: T.RollupState;
}): T.GitHubMergeAssessment {
  if (args.mergeStateStatus === "BLOCKED") {
    if (args.headRollupState === "ERROR" || args.headRollupState === "FAILURE")
      return {
        kind: "refused",
        mergeStateStatus: args.mergeStateStatus,
        headRollupState: args.headRollupState,
      };
    return {
      kind: "allowed",
      basis: "rollup",
      mergeStateStatus: args.mergeStateStatus,
      headRollupState: args.headRollupState,
    };
  }
  return {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: args.mergeStateStatus,
    headRollupState: args.headRollupState,
  };
}
async function mergeAssessment(
  reader: T.GitHubReader,
  facts: T.PullRequestFacts
) {
  const commits = await reader.commitRollups(facts.context);
  const headRollupState =
    facts.headRefOid === null
      ? null
      : (commits.find((commit) => commit.oid === facts.headRefOid)?.state ??
        null);
  return {
    hadPreviousPassingCi: commits.some(
      (commit) => commit.oid !== facts.headRefOid && commit.state === "SUCCESS"
    ),
    github: assessGitHubMerge({
      mergeStateStatus: facts.mergeStateStatus,
      headRollupState,
    }),
  };
}
const AUTOMATION_TOKENS = [
  "bugbot",
  "security review",
  "pr review automation",
  "review automation",
] as const;
export async function readSnapshot(args: {
  readonly reader: T.GitHubReader;
  readonly context: T.PrContext;
  readonly pendingHistory: "include" | "omit";
  readonly allowDraft: boolean;
}): Promise<T.PrSnapshot> {
  const facts = await args.reader.pullRequest(args.context);
  if (facts.state === "MERGED" || facts.mergedAt !== null)
    return { kind: "merged", context: args.context, facts };
  if (facts.state === "CLOSED")
    return { kind: "closed", context: args.context, facts };
  const threads = await resolveReviewThreads(args.reader, args.context);
  const checks = await resolveChecks(args.reader, args.context);
  const failed = nonEmpty(
    checks.checks.filter(
      (check): check is T.FailedCheck => check.kind === "failed"
    )
  );
  const pending = nonEmpty(
    checks.checks.filter(
      (check): check is T.PendingCheck => check.kind === "pending"
    )
  );
  let ci: T.CiState;
  if (failed === null && pending !== null && args.pendingHistory === "omit")
    ci = {
      kind: "ci-pending",
      source: checks.source,
      all: checks.checks,
      failed: [],
      pending,
      hadPreviousPassingCi: false,
    };
  else {
    const merge = await mergeAssessment(args.reader, facts);
    const base = {
      source: checks.source,
      all: checks.checks,
      hadPreviousPassingCi: merge.hadPreviousPassingCi,
    };
    if (failed !== null)
      ci = {
        ...base,
        kind: "ci-failing",
        failed,
        pending: pending ?? [],
        github: merge.github,
      };
    else if (merge.github.kind === "refused")
      ci = {
        ...base,
        kind: "ci-github-rejected",
        failed: [],
        pending: pending ?? [],
        github: merge.github,
      };
    else if (pending !== null)
      ci = { ...base, kind: "ci-pending", failed: [], pending };
    else
      ci = {
        ...base,
        kind: "ci-clean",
        failed: [],
        pending: [],
        github: merge.github,
      };
  }
  return {
    kind: "open",
    context: args.context,
    facts,
    threads,
    ci,
    reviewAutomationRunning: checks.checks.some(
      (check) =>
        check.kind === "pending" &&
        AUTOMATION_TOKENS.some((token) =>
          check.name.toLowerCase().includes(token)
        )
    ),
  };
}
const conflictBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.facts.mergeable === "CONFLICTING" ||
    row.facts.mergeStateStatus === "DIRTY" ||
    row.facts.mergeStateStatus === "CONFLICTING")
    ? { kind: "merge-conflicts", pr: row.context, facts: row.facts }
    : null;
function threadBlocker(row: T.PrSnapshot): T.MergeBlocker | null {
  if (row.kind !== "open") return null;
  const threads = nonEmpty(row.threads);
  return threads === null
    ? null
    : { kind: "review-threads", pr: row.context, threads };
}
const ciBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.ci.kind === "ci-failing" || row.ci.kind === "ci-github-rejected")
    ? { kind: "failing-checks", pr: row.context, ci: row.ci }
    : null;
function gateReason(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeGateReason | null {
  if (row.kind === "merged") return null;
  if (row.kind === "closed") return "closed-without-merge";
  if (row.facts.isDraft && !allowDraft) return "draft-pr";
  return row.facts.reviewDecision === "CHANGES_REQUESTED"
    ? "changes-requested"
    : null;
}
function gateBlocker(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeBlocker | null {
  const reason = gateReason(row, allowDraft);
  return reason === null ||
    (reason === "draft-pr" &&
      row.kind === "open" &&
      row.ci.kind === "ci-pending")
    ? null
    : { kind: "merge-gate", pr: row.context, reason };
}
function readyContribution(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.ReadyPr | T.MergedPr | null {
  if (row.kind === "merged")
    return {
      kind: "merged-pr",
      context: row.context,
      mergedAt: row.facts.mergedAt,
    };
  if (
    row.kind !== "open" ||
    row.ci.kind !== "ci-clean" ||
    row.threads.length !== 0 ||
    conflictBlocker(row) !== null ||
    gateReason(row, allowDraft) !== null
  )
    return null;
  const reviewDecision = row.facts.reviewDecision;
  if (reviewDecision === "CHANGES_REQUESTED") return null;
  return {
    kind: "ready-pr",
    context: row.context,
    proof: {
      mergeability: "clear",
      threads: [],
      ci: row.ci,
      gate: {
        state: "OPEN",
        reviewDecision,
        draft: row.facts.isDraft ? "draft-allowed" : "not-draft",
      },
    },
  };
}
export function classifyPr(
  row: T.PrSnapshot,
  allowDraft = false
): T.PrDecision {
  for (const blocker of [
    conflictBlocker(row),
    threadBlocker(row),
    ciBlocker(row),
    gateBlocker(row, allowDraft),
  ])
    if (blocker !== null) return { kind: "blocker", blocker };
  if (row.kind === "open" && row.ci.kind === "ci-pending")
    return { kind: "waiting", frontier: row.context, pending: row.ci.pending };
  const ready = readyContribution(row, allowDraft);
  if (ready === null) throw new Error("snapshot has no classified decision");
  return ready.kind === "merged-pr"
    ? { kind: "merged", pr: ready }
    : { kind: "ready", pr: ready };
}
export function selectTierMajorStackDecision(
  rows: T.NonEmpty<T.PrSnapshot>,
  allowDraft = false
): T.StackDecision {
  for (const tier of [conflictBlocker, threadBlocker, ciBlocker])
    for (const row of rows) {
      const blocker = tier(row);
      if (blocker !== null) return { kind: "blocker", blocker };
    }
  for (const row of rows) {
    const blocker = gateBlocker(row, allowDraft);
    if (blocker !== null) return { kind: "blocker", blocker };
  }
  for (const row of rows)
    if (row.kind === "open" && row.ci.kind === "ci-pending")
      return {
        kind: "waiting",
        frontier: row.context,
        pending: row.ci.pending,
      };
  const prs = nonEmpty(
    rows
      .map((row) => readyContribution(row, allowDraft))
      .filter((row): row is T.ReadyPr | T.MergedPr => row !== null)
  );
  if (prs === null || prs.length !== rows.length)
    throw new Error("stack has no classified decision");
  return { kind: "clear", prs };
}
interface Envelope<M extends T.WatchMode> {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly observedAt: string;
  readonly mode: M;
}
type Payload<V> = V extends unknown
  ? Omit<V, keyof Envelope<T.WatchMode>>
  : never;
type VerdictPayload = Payload<T.WatcherVerdict>;
export interface VerdictStamp<M extends T.WatchMode = T.WatchMode> {
  <const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  <const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;
}
export function verdictFactory<M extends T.WatchMode>(
  clock: WatchClock,
  mode: M
): VerdictStamp<M> {
  let sequence = 0;
  function stamp<const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  function stamp<const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;
  function stamp<const P extends VerdictPayload>(
    payload: P,
    override?: T.WatchMode
  ): Envelope<T.WatchMode> & P {
    return {
      schemaVersion: 1,
      sequence: (sequence += 1),
      observedAt: clock.observedAt(),
      mode: override ?? mode,
      ...payload,
    };
  }
  return stamp;
}
function blockerVerdict(
  stamp: VerdictStamp,
  blocker: T.MergeBlocker
): T.BlockerVerdict {
  switch (blocker.kind) {
    case "merge-conflicts":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 2, blocker });
    case "review-threads":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 3, blocker });
    case "failing-checks":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 4, blocker });
    case "merge-gate":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 6, blocker });
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}
export function statusQueryVerdict(
  stamp: VerdictStamp,
  failure: T.QueryFailure
): T.BlockerVerdict {
  return stamp({
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failure },
  });
}
export interface WatchClock {
  observedAt(): string;
}
export interface RunDependencies {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly emit: (verdict: T.ProgressVerdict) => void;
}
async function readRows(args: {
  readonly reader: T.GitHubReader;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly pendingHistory: "include" | "omit";
  readonly allowDraft: boolean;
}): Promise<T.NonEmpty<T.PrSnapshot>> {
  const rows: T.PrSnapshot[] = [];
  for (const context of args.contexts)
    rows.push(
      await readSnapshot({
        reader: args.reader,
        context,
        pendingHistory: args.pendingHistory,
        allowDraft: args.allowDraft,
      })
    );
  const complete = nonEmpty(rows);
  if (complete === null) throw new Error("watch context cannot be empty");
  return complete;
}
export async function runSimple(args: {
  readonly dependencies: RunDependencies;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly mode: T.WatchMode;
  readonly statusOnly: boolean;
  readonly allowDraft: boolean;
}): Promise<T.RunVerdict> {
  const stamp = verdictFactory(args.dependencies.clock, args.mode);
  let complete: T.NonEmpty<T.PrSnapshot>;
  try {
    complete = await readRows({
      reader: args.dependencies.reader,
      contexts: args.contexts,
      pendingHistory: "include",
      allowDraft: args.allowDraft,
    });
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    return statusQueryVerdict(stamp, error.failure);
  }
  if (args.statusOnly)
    return stamp({
      kind: "STATUS",
      terminal: true,
      exitCode: 0,
      reason: "status-only",
      rows: complete,
    });
  if (args.mode === "queued-stack")
    throw new Error("queued-stack requires status-only in the simple runner");
  if (args.mode === "stack")
    args.dependencies.emit(
      stamp(
        { kind: "STATUS", terminal: false, reason: "poll", rows: complete },
        args.mode
      )
    );
  const decision =
    args.mode === "single"
      ? classifyPr(complete[0], args.allowDraft)
      : selectTierMajorStackDecision(complete, args.allowDraft);
  if (decision.kind === "blocker")
    return blockerVerdict(stamp, decision.blocker);
  if (decision.kind === "ready" || decision.kind === "merged")
    return stamp(
      {
        kind: "READY",
        terminal: true,
        exitCode: 0,
        scope: { kind: "single", pr: decision.pr },
      },
      args.mode
    );
  if (decision.kind === "clear")
    return stamp(
      {
        kind: "READY",
        terminal: true,
        exitCode: 0,
        scope: { kind: "stack", prs: decision.prs },
      },
      args.mode
    );
  return stamp({
    kind: "WAITING",
    terminal: false,
    exitCode: 5,
    frontier: decision.frontier,
    reason: { kind: "pending-checks", pending: decision.pending },
  });
}
export type QueueEvaluation =
  | {
      readonly kind: "complete";
      readonly merged: T.NonEmpty<T.MergedPr>;
    }
  | {
      readonly kind: "blocker";
      readonly blocker: T.MergeBlocker;
    }
  | {
      readonly kind: "waiting";
      readonly frontier: T.PrContext;
      readonly reason:
        | {
            readonly kind: "pending-checks";
            readonly pending: T.NonEmpty<T.PendingCheck>;
          }
        | { readonly kind: "merge-queue"; readonly unmergedCount: number };
    };
export function evaluateQueue(
  rows: T.NonEmpty<T.PrSnapshot>,
  allowDraft: boolean
): QueueEvaluation {
  const active = nonEmpty(rows.filter((row) => row.kind !== "merged"));
  if (active === null) {
    const merged = nonEmpty(
      rows.map((row) => ({
        kind: "merged-pr" as const,
        context: row.context,
        mergedAt: row.facts.mergedAt,
      }))
    );
    if (merged === null) throw new Error("empty queue cannot complete");
    return { kind: "complete", merged };
  }
  const decision = selectTierMajorStackDecision(active, allowDraft);
  if (decision.kind === "blocker")
    return { kind: "blocker", blocker: decision.blocker };
  const row = active[0];
  const pending =
    row.kind === "open" && row.ci.kind === "ci-pending" ? row.ci.pending : null;
  return {
    kind: "waiting",
    frontier: row.context,
    reason:
      pending === null
        ? { kind: "merge-queue", unmergedCount: active.length }
        : { kind: "pending-checks", pending },
  };
}
export function queueAdvance(rows: T.NonEmpty<T.PrSnapshot>): {
  readonly merged: T.PrContext;
  readonly frontier: T.PrContext;
  readonly remaining: number;
} | null {
  const index = rows.findIndex((row) => row.kind !== "merged");
  const merged = rows[index - 1];
  const frontier = rows[index];
  if (merged === undefined || frontier === undefined) return null;
  return {
    merged: merged.context,
    frontier: frontier.context,
    remaining: rows.filter((row) => row.kind !== "merged").length,
  };
}
export async function runQueued(args: {
  readonly dependencies: RunDependencies;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly allowDraft: boolean;
}): Promise<T.QueueVerdict> {
  const stamp = verdictFactory(args.dependencies.clock, "queued-stack");
  args.dependencies.emit(
    stamp({ kind: "QUEUE", terminal: false, queue: args.contexts })
  );
  let rows: T.NonEmpty<T.PrSnapshot>;
  try {
    rows = await readRows({
      reader: args.dependencies.reader,
      contexts: args.contexts,
      pendingHistory: "omit",
      allowDraft: args.allowDraft,
    });
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    return statusQueryVerdict(stamp, error.failure);
  }
  args.dependencies.emit(
    stamp({
      kind: "STATUS",
      terminal: false,
      reason: "whole-stack-sweep",
      rows,
    })
  );
  const evaluation = evaluateQueue(rows, args.allowDraft);
  if (evaluation.kind === "complete")
    return stamp({
      kind: "COMPLETE",
      terminal: true,
      exitCode: 0,
      queue: args.contexts,
      merged: evaluation.merged,
    });
  const advance = queueAdvance(rows);
  if (advance !== null)
    args.dependencies.emit(
      stamp({ kind: "ADVANCE", terminal: false, ...advance })
    );
  if (evaluation.kind === "blocker")
    return blockerVerdict(stamp, evaluation.blocker);
  return stamp({
    kind: "WAITING",
    terminal: false,
    exitCode: 5,
    frontier: evaluation.frontier,
    reason: evaluation.reason,
  });
}
