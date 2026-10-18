---
name: agent-skills
description: "Every skill in ~/.agents/skills and ~/.claude/skills (mine, pstack, Matt Pocock's) is a symlink into the git repo ~/Dev/agent-skills. Use before creating, editing, or removing any skill, including via /reflect, /automate-me, or skill-creator."
---

# agent-skills

`~/Dev/agent-skills` holds every skill I use across projects: my own and the upstream ones I build on. `agent-skills link` fills `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex) with symlinks into it, so a skill edited through either folder is edited in the repo.

## Where a skill belongs

- **Project skill** (a repo's own `.agents/skills/`, such as `verify-*`): stays in that project. The rest of this file is about the skills in this repo.
- **Mine**: `skills/<name>/`.
- **Upstream**: `vendor/<upstream>/`, pulled from pstack, Matt Pocock's skills, and good-css by `agent-skills update`. `upstreams.ts` picks which of their skills get linked.
- Anything in the agent folders that isn't a symlink into the repo (`blabla-*`, Claude's `synced/`, Codex's `.system/`) is owned by the tool that installed it, which also updates it.

`realpath ~/.agents/skills/<name>` tells you which one a skill is.

## Creating

Create the skill at `~/Dev/agent-skills/skills/<name>/SKILL.md`; that path takes precedence over the defaults in skill-creator and /automate-me. Then run `agent-skills link`. If it reports a clash, pick another name.

## Editing

Route by what the change is:

- A **preference** of mine (style, defaults, how I like to work) goes in my own skills: extend one in `skills/`, or create one. My files never conflict with upstream updates.
- A **fix** for something an upstream skill gets wrong for me goes straight into `vendor/`. Committed upstream edits survive `agent-skills update`, but each can conflict when upstream changes the same lines, so keep them small. After editing pstack, run `node ~/Dev/agent-skills/vendor/pstack/scripts/check-t3-native.mjs <name>` until it exits 0.

## Removing

Delete `skills/<name>/` for a skill of mine. For an upstream skill, ask me first: it means changing `upstreams.ts`.

## Finishing

Done when `agent-skills link` succeeds and each change is its own commit in `~/Dev/agent-skills`:

- Stage only the files you changed (`git add <paths>`); other agents may have work in flight there.
- Write the message to say why the skill changed.
- Stop at the commit. The repo is public, and I push after reading the diff.

## Writing

- The repo is public, so write every skill as public text: generic examples, free of my projects' names, paths, and secrets.
- Refer to another skill by its full path, `~/.agents/skills/<name>/SKILL.md`. A relative `../<name>` breaks here, because my skills and each upstream sit in different folders.
- For the writing itself, follow `~/.agents/skills/writing-for-agents/SKILL.md`.

Run `agent-skills` with no arguments for its commands.
