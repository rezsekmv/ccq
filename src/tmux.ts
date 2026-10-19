export interface Tmux {
  newSession(name: string, cwd: string, command: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  paneDead(name: string): Promise<boolean>;
  capturePane(name: string): Promise<string>; // incl. 200 lines scrollback (logs, limit text)
  captureVisible(name: string): Promise<string>; // visible pane only (dialog detection)
  sendKeys(name: string, keys: string[]): Promise<void>;
  paste(name: string, text: string): Promise<void>;
  killSession(name: string): Promise<void>;
  listJobSessions(): Promise<string[]>;
  ownSession(): Promise<string | null>; // session this process runs in, if any
}

async function run(bin: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

export function makeTmux(bin: string): Tmux {
  return {
    async newSession(name, cwd, command) {
      const r = await run(bin, ["new-session", "-d", "-s", name, "-c", cwd, command]);
      if (r.code !== 0) throw new Error(`tmux new-session failed (${r.code})`);
      await run(bin, ["set-option", "-t", paneTarget(name), "remain-on-exit", "on"]);
      // wide pane so CC's UI doesn't wrap dialogs unpredictably
      await run(bin, ["resize-window", "-t", paneTarget(name), "-x", "200", "-y", "50"]);
    },

    async hasSession(name) {
      return (await run(bin, ["has-session", "-t", sessionTarget(name)])).code === 0;
    },

    async paneDead(name) {
      const r = await run(bin, ["list-panes", "-t", paneTarget(name), "-F", "#{pane_dead}"]);
      return r.code !== 0 || r.stdout.trim().startsWith("1");
    },

    async capturePane(name) {
      const r = await run(bin, ["capture-pane", "-t", paneTarget(name), "-p", "-S", "-200"]);
      return r.stdout;
    },

    async captureVisible(name) {
      const r = await run(bin, ["capture-pane", "-t", paneTarget(name), "-p"]);
      return r.stdout;
    },

    async sendKeys(name, keys) {
      await run(bin, ["send-keys", "-t", paneTarget(name), ...keys]);
    },

    async paste(name, text) {
      // load-buffer from stdin: multiline-safe (bracketed paste on the way out)
      const proc = Bun.spawn([bin, "load-buffer", "-b", "ccq", "-"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      if ((await proc.exited) !== 0) throw new Error("tmux load-buffer failed");
      const r = await run(bin, ["paste-buffer", "-p", "-b", "ccq", "-t", paneTarget(name)]);
      if (r.code !== 0) throw new Error("tmux paste-buffer failed");
      // CC must fully exit bracketed-paste mode before Enter registers as submit (not a newline);
      // 300ms was too short and Enter got absorbed, leaving the prompt unsent. 2s is reliable.
      await new Promise((r2) => setTimeout(r2, 2000));
      await run(bin, ["send-keys", "-t", paneTarget(name), "Enter"]);
    },

    async killSession(name) {
      await run(bin, ["kill-session", "-t", sessionTarget(name)]);
    },

    async ownSession() {
      const pane = process.env.TMUX_PANE;
      if (!process.env.TMUX || !pane) return null;
      const r = await run(bin, ["display-message", "-p", "-t", pane, "#{pane_pid} #{session_name}"]);
      if (r.code !== 0) return null;
      const [pid, ...rest] = r.stdout.trim().split(" ");
      // TMUX_PANE may be stale (inherited by a detached process, pane id since reused):
      // only trust it if that pane's process is really one of our ancestors.
      return isAncestor(Number(pid), process.pid, parentPid) ? rest.join(" ") || null : null;
    },

    async listJobSessions() {
      const r = await run(bin, ["list-sessions", "-F", "#{session_name}"]);
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(isJobSession);
    },
  };
}

/** tmux prefix-matches bare session targets (`-t ccq` hits `ccq-daemon` when no `ccq` exists);
 *  a leading `=` forces an exact match. Pane/window targets need the trailing `:` as well. */
export function sessionTarget(name: string): string {
  return `=${name}`;
}

export function paneTarget(name: string): string {
  return `=${name}:`;
}

function parentPid(pid: number): number | null {
  const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
  const ppid = Number(r.stdout.toString().trim());
  return r.exitCode === 0 && ppid > 0 ? ppid : null;
}

/** True if `ancestor` is `pid` or one of its parents (walks up via `parentOf`). */
export function isAncestor(ancestor: number, pid: number, parentOf: (pid: number) => number | null): boolean {
  if (!Number.isInteger(ancestor) || ancestor <= 1) return false;
  for (let p: number | null = pid, hops = 0; p !== null && p > 1 && hops < 64; p = parentOf(p), hops++) {
    if (p === ancestor) return true;
  }
  return false;
}

export function sessionName(jobId: string): string {
  return `ccq-${jobId.slice(0, 8)}`;
}

/** Exact shape of sessionName() for a UUID job id. A bare `ccq-` prefix is not enough:
 *  the user may run the daemon itself in e.g. `ccq-daemon`, and reconcile must never kill it. */
const JOB_SESSION = /^ccq-[0-9a-f]{8}$/;

export function isJobSession(name: string): boolean {
  return JOB_SESSION.test(name);
}

/** Job sessions reconcile should kill: everything job-shaped except the ones explicitly kept. */
export function orphanSessions(names: string[], keepAlive: Set<string>): string[] {
  return names.filter((n) => isJobSession(n) && !keepAlive.has(n));
}
