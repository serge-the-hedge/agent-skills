### Pause safely

**You own a clean stop. Leave a checkpoint a cold-start agent can resume from.** This is explicit only. On "keep going", "going to bed, keep going", or "don't stop", do not pause.

1. Stop at a safe boundary. Finish the current atomic step or back out of it. Start nothing new, and cancel any nested subagents (`task_cancel` for a delegated task, a zero-writes hold or `t3_thread_interrupt` for a launched thread). A T3 restart keeps threads, delegated tasks, schedules and PR watches, so they keep running through a pause. Check `list_scheduled_tasks` and your PR watches. Pause each schedule that should not fire with `update_scheduled_task` (`enabled: false`), and drop each watch that should not wake you with `unwatch_pull_request`.
2. Take no irreversible action to pause. No PR and no push unless you already had one out.
3. Make the work durable. Commit uncommitted edits as one clear `wip:` commit on the current branch so nothing is lost. If the tree is broken, say so in the commit body in one line.
4. Write the resume note off-context. Capture intent, what you were doing, progress and what's verified, current state, next steps, key files, gotchas, and the schedules and watches you paused or kept, to restore on resume. For the compaction trigger write it to a file like `/tmp/<slug>-resume.md`. If a show-me-your-work trail exists, point at it instead of duplicating it.

**Reply:** where you are in the loop, what's on disk versus still in your head (paths, no diff dumps), the commits you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.
