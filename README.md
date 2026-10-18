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
```

`update` refuses to run with uncommitted changes and stops at the first merge conflict. `link` fails loudly if two skills share a name or something it didn't create is in the way.

To add an upstream, add it to `upstreams.ts` and run `agent-skills update <name>`.

## Writing skills

When one of my skills refers to another skill, use the full path, `~/.agents/skills/<name>/SKILL.md`. A relative path like `../<name>` breaks here, because `skills/` and each `vendor/` folder sit apart.

## Setup on a new machine

```sh
git clone https://github.com/serge-the-hedge/agent-skills ~/Dev/agent-skills
ln -s ~/Dev/agent-skills/bin/agent-skills.ts ~/.local/bin/agent-skills
agent-skills link
```

Needs [Bun](https://bun.sh). Vendored skills keep their own licenses, in each `vendor/` folder.
