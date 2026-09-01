# cc-queue

Off-peak prompt queue for Claude Code. Queue repo-bound prompts during the day; a local daemon runs them overnight (default 23:00–08:00) as **interactive Claude Code sessions inside tmux**, guarded so night batch work never starves your daytime subscription quota.

## Why tmux, not `claude -p`?

`claude -p` (headless mode) with OAuth bills as **API usage**, not your Pro/Max subscription ([claude-code#43333](https://github.com/anthropics/claude-code/issues/43333)). Interactive sessions are subscription-covered — so cc-queue drives a real Claude Code TUI in a detached tmux session: paste prompt, wait for the Stop hook, commit the result. Interactive sessions also fire the statusline, which is the only official source of rate-limit data (`rate_limits.five_hour|seven_day` in the statusline stdin payload) — so usage data stays fresh all night while jobs run.

## Install

Requires **[bun](https://bun.sh)**, **git**, **tmux**, and the **Claude Code** CLI (`claude`); `gh` for PRs. cc-queue runs on the Bun runtime — plain Node won't work.

```sh
# from npm (installs the `ccq` command; you still need bun on PATH)
npm i -g cc-queue        # or: bun add -g cc-queue

# then, once:
ccq install-statusline   # wraps your statusline to capture official usage data
# open any interactive claude session once so ~/.cc-queue/usage.json exists
```

From source:

```sh
bun install
bun link                 # exposes `ccq`
ccq install-statusline
```

## Usage

```sh
ccq add "Refactor src/auth to use the new session helper"   # repo = cwd
ccq add --repo ~/gitRepos/x --file spec.md                  # long prompt from file
echo "prompt" | ccq add -                                   # stdin
ccq add "urgent thing" --at 0                               # jump the queue
ccq list                     # queue state
ccq status                   # window, usage %, guard verdict, night counter
ccq mv <id> 2                # reorder
ccq rm <id>                  # cancel (a running job finishes its current run first)
ccq logs <id> [-f]           # pane snapshots of a job
ccq daemon                   # foreground; keep it alive: tmux new -s ccq 'ccq daemon'
```

Per-job flags for `add`: `--base <branch>` `--model <m>` `--permission-mode <mode>` `--push` `--pr` `--timeout <sec>` `-m <commit msg>`.

## How it dispatches

Every job runs in its own **git worktree** (`~/.cc-queue/worktrees/<id>`, branch `ccq/<id8>-<slug>`) — your checkout is never touched, dirty or not. On success the daemon commits whatever changed. Publishing is **opt-in**: by default the commit stays on the local branch; pass `--push` to push the branch to origin, or `--pr` to push **and** open a PR (`gh pr create --fill`). A job with no changes and no commits is research-only: the transcript path is recorded, no branch is created.

**Off-peak window** — jobs start only inside `window` (overnight ranges fine; `days` gates the evening the window opened, so a 02:00 dispatch belongs to the previous day). A running job is never killed at window end.

**Weekly guard** (before every dispatch, from official statusline data):

```
daysRemaining = ceil(time until weekly reset / 1 day)
allowed%      = max(100/7, 100/7 × (7 − daysRemaining))   # linear pace + first-night floor
dispatch iff  used% + estWeeklyPctPerJob < allowed%
```

The 5-hour window is deliberately **not** pre-checked at night — when Claude reports a limit mid-job, the job pauses (`paused_limit`), the reset time is parsed from the message, and the daemon resumes the same session (`claude --resume` + "continue") after reset (+`resetBufferSec`).

**Permission dialogs** at 3am are auto-denied up to `maxDenials` times; if a dialog persists, the job parks as `needs_user` with its tmux session kept alive — attach in the morning (`tmux attach -t ccq-<id8>`), answer, and the daemon finalizes the job automatically once Claude finishes.

## Config (`~/.cc-queue/config.json`)

All keys optional; defaults shown.

```jsonc
{
  "window": { "start": "23:00", "end": "08:00", "tz": "Europe/Budapest", "days": [0,1,2,3,4,5,6] },
  "permissionMode": "auto",   // per-job --permission-mode overrides; bypassPermissions for trusted repos
  "estWeeklyPctPerJob": 2,    // % points a typical job is assumed to burn (guard projection)
  "maxJobsPerNight": 10,
  "maxRetries": 1,
  "maxDenials": 2,
  "model": null,              // null = your Claude Code default
  "branchPrefix": "ccq",
  "pollIntervalSec": 60,
  "resetBufferSec": 120,
  "jobTimeoutSec": 14400,     // 4h; per-job --timeout overrides
  "readyTimeoutSec": 60
}
```

## Keep the Mac awake

The daemon does **not** fight system sleep. Keep the machine plugged in with sleep disabled, or run the daemon under caffeinate:

```sh
tmux new -s ccq 'caffeinate -is ccq daemon'
# or globally: sudo pmset -c sleep 0
```

A slept night is visible in `ccq status` (jobs still queued, night counter at 0).

## Job states

`queued → running → done | failed | paused_limit (limit hit, auto-resumes) | needs_user (attach & answer) | cancelled`.

Crash recovery: on daemon start, `running` jobs become immediately resumable (same session if the prompt already landed, fresh session otherwise) and orphan `ccq-*` tmux sessions are cleaned up — except those belonging to `needs_user` jobs.
