# pstack-t3 contributor guide

This repo is [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, adapted to T3 Code for Claude Code and Codex threads. `UPSTREAM` pins the upstream commit it matches.

Before you edit anything under `skills/`, read [T3-NATIVE.md](./T3-NATIVE.md) in full. It is the translation contract: which Cursor mechanism becomes which T3 mechanism, how skills reference each other, where skills and the model config live, and the definition of done.

## Rules

- Keep upstream wording wherever it is harness-neutral. Change only what names a Cursor mechanism.
- Upstream names stay: `poteto-mode`, `poteto-help`, `setup-pstack`, role names, playbook names.
- `node scripts/check-t3-native.mjs` must exit 0. Pass skill names to check a subset.
- Script changes keep `bun test` and `bun run typecheck` green in `skills/poteto-mode/scripts`.
- A delegated worker writes only the files its brief names and runs no git commands.

## Syncing upstream

Diff `pstack/` in `cursor/plugins` from the `sha` in `UPSTREAM` to the new commit. Apply each hunk through T3-NATIVE.md, run the checker and the script tests, then bump `sha`.
