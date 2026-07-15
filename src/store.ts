import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config, type Queue, type UsageSnapshot, type StopSignal } from "./types.ts";

export const ROOT = join(homedir(), ".cc-queue");
export const PATHS = {
  config: join(ROOT, "config.json"),
  queue: join(ROOT, "queue.json"),
  usage: join(ROOT, "usage.json"),
  hookSettings: join(ROOT, "hook-settings.json"),
  signals: join(ROOT, "signals"),
  logs: join(ROOT, "logs"),
  worktrees: join(ROOT, "worktrees"),
  queueLock: join(ROOT, "queue.lock"),
  daemonLock: join(ROOT, "daemon.pid"),
};

export function ensureDirs(): void {
  for (const dir of [ROOT, PATHS.signals, PATHS.logs, PATHS.worktrees]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadConfig(): Config {
  return { ...DEFAULT_CONFIG, ...(readJson<Partial<Config>>(PATHS.config) ?? {}) };
}

export function saveConfig(cfg: Config): void {
  ensureDirs();
  atomicWrite(PATHS.config, JSON.stringify(cfg, null, 2));
}

export function loadUsage(): UsageSnapshot | null {
  return readJson<UsageSnapshot>(PATHS.usage);
}

const EMPTY_QUEUE: Queue = { jobs: [], meta: { jobsThisNight: 0, nightAnchor: null } };

// O_EXCL lockfile: CLI and daemon both mutate queue.json.
async function withLock<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(PATHS.queueLock, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        unlinkSync(PATHS.queueLock);
      }
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`queue lock stuck: ${PATHS.queueLock} (remove manually if no ccq is running)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export function loadQueue(): Queue {
  return readJson<Queue>(PATHS.queue) ?? structuredClone(EMPTY_QUEUE);
}

export async function mutateQueue<T>(fn: (q: Queue) => T): Promise<T> {
  ensureDirs();
  return withLock(() => {
    const q = loadQueue();
    const result = fn(q);
    atomicWrite(PATHS.queue, JSON.stringify(q, null, 2));
    return result;
  });
}

export function signalPath(jobId: string): string {
  return join(PATHS.signals, `${jobId}.json`);
}

export function readSignal(jobId: string): StopSignal | null {
  return readJson<StopSignal>(signalPath(jobId));
}

export function clearSignal(jobId: string): void {
  rmSync(signalPath(jobId), { force: true });
}

export function logPath(jobId: string): string {
  return join(PATHS.logs, `${jobId}.log`);
}

export function appendLog(jobId: string, text: string): void {
  ensureDirs();
  writeFileSync(logPath(jobId), `\n--- ${new Date().toISOString()} ---\n${text}\n`, { flag: "a" });
}

export function worktreePath(jobId: string): string {
  return join(PATHS.worktrees, jobId);
}

// Single daemon instance: pid lockfile. Returns false if another live daemon holds it.
export function acquireDaemonLock(): boolean {
  ensureDirs();
  const existing = readJson<{ pid: number }>(PATHS.daemonLock);
  if (existing) {
    try {
      process.kill(existing.pid, 0); // throws if dead
      return false;
    } catch {
      unlinkSync(PATHS.daemonLock);
    }
  }
  writeFileSync(PATHS.daemonLock, JSON.stringify({ pid: process.pid }));
  return true;
}

export function releaseDaemonLock(): void {
  try {
    unlinkSync(PATHS.daemonLock);
  } catch {}
}

export function hookSettingsContent(): string {
  // absolute bun + cli.ts paths — hook runs inside CC's sh where mise/local PATH may be absent
  const self = process.argv[1] ?? "";
  return JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${self}" _job-done` }] }],
      },
    },
    null,
    2,
  );
}

export function ensureHookSettings(): string {
  ensureDirs();
  atomicWrite(PATHS.hookSettings, hookSettingsContent()); // idempotent; tracks cli.ts path moves
  return PATHS.hookSettings;
}
