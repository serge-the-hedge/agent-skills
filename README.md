# agent-skills

My agent skills and the upstream skill sets I build on, in one repo.

Every skill here is symlinked into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex), so agents read this checkout directly. Edits land in git, and upstream updates arrive as commits I can read and undo.

- `skills/`: my own skills.
- `vendor/<name>/`: upstream repos, copied in with `git subtree`. Edit them freely; committed edits survive updates.
- `upstreams.ts`: where each upstream comes from, and which of its skills get linked.

## Commands

```
agent-skills update [upstream...]   Pull upstreams (all by default) into vendor/, one commit each, then link.
agent-skills link                   Point the agent skill folders at the skills in this repo.
agent-skills diff <upstream>        Show my committed edits to vendor/<upstream> since its last pull.
agent-skills where [skill]          Show where skills live, or the real path of one skill.
agent-skills conflicts              Show what a stopped update left unresolved, and how to finish it.
```

`update` refuses to run with uncommitted changes and stops at the first merge conflict; `conflicts` then lists the files left and the steps to finish. `link` fails loudly if two skills share a name or something it didn't create is in the way.

`link` also hides upstream plugin manifests (`vendor/*/.claude-plugin/` and the like) from disk with a sparse checkout; they stay in git. Codex follows each symlink back here, and a manifest above a skill makes it rename `grilling` to `mattpocock-skills:grilling`, which breaks `$grilling`.

To add an upstream, add it to `upstreams.ts` and run `agent-skills update <name>`. To remove one, delete it from `upstreams.ts`, run `git rm -r --sparse vendor/<name>` (`--sparse` catches the hidden manifests), commit, and run `agent-skills link`.

## Adding and editing skills

The rules for creating, editing, and committing skills live in [`skills/agent-skills/SKILL.md`](skills/agent-skills/SKILL.md), which every agent sees as the `agent-skills` skill.

## Setup on a new machine

```sh
git clone https://github.com/serge-the-hedge/agent-skills ~/Dev/agent-skills
ln -s ~/Dev/agent-skills/bin/agent-skills.ts ~/.local/bin/agent-skills
agent-skills link
```

Needs [Bun](https://bun.sh). Vendored skills keep their own licenses, in each `vendor/` folder.
