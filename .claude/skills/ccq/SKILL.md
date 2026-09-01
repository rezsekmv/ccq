---
name: ccq
description: Queue a coding task for Claude Code Queue (`ccq`) to run later, overnight, or in batch instead of doing it now. Use when the user says "run this tonight/overnight/later", "queue this", "add to ccq", "batch this", "do this off-peak", or asks to defer a non-urgent, well-defined task (refactor, test generation, docs, dependency bump, migration) so it runs in the off-peak window on unused weekly Claude capacity. Also use to inspect or manage the queue (list/status/logs/remove/reorder/clean).
---

# ccq — Claude Code Queue

`ccq` is a local queue + daemon that runs repo-bound prompts **overnight** in an off-peak window, paced against the weekly usage limit so batch work only burns *unused* capacity. Each job runs in its own git worktree and returns as a **branch + commit** (push/PR opt-in). It auto-resumes a job that hits a limit (waits for reset, continues the same prompt) and auto-requeues a job whose run made no progress (e.g. the machine slept).

Reach for `ccq` instead of doing the work now when the task is **not urgent and well-defined** — the kind of thing that's fine to wake up to as a branch: refactors, test generation, docs, dependency audits, mechanical migrations, spikes.

## Queue a task

Run from inside the target repo (or pass `--repo`):

```sh
ccq add "Refactor src/auth to use the new session helper and add tests"
```

Because the night session runs with **no chat context**, write the prompt as a complete, self-contained brief: what to change, constraints, how to verify. One job = one focused task.

### Flags

| Flag | Effect |
|------|--------|
| *(none)* | Default: commit only, on a local branch `ccq/<id>-<slug>`. |
| `--push` | Also push the branch to `origin`. |
| `--pr` | Push **and** open a PR (`gh pr create --fill`). Implies `--push`. Prefer this when the user wants something reviewable. |
| `-m "<msg>"` | Commit message (default: prompt's first line). |
| `--repo <path>` | Target repo (default: current directory). |
| `--file <path>` | Read the prompt from a file (or pipe via stdin: `… \| ccq add -`). Use for long specs. |
| `--base <branch>` | Fork the worktree from this branch. Use to **chain** dependent jobs (base a slice on the previous job's branch). |
| `--at <n>` | Insert at position `n` (0 = front) instead of the end. |
| `--model <model>` | Model for this job (default: the user's Claude Code default). |
| `--timeout <sec>` | Max run time (default 4h). Raise for large jobs. |
| `--permission-mode <mode>` | Default `auto`; `bypassPermissions` for a fully-trusted repo that must run commands unattended. |

Examples:

```sh
ccq add "generate unit tests for lib/parser.ts, aim for the edge cases" --pr
echo "$(cat SPEC.md)" | ccq add - --repo ~/work/api --timeout 7200
ccq add "slice B: build on slice A" --base ccq/1a2b3c4d-slice-a
```

## Inspect & manage

```sh
ccq status          # off-peak window, usage %, weekly-guard verdict, tonight's counter
ccq list            # all jobs and their state
ccq logs <id> [-f]  # pane snapshots of a job's run
ccq mv <id> <n>     # reorder the queue
ccq rm <id>         # cancel (a running job finishes its current run first)
ccq clean [--days N]# drop finished jobs (done/failed/cancelled) from the queue
```

Job states: `queued → running → done | failed | paused_limit (auto-resumes) | needs_user (attach & answer) | cancelled`.

## Before relying on it

- The **daemon must be running**: `ccq daemon` (typically kept alive in tmux, on AC power so the Mac doesn't sleep). If `ccq status` shows nothing dispatching, check the daemon is up.
- The weekly guard reads usage from a statusline hook installed once via `ccq install-statusline`; if `ccq status` says there's no usage snapshot, that step is missing.
- Results are **branches, not merges** — nothing is auto-merged. In the morning, review branches / PRs (`ccq status` links PRs).
