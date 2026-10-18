#!/usr/bin/env bun
/**
 * Keeps upstream skill sets vendored in this repo and the agent skill folders pointing at it.
 * Run without arguments for usage.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { upstreams } from "../upstreams.ts";

const usage = `Usage:
  agent-skills update [upstream...]   Pull upstreams (all by default) into vendor/, one commit each, then link.
  agent-skills link                   Point the agent skill folders at the skills in this repo.
  agent-skills diff <upstream> [...]  Show your committed edits to vendor/<upstream> since its last pull.
                                      Extra arguments go to git diff, e.g. --stat.`;

const root = dirname(import.meta.dirname);
/** Claude Code reads ~/.claude/skills; Codex reads ~/.agents/skills. */
const agentDirs = [".claude/skills", ".agents/skills"].map((dir) => join(homedir(), dir));

type UpstreamName = keyof typeof upstreams;
const isUpstream = (name: string): name is UpstreamName => Object.hasOwn(upstreams, name);

/** Pulls each upstream into vendor/<name> as one squashed commit, then relinks. Stops at the first conflict. */
function update(names: string[]) {
  if (gitOutput("status", "--porcelain")) fail("Commit or stash your changes first, so an update never mixes with them.");
  for (const name of names.length ? names : Object.keys(upstreams)) {
    if (!isUpstream(name)) fail(`No upstream named ${name} in upstreams.ts.`);
    const { repo, branch } = upstreams[name];
    const prefix = `vendor/${name}`;
    const action = existsSync(join(root, prefix)) ? "pull" : "add";
    console.log(`\n${name}: ${action} ${repo} ${branch}`);
    if (!git("subtree", action, `--prefix=${prefix}`, "--squash", `https://github.com/${repo}.git`, branch)) {
      fail(`Stopped at ${name}. If git reported a conflict, resolve it in ${prefix}, commit, and rerun.`);
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

const [command, ...args] = process.argv.slice(2);
if (command === "update") update(args);
else if (command === "link") link();
else if (command === "diff") diff(args[0], args.slice(1));
else fail(usage);
