import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type Config, type Queue, type UsageSnapshot, type StopSignal } from "./types.ts";

export const ROOT = join(homedir(), ".ccq");
const LEGACY_ROOT = join(homedir(), ".cc-queue"); // pre-0.1.2 state dir; auto-migrated on first run
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

/** Whether a state dir holds real state ("real"), is just an empty shell ("shell"), or is missing. */
function stateKind(dir: string): "real" | "shell" | "absent" {
  if (!existsSync(dir)) return "absent";
  if (existsSync(join(dir, "config.json"))) return "real";
  try {
    const q = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    if (Array.isArray(q.jobs) && q.jobs.length > 0) return "real";
  } catch {}
  return "shell";
}

/** Migrate the pre-0.1.2 ~/.cc-queue state dir to ~/.ccq. Robust to a racing old daemon that
 *  recreated an empty ~/.ccq shell: only a real legacy dir migrates, and it replaces an empty
 *  shell but never clobbers a ~/.ccq that already holds real state. */
function migrateLegacyRoot(): void {
  try {
    if (stateKind(LEGACY_ROOT) !== "real") return;
    const root = stateKind(ROOT);
    if (root === "absent") renameSync(LEGACY_ROOT, ROOT);
    else if (root === "shell") {
      rmSync(ROOT, { recursive: true, force: true });
      renameSync(LEGACY_ROOT, ROOT);
    }
  } catch {}
}

export function ensureDirs(): void {
  migrateLegacyRoot();
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
      // holder crashed mid-write? critical sections are milliseconds — a lock older than 30s is stale
      try {
        if (Date.now() - statSync(PATHS.queueLock).mtimeMs > 30_000) {
          unlinkSync(PATHS.queueLock);
          continue;
        }
      } catch {}
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

/** Persist runtime fields of an in-flight job so the Stop hook (a separate process
 *  reading queue.json) can correlate the live session back to this job. */
export async function persistJobFields(
  jobId: string,
  fields: Partial<Pick<import("./types.ts").Job, "sessionId" | "worktree" | "branch" | "promptSent">>,
): Promise<void> {
  await mutateQueue((q) => {
    const job = q.jobs.find((j) => j.id === jobId);
    if (job) Object.assign(job, fields);
  });
}

const TERMINAL_STATES = new Set<import("./types.ts").JobState>(["done", "failed", "cancelled"]);

/** A job `ccq clean` may drop: terminal state, and (if a cutoff is given) finished before it. */
export function isCleanable(job: import("./types.ts").Job, cutoffMs: number | null): boolean {
  if (!TERMINAL_STATES.has(job.state)) return false;
  return cutoffMs === null || (job.finishedAt ?? job.createdAt) < cutoffMs;
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

/**
 * Settings file passed to the night session via `claude --settings`. MERGES with the user's
 * real config (keychain auth + plugins intact) — it only ADDS: our completion Stop hook, and
 * allow-rules so auto mode can push + open the PR unattended. We deliberately do NOT try to
 * strip the user's own Stop hooks here (can't, via merge) — instead the daemon kills the
 * session the instant our hook writes the completion signal, cutting off any auto-continue.
 */
export function ensureHookSettings(): string {
  ensureDirs();
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url)); // pathname keeps %20 etc. — breaks paths with spaces
  const content = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${cli}" _job-done` }] }],
    },
    permissions: {
      allow: ["Bash(git push:*)", "Bash(gh pr create:*)"],
    },
  };
  atomicWrite(PATHS.hookSettings, JSON.stringify(content, null, 2));
  return PATHS.hookSettings;
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

