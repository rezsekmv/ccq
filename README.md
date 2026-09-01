# Claude Code Queue

Off-peak prompt queue for Claude Code (`ccq`). Queue repo-bound prompts during the day; a local daemon runs them overnight (default 23:00–08:00) as **interactive Claude Code sessions inside tmux**, guarded so night batch work never starves your daytime subscription quota.

## Why tmux, not `claude -p`?

`claude -p` (headless mode) with OAuth bills as **API usage**, not your Pro/Max subscription ([claude-code#43333](https://github.com/anthropics/claude-code/issues/43333)). Interactive sessions are subscription-covered — so Claude Code Queue drives a real Claude Code TUI in a detached tmux session: paste prompt, wait for the Stop hook, commit the result. Interactive sessions also fire the statusline, which is the only official source of rate-limit data (`rate_limits.five_hour|seven_day` in the statusline stdin payload) — so usage data stays fresh all night while jobs run.

## Install

Requires **[bun](https://bun.sh)**, **git**, **tmux**, and the **Claude Code** CLI (`claude`, v2.1.80+ for the statusline `rate_limits` data the guard reads); `gh` for PRs. Claude Code Queue runs on the Bun runtime — plain Node won't work.

```sh
# from npm (installs the `ccq` command; you still need bun on PATH)
npm i -g @rezsekmv/ccq      # or: bun add -g @rezsekmv/ccq

# then, once:
ccq install-statusline   # wraps your statusline to capture official usage data
# open any interactive claude session once so ~/.ccq/usage.json exists
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
ccq install-statusline       # wrap the statusline for usage data (--uninstall to revert)
```

### `ccq add` flags

Publishing is **opt-in** — by default a finished job only **commits** on its local branch.

| Flag | Effect |
|------|--------|
| `--push` | Push the job's branch to `origin` when it finishes (still no PR). |
| `--pr` | Push **and** open a PR (`gh pr create --fill`). Implies `--push`. |
| `-m, --message <msg>` | Commit message (default: the prompt's first line). |
| `--repo <path>` | Target repo (default: current directory). |
| `--file <path>` | Read the prompt from a file (or pipe it via stdin: `… | ccq add -`). |
| `--at <n>` | Insert at position `n` in the queue instead of the end. |
| `--base <branch>` | Branch to fork the worktree from (default: the repo's default branch). |
| `--model <model>` | Model for this job (default: your Claude Code default). |
| `--permission-mode <mode>` | Permission mode (default `auto`; e.g. `bypassPermissions` for fully-trusted repos). |
| `--timeout <sec>` | Max run time before the job is killed (default 4h). A no-progress timeout is auto-requeued. |

Examples:

```sh
ccq add "fix the flaky test in auth.test.ts"                 # commit only
ccq add "add rate limiting to the API" --pr                 # commit + push + PR
ccq add "migrate config to zod" --push -m "chore: zod config"
```

## How it dispatches

Every job runs in its own **git worktree** (`~/.ccq/worktrees/<id>`, branch `ccq/<id8>-<slug>`) — your checkout is never touched, dirty or not. On success the daemon commits whatever changed. Publishing is **opt-in**: by default the commit stays on the local branch; pass `--push` to push the branch to origin, or `--pr` to push **and** open a PR (`gh pr create --fill`). A job with no changes and no commits is research-only: the transcript path is recorded, no branch is created.

**Off-peak window** — jobs start only inside `window` (overnight ranges fine; `days` gates the evening the window opened, so a 02:00 dispatch belongs to the previous day). A running job is never killed at window end.

**Weekly guard** (before every dispatch, from official statusline data):

```
daysRemaining = ceil(time until weekly reset / 1 day)
allowed%      = max(100/7, 100/7 × (7 − daysRemaining))   # linear pace + first-night floor
dispatch iff  used% + estWeeklyPctPerJob < allowed%
```

The 5-hour window is deliberately **not** pre-checked at night — when Claude reports a limit mid-job, the job pauses (`paused_limit`), the reset time is parsed from the message, and the daemon resumes the same session (`claude --resume` + "continue") after reset (+`resetBufferSec`).

**Permission dialogs** at 3am are auto-denied up to `maxDenials` times; if a dialog persists, the job parks as `needs_user` with its tmux session kept alive — attach in the morning (`tmux attach -t ccq-<id8>`), answer, and the daemon finalizes the job automatically once Claude finishes.

## Config (`~/.ccq/config.json`)

All keys optional; defaults shown.

```jsonc
{
  "window": { "start": "23:00", "end": "08:00", "tz": "Europe/Budapest", "days": [0,1,2,3,4,5,6] },
  "permissionMode": "auto",   // per-job --permission-mode overrides; bypassPermissions for trusted repos
  "estWeeklyPctPerJob": 2,    // % points a typical job is assumed to burn (guard projection)
  "maxJobsPerNight": 10,
  "maxRetries": 1,            // retries after a non-limit error
  "maxDenials": 2,            // auto-denied permission dialogs before parking as needs_user
  "maxTimeoutRequeues": 3,    // auto-requeues of a no-progress timeout (machine asleep etc.); 0 disables
  "model": null,              // null = your Claude Code default
  "branchPrefix": "ccq",
  "pollIntervalSec": 60,
  "resetBufferSec": 120,
  "jobTimeoutSec": 14400,     // 4h; per-job --timeout overrides
  "readyTimeoutSec": 60
}
```

## Keep the Mac awake

The daemon does **not** fight system sleep, and this is the #1 cause of a wasted night: a sleeping Mac freezes the running Claude session, which then hits its timeout having committed nothing.

> ⚠️ **`caffeinate -s` only holds on AC power — on battery it does nothing and the Mac still sleeps.** Also, closing the lid sleeps the machine regardless (clamshell), unless an external display is attached.

So for reliable overnight runs: **plug in, lid open**, and start the daemon under caffeinate:

```sh
tmux new -s ccq 'caffeinate -is ccq daemon'
# or disable AC sleep globally: sudo pmset -c sleep 0
```

If a night is lost to sleep anyway, `maxTimeoutRequeues` auto-retries the affected jobs, and a slept night is visible in `ccq status` (jobs still queued, night counter at 0).

## Claude Code skill

The repo ships a Claude Code skill at [`.claude/skills/ccq/SKILL.md`](.claude/skills/ccq/SKILL.md) that teaches an agent when and how to queue work with `ccq` — so you (or another agent) can just say *"queue this to run overnight"* and it does the right thing.

Install it globally (available in every project):

```sh
mkdir -p ~/.claude/skills/ccq
curl -fsSL https://raw.githubusercontent.com/rezsekmv/ccq/main/.claude/skills/ccq/SKILL.md \
  -o ~/.claude/skills/ccq/SKILL.md
```

Or copy it into a single project's `.claude/skills/ccq/SKILL.md`.

## Job states

`queued → running → done | failed | paused_limit (limit hit, auto-resumes) | needs_user (attach & answer) | cancelled`.

Crash recovery: on daemon start, `running` jobs become immediately resumable (same session if the prompt already landed, fresh session otherwise) and orphan `ccq-*` tmux sessions are cleaned up — except those belonging to `needs_user` jobs.
