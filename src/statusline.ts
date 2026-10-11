import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Claude Code `statusLine` settings value; kept opaque so extra fields (e.g. padding) survive. */
export type StatusLine = { type?: string; command?: string; [k: string]: unknown };

/** Per config dir: the statusLine that was there before install (null = there was none). */
export type StatuslineBackups = Record<string, StatusLine | null>;

/** POSIX single-quote `s` as one shell word. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Inverse of shQuote; null if `s` is not exactly one single-quoted word. */
export function shUnquote(s: string): string | null {
  const m = /^'((?:[^']|'\\'')*)'$/s.exec(s);
  return m ? m[1]!.replace(/'\\''/g, "'") : null;
}

/** The statusline command that tees usage data, then runs the original. The original is passed as
 *  ONE quoted word: unquoted, Claude's shell would split it at `|`, `;`, `&&` (only the first part
 *  would be wrapped) and strip its inner quoting. */
export function buildTeeCommand(execPath: string, cli: string, original: string): string {
  return `"${execPath}" "${cli}" statusline-tee${original ? ` -- ${shQuote(original)}` : ""}`;
}

/** The exact command installTee writes: `"<bun>" "<ccq cli>" statusline-tee[ -- <original>]`.
 *  Matching the whole shape (not a substring) keeps unrelated commands from looking installed. */
const TEE_COMMAND = /^"[^"]*" "[^"]*" statusline-tee(?: -- (.*))?$/s;

/** Parse `install-statusline` args strictly: anything unrecognised is an error, so a typo or a
 *  dangling `--config-dir` can never silently fall back to editing the default config dir. */
export function parseInstallArgs(argv: string[]): { uninstall: boolean; configDirs: string[] } {
  let uninstall = false;
  const configDirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--uninstall") uninstall = true;
    else if (a.startsWith("--config-dir=")) configDirs.push(a.slice("--config-dir=".length));
    else if (a === "--config-dir") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error("--config-dir needs a path");
      configDirs.push(v);
    } else throw new Error(`unexpected argument '${a}' (usage: ccq install-statusline [--uninstall] [--config-dir dir]...)`);
  }
  return { uninstall, configDirs };
}

/** Follow a symlink chain to the final path, even when that target does not exist yet
 *  (realpath would throw, and writing to the link path would replace the link). */
export function resolveLink(path: string): string {
  let p = path;
  for (let hops = 0; hops < 40; hops++) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return p; // missing: this is where the file goes
    }
    if (!st.isSymbolicLink()) return p;
    p = resolve(realpathSync(dirname(p)), readlinkSync(p)); // physical parent, so `..` in the link is right
  }
  throw new Error(`too many symlinks: ${path}`);
}

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** Canonical key for a config dir: absolute, `~` expanded, symlinks resolved when it exists. */
export function canonicalDir(p: string, home = homedir()): string {
  const abs = resolve(expandHome(p, home));
  return existsSync(abs) ? realpathSync(abs) : abs;
}

/** Explicit --config-dir values win; else CLAUDE_CONFIG_DIR (Claude Code's own override); else ~/.claude. */
export function resolveConfigDirs(explicit: string[], env: Record<string, string | undefined>, home = homedir()): string[] {
  if (explicit.some((d) => d.trim() === "")) throw new Error("--config-dir needs a non-empty path");
  const envDir = env.CLAUDE_CONFIG_DIR?.trim();
  const dirs = explicit.length > 0 ? explicit : [envDir || join(home, ".claude")];
  return [...new Set(dirs.map((d) => canonicalDir(d, home)))];
}

export function isTeeInstalled(settings: Record<string, any>): boolean {
  return TEE_COMMAND.test(String(settings.statusLine?.command ?? ""));
}

/** Wrap the current statusline in the tee. Returns null when the tee is already installed. */
export function installTee(
  settings: Record<string, any>,
  teeCommand: (original: string) => string,
): { settings: Record<string, any>; backup: StatusLine | null } | null {
  if (isTeeInstalled(settings)) return null;
  const backup: StatusLine | null = settings.statusLine ? structuredClone(settings.statusLine) : null;
  const original = backup?.command ?? "";
  return {
    settings: { ...settings, statusLine: { ...(backup ?? {}), type: "command", command: teeCommand(original) } },
    backup,
  };
}

/** The original command wrapped by an installed tee: quoted (current) or raw (pre-0.1.6 installs). */
export function wrappedCommand(settings: Record<string, any>): string {
  const raw = TEE_COMMAND.exec(String(settings.statusLine?.command ?? ""))?.[1];
  return raw ? (shUnquote(raw) ?? raw) : "";
}

/** Rewrite an installed tee whose command is not what we'd write now (moved bun/ccq path, or a
 *  pre-0.1.6 unquoted original). Returns null when it is already current. */
export function refreshTee(settings: Record<string, any>, original: string, teeCommand: (original: string) => string): Record<string, any> | null {
  const want = teeCommand(original);
  if (settings.statusLine?.command === want) return null;
  return { ...settings, statusLine: { ...settings.statusLine, command: want } };
}

/** Restore the pre-install statusline. With no recorded backup, recover the wrapped command from the
 *  tee itself (`... statusline-tee -- <original>`), or drop the statusline if nothing was wrapped. */
export function uninstallTee(settings: Record<string, any>, backup: StatusLine | null | undefined): Record<string, any> {
  const next = { ...settings };
  let restored = backup;
  if (restored === undefined) {
    const wrapped = wrappedCommand(settings);
    restored = wrapped ? { ...settings.statusLine, type: "command", command: wrapped } : null;
  }
  if (restored) next.statusLine = restored;
  else delete next.statusLine;
  return next;
}
