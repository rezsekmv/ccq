export interface Tmux {
  newSession(name: string, cwd: string, command: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  paneDead(name: string): Promise<boolean>;
  capturePane(name: string): Promise<string>; // incl. 200 lines scrollback (logs, limit text)
  captureVisible(name: string): Promise<string>; // visible pane only (dialog detection)
  sendKeys(name: string, keys: string[]): Promise<void>;
  paste(name: string, text: string): Promise<void>;
  killSession(name: string): Promise<void>;
  listCcqSessions(): Promise<string[]>;
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
      await run(bin, ["set-option", "-t", name, "remain-on-exit", "on"]);
      // wide pane so CC's UI doesn't wrap dialogs unpredictably
      await run(bin, ["resize-window", "-t", name, "-x", "200", "-y", "50"]);
    },

    async hasSession(name) {
      return (await run(bin, ["has-session", "-t", name])).code === 0;
    },

    async paneDead(name) {
      const r = await run(bin, ["list-panes", "-t", name, "-F", "#{pane_dead}"]);
      return r.code !== 0 || r.stdout.trim().startsWith("1");
    },

    async capturePane(name) {
      const r = await run(bin, ["capture-pane", "-t", name, "-p", "-S", "-200"]);
      return r.stdout;
    },

    async captureVisible(name) {
      const r = await run(bin, ["capture-pane", "-t", name, "-p"]);
      return r.stdout;
    },

    async sendKeys(name, keys) {
      await run(bin, ["send-keys", "-t", name, ...keys]);
    },

    async paste(name, text) {
      // load-buffer from stdin: multiline-safe (bracketed paste on the way out)
      const proc = Bun.spawn([bin, "load-buffer", "-b", "ccq", "-"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      if ((await proc.exited) !== 0) throw new Error("tmux load-buffer failed");
      const r = await run(bin, ["paste-buffer", "-p", "-b", "ccq", "-t", name]);
      if (r.code !== 0) throw new Error("tmux paste-buffer failed");
      // CC must fully exit bracketed-paste mode before Enter registers as submit (not a newline);
      // 300ms was too short and Enter got absorbed, leaving the prompt unsent. 2s is reliable.
      await new Promise((r2) => setTimeout(r2, 2000));
      await run(bin, ["send-keys", "-t", name, "Enter"]);
    },

    async killSession(name) {
      await run(bin, ["kill-session", "-t", name]);
    },

    async listCcqSessions() {
      const r = await run(bin, ["list-sessions", "-F", "#{session_name}"]);
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter((s) => s.startsWith("ccq-"));
    },
  };
}

export function sessionName(jobId: string): string {
  return `ccq-${jobId.slice(0, 8)}`;
}
