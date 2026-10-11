# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `ccq install-statusline` honors `CLAUDE_CONFIG_DIR` and takes a repeatable
  `--config-dir <dir>` to target one or more Claude config dirs explicitly
  (default stays `~/.claude`).

### Changed
- The statusline backup is now kept per config dir (`statuslineBackups` in
  `~/.ccq/config.json`), and it keeps the whole original `statusLine` object
  (e.g. `padding`), not just the command. `--uninstall` restores each dir to
  its own original, or removes the statusline if there was none. The old
  single `statuslineBackup` key is migrated automatically.
- `install-statusline` rejects unknown arguments and a `--config-dir` without
  a value, instead of ignoring them and editing the default dir.
- `install-statusline` writes through a symlinked `settings.json` and keeps
  its file mode (e.g. `0600`).

### Fixed
- Jobs no longer die at startup on Claude Code versions whose workspace-trust
  dialog reads "Is this a project you created or one you trust?" with
  "No, exit" preselected. The dialog was not recognised, its `❯ No, exit`
  line passed as a ready composer, and the Escape sent next exited claude,
  so every job failed with `tmux paste-buffer failed`. The trust dialog is
  now detected in both wordings and steered to the Yes option, and a dead
  pane is reported as `claude exited during startup` before any readiness
  check.
- The statusline tee passes the original statusline command as one
  shell-quoted word. Before, Claude's shell split it at `|`, `;`, `&&` (only
  the first part ran inside the tee) and stripped its inner quoting
  (`echo "a   b"` printed `a b`). Re-running `ccq install-statusline` upgrades
  an existing tee in place, and also refreshes one whose bun/ccq path moved.
- Daemon startup reconcile no longer kills every `ccq-*` tmux session: it only
  matches the exact job-session shape (`ccq-<8 hex chars>`). Previously a
  daemon started in a tmux session named e.g. `ccq-daemon` killed itself on
  startup as an "orphan".
- `ccq start` / `stop` / `now` / `rm` address tmux sessions by exact name.
  tmux prefix-matches bare targets, so with no `ccq` session, `ccq start`
  reported "already running" for, and `ccq stop` / `ccq now` killed, another
  `ccq-*` session (e.g. `ccq-daemon` or a `needs_user` job).
- Reconcile never kills the tmux session the daemon itself runs in.

## [0.1.5] - 2026-09-02

### Added
- `ccq now` — start the daemon and run the queue immediately, ignoring the
  off-peak window until the next morning (for when you're done at the machine
  for the day). The weekly guard still applies; normal window behavior resumes
  after morning.

## [0.1.4] - 2026-09-02

### Added
- `ccq start` / `ccq stop` / `ccq restart` — one command to run the daemon,
  backgrounded in a tmux session under `caffeinate` (macOS). No more manual
  `tmux new -s ccq '…'` incantation.

## [0.1.3] - 2026-09-01

### Added
- A bundled Claude Code skill (`.claude/skills/ccq/`) so agents know when and how
  to queue work with `ccq`; README documents installing it.

### Removed
- The `~/.cc-queue` → `~/.ccq` migration shim (no external users to migrate).

## [0.1.2] - 2026-09-01

### Changed
- State directory moved from `~/.cc-queue` to `~/.ccq`. Existing state is
  migrated automatically on first run (the old directory is renamed).

## [0.1.1] - 2026-09-01

### Added
- `ccq clean [--days N]` — drop finished jobs (done/failed/cancelled) from the
  queue and sweep any worktrees they left behind.

### Docs
- Warn that `caffeinate -s` holds only on AC power (not on battery) and that a
  closed lid sleeps the machine — the main cause of a wasted night.
- Full `ccq add` flag table; document `maxTimeoutRequeues` and
  `install-statusline --uninstall`.

## [0.1.0] - 2026-09-01

First public release.

### Added
- Off-peak prompt queue: repo-bound prompts run overnight inside tmux as
  interactive Claude Code sessions (subscription-covered, not `claude -p`).
- Off-peak window runner (configurable start/end/tz/days); a running job is
  never killed at window end.
- Weekly usage guard with linear pacing `allowed = max(100/7, 100/7·(7−daysRemaining))`,
  read from the official statusline `rate_limits` snapshot.
- Per-job git worktree isolation; output is a branch + commit. Publishing is
  opt-in: `--push` pushes the branch, `--pr` pushes and opens a PR.
- Completion detection via a Stop hook correlated by `session_id`.
- Limit-hit handling: parse the reset time, pause, and auto-resume the session.
- Auto-requeue of a no-progress timeout (e.g. the machine slept), up to
  `maxTimeoutRequeues`.
- CLI: `add` (with `--file`, stdin, `--at`, `--base`, `--model`,
  `--permission-mode`, `--timeout`), `list`, `status`, `mv`, `rm`, `logs`,
  `daemon`, `install-statusline`.

[0.1.5]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.5
[0.1.4]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.4
[0.1.3]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.3
[0.1.2]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.2
[0.1.1]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.1
[0.1.0]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.0
