#!/usr/bin/env bun
/**
 * Keeps upstream skill sets vendored in this repo and the agent skill folders pointing at it.
 * Run without arguments for usage.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { upstreams } from "../upstreams.ts";

const root = dirname(import.meta.dirname);
const tildeRoot = root.replace(homedir(), "~");
/** Claude Code reads ~/.claude/skills; Codex reads ~/.agents/skills. */
const agentDirs = [".claude/skills", ".agents/skills"].map((dir) => join(homedir(), dir));

const layout = `Where skills live:
  ${tildeRoot}
    skills/<name>/       Your own skills.
    vendor/<upstream>/   Upstream skills: ${Object.keys(upstreams).join(", ")}. Committed edits survive updates.
    upstreams.ts         Where each upstream comes from, and which of its skills get linked.
  ~/.claude/skills       Symlinks into the repo, for Claude Code.
  ~/.agents/skills       Symlinks into the repo, for Codex.
  Anything in those two folders that isn't a symlink into the repo belongs to the tool that installed it.`;

const usage = `Usage:
  agent-skills update [upstream...]   Pull upstreams (all by default) into vendor/, one commit each, then link.
  agent-skills link                   Point the agent skill folders at the skills in this repo.
  agent-skills diff <upstream> [...]  Show your committed edits to vendor/<upstream> since its last pull.
                                      Extra arguments go to git diff, e.g. --stat.
  agent-skills where [skill]          Show where skills live, or the real path of one skill.
  agent-skills conflicts              Show what a stopped update left unresolved, and how to finish it.

${layout}`;

const stoppedNotice = (upstream: string) =>
  `The ${upstream} update stopped at a conflict and is still unfinished. Run: agent-skills conflicts`;

const conflictGuide = (upstream: string) => `A conflict means upstream changed lines you had also edited. In each conflicted file,
the text between <<<<<<< and ======= is yours, and the text between ======= and >>>>>>> is upstream's.

To finish, in ${tildeRoot}:
  1. Edit each file until it says what you want, and delete the markers.
     To see all your edits to this upstream: agent-skills diff ${upstream}
     After editing pstack, run this until it exits 0: node vendor/pstack/scripts/check-t3-native.mjs
  2. Complete the pull: git add vendor/${upstream} && git commit --no-edit
  3. Pull whatever the update hadn't reached, and relink: agent-skills update
  4. Publish: git push

To give up instead and go back to before the pull: git merge --abort`;

type UpstreamName = keyof typeof upstreams;
const isUpstream = (name: string): name is UpstreamName => Object.hasOwn(upstreams, name);

/** Pulls each upstream into vendor/<name> as one squashed commit, then relinks. Stops at the first conflict and says how to finish. */
function update(names: string[]) {
  const stopped = stoppedUpstream();
  if (stopped) fail(stoppedNotice(stopped));
  if (gitOutput("status", "--porcelain")) fail("Commit or stash your changes first, so an update never mixes with them.");
  for (const name of names.length ? names : Object.keys(upstreams)) {
    if (!isUpstream(name)) fail(`No upstream named ${name} in upstreams.ts.`);
    const { repo, branch } = upstreams[name];
    const prefix = `vendor/${name}`;
    const action = existsSync(join(root, prefix)) ? "pull" : "add";
    console.log(`\n${name}: ${action} ${repo} ${branch}`);
    if (!git("subtree", action, `--prefix=${prefix}`, "--squash", `https://github.com/${repo}.git`, branch)) {
      if (stoppedUpstream()) conflicts();
      fail(`Stopped at ${name}.`);
    }
  }
  link();
}

/**
 * Symlinks every selected skill into each agent folder and removes links to skills no longer selected.
 * Leaves alone anything it didn't create, and reports it if it's in the way.
 */
function link() {
  hidePluginManifests();
  const skills = selectedSkills();
  const added = new Set<string>();
  const removed = new Set<string>();
  const blocked: string[] = [];
  for (const agentDir of agentDirs) {
    mkdirSync(agentDir, { recursive: true });
    for (const name of readdirSync(agentDir)) {
      const target = linkTarget(join(agentDir, name));
      if (target?.startsWith(root + sep) && skills.get(name) !== target) {
        unlinkSync(join(agentDir, name));
        removed.add(name);
      }
    }
    for (const [name, target] of skills) {
      const path = join(agentDir, name);
      if (!lstatSync(path, { throwIfNoEntry: false })) {
        symlinkSync(target, path);
        added.add(name);
      } else if (linkTarget(path) !== target) blocked.push(path);
    }
  }
  for (const name of removed) console.log(`${added.has(name) ? "~" : "-"} ${name}`);
  for (const name of added) if (!removed.has(name)) console.log(`+ ${name}`);
  if (blocked.length) fail(`Something else is already there; move it away and rerun:\n${blocked.join("\n")}`);
  console.log(`${skills.size} skills linked into ${agentDirs.join(" and ")}.`);
}

/** The skills to link, by name: everything in skills/, plus each upstream's selection. Fails on missing or clashing names. */
function selectedSkills() {
  const sources = [
    { dir: "skills", link: "all" as const },
    ...Object.entries(upstreams).map(([name, { link }]) => ({ dir: `vendor/${name}`, link })),
  ];
  const selected = new Map<string, string>();
  const errors: string[] = [];
  for (const { dir, link } of sources) {
    const found = findSkills(join(root, dir));
    for (const name of link === "all" ? found.keys() : link) {
      const [path, ...others] = found.get(name) ?? [];
      const taken = selected.get(name);
      if (!path) errors.push(`${dir} has no skill named ${name}.`);
      else if (others.length) errors.push(`${dir} has several skills named ${name}.`);
      else if (taken) errors.push(`${name} is in both ${relative(root, taken)} and ${relative(root, path)}.`);
      else selected.set(name, path);
    }
  }
  if (errors.length) fail(errors.join("\n"));
  return selected;
}

/** Every folder under dir holding a SKILL.md, grouped by folder name. Upstreams move skills between folders, so names are what's stable. */
function findSkills(dir: string) {
  const skills = new Map<string, string[]>();
  if (!existsSync(dir)) return skills;
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (basename(file) !== "SKILL.md") continue;
    const path = join(dir, dirname(file));
    skills.set(basename(path), [...(skills.get(basename(path)) ?? []), path]);
  }
  return skills;
}

/** Diffs the upstream snapshot from the last pull of vendor/<name> against what's committed there now. */
function diff(name: string | undefined, args: string[]) {
  if (!name || !isUpstream(name)) fail(usage);
  const snapshot = gitOutput("log", "-1", "--format=%H", `--grep=^Squashed 'vendor/${name}/'`);
  if (!snapshot) fail(`vendor/${name} hasn't been pulled yet. Run: agent-skills update ${name}`);
  git("diff", ...args, snapshot, `HEAD:vendor/${name}`);
}

/** Prints where skills live, or the real path of the named skill, which shows whether it's yours, an upstream's, or another tool's. */
function where(name: string | undefined) {
  if (!name) return console.log(layout);
  const path = agentDirs.map((dir) => join(dir, name)).find((path) => existsSync(path));
  if (!path) fail(`Neither agent folder has a skill named ${name}.`);
  console.log(realpathSync(path));
}

/** Prints which files a stopped update left unresolved, if any, and how to finish it. */
function conflicts() {
  const upstream = stoppedUpstream();
  const files = gitOutput("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  if (!upstream) console.log("No update is stopped at a conflict right now. If one stops, here's the way through.\n");
  else if (!files.length) console.log(`The ${upstream} update has no conflicts left, but the pull isn't complete. Continue from step 2.\n`);
  else console.log(`The ${upstream} update stopped here. Agents read these files as they are, markers included:\n\n${files.map((file) => `  ${file}`).join("\n")}\n`);
  console.log(conflictGuide(upstream ?? "<upstream>"));
}

/** The upstream with an unfinished pull, if any. A pull that hits a conflict stays an open merge of its squash commit. */
function stoppedUpstream() {
  return gitOutput("log", "-1", "--format=%s", "MERGE_HEAD").match(/^Squashed 'vendor\/(.+)\/'/)?.[1];
}

/** Prints usage, and flags an update that's waiting to be finished. */
function help() {
  console.log(usage);
  const stopped = stoppedUpstream();
  if (stopped) console.log(`\n${stoppedNotice(stopped)}`);
}

/**
 * Keeps upstream plugin manifests in git but out of the working tree. Codex follows a skill's symlink back here,
 * finds a manifest above it, and renames the skill to `<plugin>:<skill>`, so `$grilling` would stop working.
 */
function hidePluginManifests() {
  gitOutput("sparse-checkout", "set", "--no-cone", "/*", "!/vendor/*/.claude-plugin/", "!/vendor/*/.codex-plugin/", "!/vendor/*/.cursor-plugin/");
}

/** The target of the symlink at path, or undefined if path isn't a symlink. */
function linkTarget(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : undefined;
}

/** Runs git in this repo with the terminal attached. Returns whether it succeeded. */
function git(...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd: root, stdio: ["inherit", "inherit", "inherit"] }).success;
}

/** Runs git in this repo and returns its trimmed output. */
function gitOutput(...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString().trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const argv = process.argv.slice(2);
const [command, ...args] = argv;
if (!command || command === "help" || argv.includes("--help") || argv.includes("-h")) help();
else if (command === "update") update(args);
else if (command === "link") link();
else if (command === "diff") diff(args[0], args.slice(1));
else if (command === "where") where(args[0]);
else if (command === "conflicts") conflicts();
else fail(usage);
