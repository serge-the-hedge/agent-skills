import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotFoundError,
  UserError,
  openStore,
  parseVerdict,
  type OpenStoreOptions,
  type Store,
} from "./store.ts";

const SCRIPT = join(import.meta.dir, "orch.ts");
const directories: string[] = [];
const handles: Store[] = [];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-test-"));
  directories.push(directory);
  return directory;
}

function useStore(
  directory: string,
  options?: OpenStoreOptions
): Store {
  const store = openStore(directory, options);
  handles.push(store);
  return store;
}

async function initializedStore(): Promise<{
  readonly directory: string;
  readonly store: Store;
}> {
  const directory = await makeDirectory();
  const store = useStore(directory);
  await store.init();
  return { directory, store };
}

function git({
  args,
  repo,
}: {
  args: readonly string[];
  repo: string;
}): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString().trim();
}

async function makeGitStack(directory: string): Promise<{
  readonly repo: string;
  readonly mergedSha: string;
  readonly closedSha: string;
  readonly openSha: string;
  readonly draftSha: string;
  readonly singleSha: string;
}> {
  const repo = join(directory, "repo");
  await mkdir(repo);
  git({ repo, args: ["init", "--initial-branch=main"] });
  git({ repo, args: ["config", "user.name", "Orch Test"] });
  git({ repo, args: ["config", "user.email", "orch@example.com"] });
  git({
    repo,
    args: ["remote", "add", "origin", "git@github.com:Acme/Widgets.git"],
  });
  await writeFile(join(repo, "main.txt"), "main\n");
  git({ repo, args: ["add", "."] });
  git({ repo, args: ["commit", "-m", "main"] });
  git({ repo, args: ["branch", "single"] });

  const branches = [
    "stack/merged",
    "stack/closed",
    "stack/open",
    "stack/draft",
  ];
  for (const [index, branch] of branches.entries()) {
    git({ repo, args: ["checkout", "-b", branch] });
    await writeFile(join(repo, `stack-${index}.txt`), `${branch}\n`);
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", branch] });
  }
  git({ repo, args: ["checkout", "stack/open"] });

  return {
    repo,
    mergedSha: git({ repo, args: ["rev-parse", "stack/merged"] }),
    closedSha: git({ repo, args: ["rev-parse", "stack/closed"] }),
    openSha: git({ repo, args: ["rev-parse", "stack/open"] }),
    draftSha: git({ repo, args: ["rev-parse", "stack/draft"] }),
    singleSha: git({ repo, args: ["rev-parse", "single"] }),
  };
}

interface DumpPullRequest {
  readonly host?: string;
  readonly repository: string;
  readonly number: number;
  readonly state: string | null;
  readonly headBranch: string | null;
  readonly isDraft?: boolean;
}

function openPr(number: number, headBranch: string): DumpPullRequest {
  return { repository: "acme/widgets", number, state: "open", headBranch };
}

const STACK_PRS: readonly DumpPullRequest[] = [
  {
    repository: "acme/widgets",
    number: 10,
    state: "merged",
    headBranch: "stack/merged",
  },
  {
    repository: "acme/widgets",
    number: 13,
    state: "closed",
    headBranch: "stack/closed",
  },
  openPr(11, "stack/open"),
  { ...openPr(14, "stack/draft"), isDraft: true },
  openPr(12, "single"),
  {
    repository: "other/repo",
    number: 40,
    state: "open",
    headBranch: "elsewhere/base",
  },
  {
    repository: "other/repo",
    number: 41,
    state: "open",
    headBranch: "elsewhere/top",
  },
  {
    repository: "other/repo",
    number: 96,
    state: null,
    headBranch: null,
  },
];

const STACK_CHAINS: readonly (readonly number[])[] = [
  [10, 13, 11, 14],
  [12],
  [40, 41],
  [96],
];

async function writeDump({
  chains,
  directory,
  pullRequests,
}: {
  chains: readonly (readonly number[])[];
  directory: string;
  pullRequests: readonly DumpPullRequest[];
}): Promise<string> {
  const path = join(directory, `prs-${crypto.randomUUID()}.json`);
  await writeFile(
    path,
    JSON.stringify({
      pullRequests: pullRequests.map((row) => ({
        host: "github.com",
        url: `https://github.com/${row.repository}/pull/${row.number}`,
        title: `PR ${row.number}`,
        baseBranch: "main",
        isDraft: false,
        stack: null,
        ...row,
      })),
      chains: chains.map((numbers) => ({ kind: "native", numbers })),
    })
  );
  return path;
}

const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function withEnv(
  values: Readonly<Record<string, string>>,
  run: () => Promise<void>
): Promise<void> {
  const saved = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): RunResult {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

afterEach(async () => {
  for (const store of handles.splice(0).reverse()) {
    await store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Store", () => {
  it("initializes an idempotent plain-file store and releases its lock", async () => {
    const directory = await makeDirectory();
    const store = useStore(directory);

    expect(await store.init()).toEqual({ store: directory });
    const firstUnits = await readFile(join(directory, "units.tsv"), "utf8");
    const firstLedger = await readFile(
      join(directory, "ledger.tsv"),
      "utf8"
    );

    expect(await store.init()).toEqual({ store: directory });
    expect(await readFile(join(directory, "units.tsv"), "utf8")).toBe(
      firstUnits
    );
    expect(await readFile(join(directory, "ledger.tsv"), "utf8")).toBe(
      firstLedger
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".orch.lock",
      "frontier.json",
      "gates.md",
      "inbox",
      "ledger.tsv",
      "preferences.md",
      "units.tsv",
    ]);

    await store.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("composes unit add, set, get, list, and counts", async () => {
    const { store } = await initializedStore();

    expect(
      await store.units.add({
        id: "u1",
        track: "build",
        brief: "briefs/u1.md",
      })
    ).toMatchObject({ id: "u1", state: "pending" });
    expect(
      await store.units.add({ id: "=SUM(A1)", track: "+build" })
    ).toMatchObject({ id: "'=SUM(A1)", track: "'+build" });

    const updated = await store.units.set({
      id: "u1",
      state: "done",
      branch: "poteto/u1",
      pr: 184530,
      sha: "abc123",
    });
    expect(updated).toEqual({
      id: "u1",
      track: "build",
      state: "done",
      branch: "poteto/u1",
      pr: "184530",
      sha: "abc123",
      brief: "briefs/u1.md",
    });
    expect(await store.units.get("u1")).toEqual(updated);
    expect(
      await store.units.list({ state: "done", track: "build" })
    ).toEqual([updated]);
    expect(await store.units.counts()).toEqual({ done: 1, pending: 1 });
    await expect(
      store.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow("unit u1 already exists");
    await expect(
      store.units.set({ id: "missing", state: "done" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records, replaces, checks, and summarizes typed ledger verdicts", async () => {
    const { store } = await initializedStore();

    try {
      await store.ledger.check({ pr: 184530, sha: "abc123" });
      throw new Error("expected ledger check to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      if (error instanceof NotFoundError) {
        expect(error.output).toEqual({
          compact: "NOT-VERIFIED",
          json: {
            pr: "184530",
            sha: "abc123",
            verdict: "NOT-VERIFIED",
          },
        });
      }
    }
    expect(() => parseVerdict("looks-good")).toThrow("verdict must be");

    const recorded = await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "unit-test-verified",
      evidence: "reports/verify.md",
      verifier: "opus",
    });
    expect(await store.ledger.check({ pr: 184530, sha: "abc123" })).toEqual(
      recorded
    );
    expect(await store.ledger.summary()).toEqual({
      "unit-test-verified": 1,
    });

    await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "live-ui-verified",
      evidence: "reports/live.md",
    });
    expect(await store.ledger.summary()).toEqual({
      "live-ui-verified": 1,
    });
  });

  it("pushes, peeks, and atomically drains inbox pointers", async () => {
    const { directory, store } = await initializedStore();

    const first = await store.inbox.push({
      agent: "worker-1",
      unit: "u1",
      status: "done",
      report: "reports/u1.md",
    });
    expect(first.pointer).toMatchObject({ unit: "u1", status: "done" });
    expect(first.filename).toEndWith(".tsv");
    await store.inbox.push({
      agent: "worker-2",
      unit: "u2",
      status: "failed",
    });

    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.peek()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.drain()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(0);
    expect(await readdir(join(directory, "inbox"))).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".inbox-drain-")
      )
    ).toEqual([]);
  });

  it("replaces a stale lock whose holder pid is dead", async () => {
    const { directory } = await initializedStore();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);

    const stale: string[] = [];
    const recovered = useStore(directory, {
      onStaleLock: (holder) => stale.push(holder),
    });
    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stale).toEqual([String(exited.pid)]);
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("blocks a writer and steals the pid lock only with force", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    await writeFile(join(directory, ".orch.lock"), `${process.pid}\n`);

    const blocked = useStore(directory);
    await expect(
      blocked.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow(`store lock held by pid ${process.pid}`);

    const stolen: string[] = [];
    const forced = useStore(directory, {
      force: true,
      onLockStolen: (holder) => stolen.push(holder),
    });
    expect(
      await forced.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stolen).toEqual([String(process.pid)]);
    await forced.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("parks gates, stores standing orders, and renders status", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "u1", track: "build" });
    expect(
      await store.gates.park({
        id: "release",
        question: "Ship now?",
        options: "ship,wait",
        defaultAnswer: "wait",
      })
    ).toMatchObject({ kind: "open", id: "release" });
    expect(
      await store.standing.add({ line: "Never force push." })
    ).toEqual({ number: 1, line: "Never force push." });

    const first = await store.status.render();
    expect(first.changed).toBe("first render");
    expect(first.summary.openGateIds).toEqual(["release"]);
    expect(await readFile(join(directory, "status.md"), "utf8")).toContain(
      "| release | open | Ship now? |"
    );
    expect((await store.status.render()).changed).toBe("no derived changes");

    expect(
      await store.gates.resolve({ id: "release", answer: "ship" })
    ).toMatchObject({ kind: "resolved", answer: "ship" });
    expect((await store.status.render()).changed).toBe("open gates 1->0");
    expect(await store.gates.list()).toEqual([]);
    expect(await store.standing.show()).toEqual([
      { number: 1, line: "Never force push." },
    ]);
  });

  it("resolves merged, closed, open, and draft PRs from the thread chain with head SHAs", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: STACK_PRS,
      chains: STACK_CHAINS,
    });

    expect(await store.frontier.set({ chain, repo: stack.repo })).toEqual({
      generation: 1,
      prs: [
        {
          pr: 10,
          branches: "stack/merged",
          sha: stack.mergedSha,
          state: "MERGED",
        },
        {
          pr: 13,
          branches: "stack/closed",
          sha: stack.closedSha,
          state: "CLOSED",
        },
        {
          pr: 11,
          branches: "stack/open",
          sha: stack.openSha,
          state: "OPEN",
        },
        {
          pr: 14,
          branches: "stack/draft",
          sha: stack.draftSha,
          state: "OPEN",
        },
      ],
      lowestUnmerged: 11,
    });
    expect(
      (await store.frontier.set({ chain, repo: stack.repo, prs: [10, 13, 11, 14] }))
        .generation
    ).toBe(2);
    expect(
      (await store.frontier.set({ chain, repo: stack.repo, prs: [12] })).prs
    ).toEqual([
      { pr: 12, branches: "single", sha: stack.singleSha, state: "OPEN" },
    ]);
    expect((await store.frontier.show()).generation).toBe(3);
  });

  it("chooses between stacked chains only by pin and lists the candidates otherwise", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: [
        ...STACK_PRS,
        openPr(20, "second/base"),
        openPr(21, "second/top"),
      ],
      chains: [...STACK_CHAINS, [20, 21]],
    });

    await expect(
      store.frontier.set({ chain, repo: stack.repo })
    ).rejects.toThrow(
      "cannot choose a chain for github.com/acme/widgets: 2 chains have more than one PR; pin one with --prs; candidate chains: 10,13,11,14 | 12 | 20,21"
    );
    expect(
      (
        await store.frontier.set({ chain, repo: stack.repo, prs: [10, 13, 11, 14] })
      ).prs.map((row) => row.pr)
    ).toEqual([10, 13, 11, 14]);

    const singles = await writeDump({
      directory,
      pullRequests: STACK_PRS,
      chains: [[12], [40, 41]],
    });
    await expect(
      store.frontier.set({ chain: singles, repo: stack.repo })
    ).rejects.toThrow(
      "cannot choose a chain for github.com/acme/widgets: no chain has more than one PR; pin one with --prs; candidate chains: 12"
    );
  });

  it("fails closed on a chain whose numbers collide across repositories, even when pinned", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: [
        openPr(10, "stack/merged"),
        openPr(11, "stack/open"),
        { ...openPr(10, "elsewhere/base"), repository: "other/repo" },
        { ...openPr(11, "elsewhere/top"), repository: "other/repo" },
      ],
      chains: [[10], [11], [10, 11]],
    });
    const ambiguous =
      "chain 10,11 is ambiguous for github.com/acme/widgets: PR #10 matches github.com/acme/widgets, github.com/other/repo; PR #11 matches github.com/acme/widgets, github.com/other/repo";

    await expect(
      store.frontier.set({ chain, repo: stack.repo })
    ).rejects.toThrow(ambiguous);
    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [10, 11] })
    ).rejects.toThrow(ambiguous);
    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [10] })
    ).rejects.toThrow("chain 10 is ambiguous");

    const crossHost = await writeDump({
      directory,
      pullRequests: [
        ...STACK_PRS,
        openPr(1, "stack/merged"),
        openPr(2, "stack/open"),
        { ...openPr(1, "mirror/base"), host: "ghe.example.com" },
      ],
      chains: [...STACK_CHAINS, [1, 2]],
    });
    await expect(
      store.frontier.set({ chain: crossHost, repo: stack.repo })
    ).rejects.toThrow(
      "cannot choose a chain for github.com/acme/widgets: 2 chains have more than one PR; pin one with --prs; candidate chains: 10,13,11,14 | 12 | 1,2 (ambiguous)"
    );
    expect(
      (
        await store.frontier.set({
          chain: crossHost,
          repo: stack.repo,
          prs: [10, 13, 11, 14],
        })
      ).prs.map((row) => row.pr)
    ).toEqual([10, 13, 11, 14]);
    await expect(
      store.frontier.set({ chain: crossHost, repo: stack.repo, prs: [1, 2] })
    ).rejects.toThrow(
      "chain 1,2 is ambiguous for github.com/acme/widgets: PR #1 matches github.com/acme/widgets, ghe.example.com/acme/widgets"
    );
    expect((await store.frontier.show()).generation).toBe(1);
  });

  it("matches the origin by host as well as owner/name", async () => {
    await withEnv(ISOLATED_GIT, async () => {
      const { directory, store } = await initializedStore();
      const stack = await makeGitStack(directory);
      const otherHost = await writeDump({
        directory,
        pullRequests: STACK_PRS.map((row) => ({
          ...row,
          host: "GHE.example.com",
        })),
        chains: STACK_CHAINS,
      });
      await expect(
        store.frontier.set({ chain: otherHost, repo: stack.repo })
      ).rejects.toThrow(
        "cannot choose a chain for github.com/acme/widgets: no chain has more than one PR; pin one with --prs; candidate chains: none"
      );

      const chain = await writeDump({
        directory,
        pullRequests: STACK_PRS.map((row) => ({
          ...row,
          host: "GitHub.com",
          repository: row.repository.toUpperCase(),
        })),
        chains: STACK_CHAINS,
      });
      const remotes = [
        "git@github.com:Acme/Widgets.git",
        "git@github.com:acme/widgets",
        "ssh://git@github.com/Acme/Widgets.git",
        "ssh://git@GitHub.com:22/acme/widgets/",
        "https://github.com/Acme/Widgets.git",
        "https://token@github.com/acme/widgets/",
      ];
      for (const url of remotes) {
        git({ repo: stack.repo, args: ["remote", "set-url", "origin", url] });
        expect(
          (await store.frontier.set({ chain, repo: stack.repo })).prs.map(
            (row) => row.pr
          )
        ).toEqual([10, 13, 11, 14]);
      }

      git({
        repo: stack.repo,
        args: ["remote", "set-url", "origin", "git@ghe.example.com:Acme/Widgets.git"],
      });
      await expect(
        store.frontier.set({ chain, repo: stack.repo })
      ).rejects.toThrow(
        "cannot choose a chain for ghe.example.com/acme/widgets: no chain has more than one PR"
      );
      for (const url of ["/srv/git/widgets.git", "https://github.com/acme"]) {
        git({ repo: stack.repo, args: ["remote", "set-url", "origin", url] });
        await expect(
          store.frontier.set({ chain, repo: stack.repo })
        ).rejects.toThrow(
          `origin remote ${url} does not name a host and owner/name`
        );
      }
      expect((await store.frontier.show()).generation).toBe(remotes.length);
    });
  });

  it("reports pin drift against the chosen chain without advancing the generation", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: STACK_PRS,
      chains: STACK_CHAINS,
    });

    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [10, 11, 12] })
    ).rejects.toThrow(
      "frontier pin mismatch: missing from resolved chain: 12; extra in resolved chain: 13,14"
    );
    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [13, 10, 11, 14] })
    ).rejects.toThrow(
      "frontier pin mismatch: order differs: expected 13,10,11,14; resolved 10,13,11,14"
    );
    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [10, 10] })
    ).rejects.toThrow("--prs must not contain duplicates");
    expect((await store.frontier.show()).generation).toBe(0);
  });

  it("rejects malformed thread JSON without advancing the frontier", async () => {
    const { directory, store } = await initializedStore();
    const chain = join(directory, "invalid.json");
    await writeFile(chain, "this is not a thread dump\n");

    await expect(
      store.frontier.set({ chain, repo: directory })
    ).rejects.toThrow(`chain file ${chain} is not valid JSON`);
    expect(await store.frontier.show()).toEqual({
      generation: 0,
      prs: [],
      lowestUnmerged: null,
    });
  });

  it("rejects a chain missing a pull request row and lists remaining candidates", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: STACK_PRS.filter((row) => row.number !== 11),
      chains: STACK_CHAINS,
    });
    const diagnostic =
      "cannot choose a chain for github.com/acme/widgets: no chain has more than one PR; pin one with --prs; candidate chains: 12";

    await expect(
      store.frontier.set({ chain, repo: stack.repo })
    ).rejects.toThrow(diagnostic);
    await expect(
      store.frontier.set({ chain, repo: stack.repo, prs: [10, 13, 11, 14] })
    ).rejects.toThrow(diagnostic);
    expect(await store.frontier.show()).toEqual({
      generation: 0,
      prs: [],
      lowestUnmerged: null,
    });
  });

  it("fails closed on an unknown state or head branch in the chosen chain", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const withRow = (row: DumpPullRequest): Promise<string> =>
      writeDump({
        directory,
        pullRequests: STACK_PRS.map((pr) => (pr.number === 11 ? row : pr)),
        chains: STACK_CHAINS,
      });

    await expect(
      store.frontier.set({
        chain: await withRow({ ...openPr(11, "stack/open"), state: null }),
        repo: stack.repo,
      })
    ).rejects.toThrow(
      "PR #11 has unknown state null; refresh the list_thread_pull_requests dump"
    );
    await expect(
      store.frontier.set({
        chain: await withRow({ ...openPr(11, "stack/open"), state: "draft" }),
        repo: stack.repo,
      })
    ).rejects.toThrow('PR #11 has unknown state "draft"');
    await expect(
      store.frontier.set({
        chain: await withRow({ ...openPr(11, "stack/open"), headBranch: null }),
        repo: stack.repo,
      })
    ).rejects.toThrow(
      "PR #11 has no head branch; refresh the list_thread_pull_requests dump"
    );
    await expect(
      store.frontier.set({
        chain: await withRow(openPr(11, "stack/missing")),
        repo: stack.repo,
      })
    ).rejects.toThrow("git rev-parse stack/missing failed");

    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, '{"pullRequests":[]}\n');
    await expect(
      store.frontier.set({ chain: malformed, repo: stack.repo })
    ).rejects.toThrow("must hold the list_thread_pull_requests result");
    expect((await store.frontier.show()).generation).toBe(0);
  });

  it("rejects malformed TSV, verdict, frontier, and inbox data", async () => {
    const { directory, store } = await initializedStore();

    await writeFile(join(directory, "units.tsv"), "wrong\n");
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has an invalid header"
    );
    await writeFile(
      join(directory, "units.tsv"),
      "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\nshort\trow\n"
    );
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has a malformed row"
    );

    await writeFile(
      join(directory, "ledger.tsv"),
      "pr\tsha\tverdict\tevidence\tverifier\tts\n1\tsha\tinvalid\treport\tme\tnow\n"
    );
    await expect(store.ledger.summary()).rejects.toThrow(
      "ledger.tsv has invalid verdict invalid"
    );

    await writeFile(join(directory, "frontier.json"), '{"generation":"1"}\n');
    await expect(store.frontier.show()).rejects.toThrow(
      "frontier.json has an invalid shape"
    );

    await writeFile(join(directory, "inbox", "bad.tsv"), "too\tshort\n");
    await expect(store.inbox.peek()).rejects.toThrow(
      "inbox pointer bad.tsv is malformed"
    );
  });

  it("rejects operations after close", async () => {
    const { store } = await initializedStore();
    await store.close();
    await expect(store.units.list()).rejects.toThrow("store is closed");
    await expect(store.status.render()).rejects.toBeInstanceOf(UserError);
  });
});

describe("orch CLI", () => {
  it("prints commander help and rejects invalid parsing with exit 1", async () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Commands:");
    expect(help.stdout).toContain("unit");
    expect(help.stdout).toContain("ledger");

    const frontierHelp = runCli(["frontier", "set", "--help"]);
    expect(frontierHelp.code).toBe(0);
    expect(frontierHelp.stdout).toContain("--chain <file>");
    expect(frontierHelp.stdout).toContain("--repo <dir>");
    expect(frontierHelp.stdout).toContain("--prs <n,...>");

    const directory = await makeDirectory();
    const invalid = runCli(["--store", directory, "unit", "add", "u1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("required option '--track <track>'");

    const missingChain = runCli([
      "--store",
      directory,
      "frontier",
      "set",
      "--repo",
      directory,
    ]);
    expect(missingChain.code).toBe(1);
    expect(missingChain.stderr).toContain(
      "required option '--chain <file>'"
    );

    const badForge = runCli([
      "--store",
      directory,
      "frontier",
      "set",
      "--chain",
      join(directory, "prs.json"),
      "--repo",
      directory,
      "--forge",
      "unsupported",
    ]);
    expect(badForge.code).toBe(1);
    expect(badForge.stderr).toContain("unknown option '--forge'");
  });

  it("sets and reads the thread frontier through the CLI with ORCH_REPO", async () => {
    const directory = await makeDirectory();
    const stack = await makeGitStack(directory);
    const chain = await writeDump({
      directory,
      pullRequests: STACK_PRS,
      chains: STACK_CHAINS,
    });
    const env = {
      ...process.env,
      ORCH_STORE: directory,
      ORCH_REPO: stack.repo,
    };
    expect(runCli(["init"], env).code).toBe(0);

    const result = runCli(
      ["frontier", "set", "--chain", chain, "--prs", "10,13,11,14", "--json"],
      env
    );
    const expectedFrontier = {
      generation: 1,
      prs: [
        { pr: 10, branches: "stack/merged", sha: stack.mergedSha, state: "MERGED" },
        { pr: 13, branches: "stack/closed", sha: stack.closedSha, state: "CLOSED" },
        { pr: 11, branches: "stack/open", sha: stack.openSha, state: "OPEN" },
        { pr: 14, branches: "stack/draft", sha: stack.draftSha, state: "OPEN" },
      ],
      lowestUnmerged: 11,
    };
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedFrontier);

    const shown = runCli(["frontier", "show", "--json"], env);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(expectedFrontier);
    expect(
      JSON.parse(await readFile(join(directory, "frontier.json"), "utf8"))
    ).toEqual(expectedFrontier);
  });

  it("accepts ORCH_STORE and emits complete JSON", async () => {
    const directory = await makeDirectory();
    const env = { ...process.env, ORCH_STORE: directory };
    expect(runCli(["init"], env).code).toBe(0);

    const added = runCli(
      ["unit", "add", "u1", "--track", "build", "--json"],
      env
    );
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      id: "u1",
      track: "build",
      state: "pending",
      branch: "",
      pr: "",
      sha: "",
      brief: "",
    });
  });

  it("maps user and not-found outcomes to the preserved exit codes", async () => {
    const directory = await makeDirectory();
    expect(runCli(["--store", directory, "init"]).code).toBe(0);

    const missingRepo = runCli([
      "--store",
      directory,
      "frontier",
      "set",
      "--chain",
      join(directory, "prs.json"),
    ]);
    expect(missingRepo.code).toBe(1);
    expect(missingRepo.stderr).toContain(
      "set --repo <dir> or ORCH_REPO"
    );

    const userError = runCli([
      "--store",
      directory,
      "unit",
      "add",
      "",
      "--track",
      "build",
    ]);
    expect(userError.code).toBe(1);
    expect(userError.stderr).toContain("unit id must not be empty");

    const missingUnit = runCli([
      "--store",
      directory,
      "unit",
      "get",
      "missing",
    ]);
    expect(missingUnit.code).toBe(2);
    expect(missingUnit.stderr).toContain("unit missing not found");

    const missingLedger = runCli([
      "--store",
      directory,
      "--json",
      "ledger",
      "check",
      "184530",
      "abc123",
    ]);
    expect(missingLedger.code).toBe(2);
    expect(JSON.parse(missingLedger.stdout)).toEqual({
      pr: "184530",
      sha: "abc123",
      verdict: "NOT-VERIFIED",
    });
    expect(missingLedger.stderr).toBe("");
  });
});
