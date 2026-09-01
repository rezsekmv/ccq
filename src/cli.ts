#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { daemon } from "./daemon.ts";
import { isInWindow, nextWindowOpen, weeklyGuard } from "./guard.ts";
import { PATHS, atomicWrite, ensureDirs, isCleanable, loadConfig, loadQueue, loadUsage, logPath, mutateQueue, saveConfig, signalPath } from "./store.ts";
import { sessionName } from "./tmux.ts";
import { newJob, type Job } from "./types.ts";

const args = process.argv.slice(2);
const cmd = args.shift() ?? "help";

function flag(name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function opt(name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  const v = args[i + 1]!;
  args.splice(i, 2);
  return v;
}

function findJob(jobs: Job[], idPrefix: string): Job {
  const matches = jobs.filter((j) => j.id.startsWith(idPrefix));
  if (matches.length === 0) throw new Error(`no job matching '${idPrefix}'`);
  if (matches.length > 1) throw new Error(`ambiguous id '${idPrefix}' (${matches.length} matches)`);
  return matches[0]!;
}

function shortRow(j: Job): string {
  const head = j.prompt.split("\n")[0]!.slice(0, 50);
  const extra =
    j.state === "needs_user"
      ? ` → tmux attach -t ${sessionName(j.id)}`
      : j.state === "paused_limit"
        ? ` → resume ${j.resumeAt ? new Date(j.resumeAt).toLocaleString() : "?"}`
        : j.prUrl
          ? ` → ${j.prUrl}`
          : j.error
            ? ` → ${j.error.split("\n")[0]!.slice(0, 60)}`
            : "";
  return `${j.id.slice(0, 8)}  ${j.state.padEnd(12)}  ${j.repo.replace(homedir(), "~").padEnd(35)}  ${head}${extra}`;
}

async function cmdAdd(): Promise<void> {
  const repo = resolve(opt("--repo") ?? process.cwd());
  if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git repository (use --repo)`);
  const file = opt("--file");
  const at = opt("--at");
  const timeout = opt("--timeout");
  const job = newJob({
    repo,
    prompt: "",
    baseBranch: opt("--base"),
    model: opt("--model"),
    permissionMode: opt("--permission-mode"),
    commitMessage: opt("-m") ?? opt("--message"),
    timeoutSec: timeout ? parseInt(timeout, 10) : null,
    push: flag("--push"),
    pr: flag("--pr"), // implies push; handled in finalize
  });
  // prompt source: --file > "-" (stdin) > positional arg
  let prompt: string;
  if (file) prompt = readFileSync(file, "utf8");
  else if (args[0] === "-" || args.length === 0) prompt = await new Response(Bun.stdin.stream()).text();
  else prompt = args.join(" ");
  if (!prompt.trim()) throw new Error("empty prompt");
  job.prompt = prompt.trim();

  await mutateQueue((q) => {
    const pos = at !== null ? Math.min(parseInt(at, 10), q.jobs.length) : q.jobs.length;
    q.jobs.splice(pos, 0, job);
  });
  console.log(`queued ${job.id.slice(0, 8)} (${job.repo})`);
}

function cmdList(): void {
  const q = loadQueue();
  if (q.jobs.length === 0) return console.log("queue empty");
  for (const j of q.jobs) console.log(shortRow(j));
}

function cmdStatus(): void {
  const cfg = loadConfig();
  const now = Date.now();
  const inWin = isInWindow(now, cfg.window);
  console.log(`window   ${cfg.window.start}–${cfg.window.end} ${cfg.window.tz} — ${inWin ? "OPEN" : `closed, next open ${new Date(nextWindowOpen(now, cfg.window)).toLocaleString()}`}`);

  const usage = loadUsage();
  if (usage) {
    console.log(`usage    5h ${usage.five_hour.used_percentage.toFixed(1)}% (resets ${new Date(usage.five_hour.resets_at * 1000).toLocaleString()})`);
    console.log(`         7d ${usage.seven_day.used_percentage.toFixed(1)}% (resets ${new Date(usage.seven_day.resets_at * 1000).toLocaleString()})`);
    console.log(`         snapshot age ${Math.round((now - usage.ts) / 60000)}m`);
  } else {
    console.log("usage    NO SNAPSHOT — run `ccq install-statusline`, then open an interactive claude session");
  }
  const verdict = weeklyGuard(usage, cfg, now);
  console.log(`guard    ${verdict.ok ? "PASS" : "REFUSE"} — ${verdict.reason}`);

  const q = loadQueue();
  console.log(`night    ${q.meta.jobsThisNight}/${cfg.maxJobsPerNight} jobs this night`);
  console.log("");
  cmdList();
}

async function cmdMv(): Promise<void> {
  const [idPrefix, posStr] = [args[0], args[1]];
  if (!idPrefix || posStr === undefined) throw new Error("usage: ccq mv <id> <position>");
  await mutateQueue((q) => {
    const job = findJob(q.jobs, idPrefix);
    q.jobs.splice(q.jobs.indexOf(job), 1);
    q.jobs.splice(Math.min(parseInt(posStr, 10), q.jobs.length), 0, job);
  });
  cmdList();
}

async function cmdRm(): Promise<void> {
  const idPrefix = args[0];
  if (!idPrefix) throw new Error("usage: ccq rm <id>");
  const { job, wasRunning } = await mutateQueue((q) => {
    const j = findJob(q.jobs, idPrefix);
    const wasRunning = j.state === "running";
    j.state = "cancelled";
    return { job: structuredClone(j), wasRunning };
  });
  if (wasRunning) {
    // never kill mid-run: daemon finishes the current run, sees cancelled, and cleans up
    return console.log(`cancelled ${job.id.slice(0, 8)} — running job finishes first, daemon cleans up after`);
  }
  if (job.worktree) {
    spawnSync("git", ["-C", job.repo, "worktree", "remove", "--force", job.worktree]);
    spawnSync("git", ["-C", job.repo, "worktree", "prune"]);
  }
  spawnSync(loadConfig().tmuxBin, ["kill-session", "-t", sessionName(job.id)]);
  console.log(`cancelled ${job.id.slice(0, 8)}`);
}

async function cmdClean(): Promise<void> {
  const daysStr = opt("--days");
  const cutoff = daysStr ? Date.now() - parseInt(daysStr, 10) * 86_400_000 : null;
  const removed = await mutateQueue((q) => {
    const drop = q.jobs.filter((j) => isCleanable(j, cutoff));
    q.jobs = q.jobs.filter((j) => !drop.includes(j));
    return drop;
  });
  // sweep any worktree a terminal job left behind (defensive; normally already removed)
  for (const j of removed) {
    if (j.worktree) {
      spawnSync("git", ["-C", j.repo, "worktree", "remove", "--force", j.worktree]);
      spawnSync("git", ["-C", j.repo, "worktree", "prune"]);
    }
  }
  console.log(`cleaned ${removed.length} finished job${removed.length === 1 ? "" : "s"}${cutoff ? ` older than ${daysStr}d` : ""}`);
}

function cmdLogs(): void {
  const idPrefix = args.filter((a) => a !== "-f")[0];
  if (!idPrefix) throw new Error("usage: ccq logs <id> [-f]");
  const job = findJob(loadQueue().jobs, idPrefix);
  const path = logPath(job.id);
  if (args.includes("-f")) {
    spawnSync("tail", ["-f", path], { stdio: "inherit" });
  } else {
    console.log(readFileSync(path, "utf8"));
  }
}

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

function cmdInstallStatusline(): void {
  const cfg = loadConfig();
  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  const self = process.argv[1];

  if (flag("--uninstall")) {
    if (!cfg.statuslineBackup) throw new Error("no backup recorded — nothing to uninstall");
    settings.statusLine = { type: "command", command: cfg.statuslineBackup };
    atomicWrite(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    cfg.statuslineBackup = null;
    saveConfig(cfg);
    return console.log("statusline restored");
  }

  const current: string = settings.statusLine?.command ?? "";
  if (current.includes("statusline-tee")) return console.log("already installed");
  cfg.statuslineBackup = current || null;
  saveConfig(cfg);
  const tee = `"${process.execPath}" "${self}" statusline-tee${current ? ` -- ${current}` : ""}`;
  settings.statusLine = { type: "command", command: tee };
  atomicWrite(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`statusline tee installed (original backed up in ${PATHS.config})`);
}

async function cmdStatuslineTee(): Promise<void> {
  const sep = args.indexOf("--");
  const original = sep >= 0 ? args.slice(sep + 1) : [];
  const input = await new Response(Bun.stdin.stream()).text();
  try {
    const payload = JSON.parse(input);
    if (payload.rate_limits?.five_hour && payload.rate_limits?.seven_day) {
      ensureDirs();
      atomicWrite(PATHS.usage, JSON.stringify({ ts: Date.now(), ...payload.rate_limits }, null, 2));
    }
  } catch {} // never break the statusline UI
  if (original.length > 0) {
    const r = spawnSync("sh", ["-c", original.join(" ")], { input, stdio: ["pipe", "inherit", "inherit"] });
    process.exit(r.status ?? 0);
  }
}

async function cmdJobDone(): Promise<void> {
  // Stop-hook target. Payload on stdin; match cwd → job worktree; drop signal file. Never fail loudly.
  try {
    const payload = JSON.parse(await new Response(Bun.stdin.stream()).text());
    const sid: string = payload.session_id ?? "";
    const q = loadQueue();
    // Correlate by session_id (we assign --session-id ourselves) — robust to cwd symlink
    // differences (/tmp vs /private/tmp) that a path match would trip on.
    const job = q.jobs.find((j) => (j.state === "running" || j.state === "needs_user") && j.sessionId && j.sessionId === sid);
    if (job) {
      ensureDirs();
      atomicWrite(signalPath(job.id), JSON.stringify({ session_id: sid, transcript_path: payload.transcript_path, cwd: payload.cwd ?? "" }));
    }
  } catch {}
}

function help(): void {
  console.log(`ccq — Claude Code off-peak prompt queue

  ccq add [prompt|-] [--repo p] [--file f] [--at N] [--base b] [--model m]
          [--permission-mode m] [--push] [--pr] [--timeout sec] [-m commitMsg]
          (default: commit only; --push pushes the branch, --pr pushes + opens a PR)
  ccq list | ls
  ccq status
  ccq mv <id> <position>
  ccq rm <id>
  ccq clean [--days N]        # drop finished jobs (done/failed/cancelled) from the queue
  ccq logs <id> [-f]
  ccq daemon [--once]
  ccq install-statusline [--uninstall]`);
}

try {
  switch (cmd) {
    case "add": await cmdAdd(); break;
    case "list": case "ls": cmdList(); break;
    case "status": cmdStatus(); break;
    case "mv": await cmdMv(); break;
    case "rm": await cmdRm(); break;
    case "clean": await cmdClean(); break;
    case "logs": cmdLogs(); break;
    case "daemon": await daemon(flag("--once")); break;
    case "install-statusline": cmdInstallStatusline(); break;
    case "statusline-tee": await cmdStatuslineTee(); break;
    case "_job-done": await cmdJobDone(); break;
    default: help();
  }
} catch (e: any) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
