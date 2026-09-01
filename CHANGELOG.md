# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.1.3]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.3
[0.1.2]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.2
[0.1.1]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.1
[0.1.0]: https://github.com/rezsekmv/ccq/releases/tag/v0.1.0
