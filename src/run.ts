import { existsSync } from "node:fs";
import { looksLikePermissionDialog, looksLikeTrustDialog, parseLimitError, type LimitHit } from "./guard.ts";
import { appendLog, clearSignal, ensureHookSettings, readSignal, worktreePath } from "./store.ts";
import { makeTmux, sessionName, type Tmux } from "./tmux.ts";
import type { Config, Job } from "./types.ts";

export type RunOutcome =
  | { kind: "done"; transcriptPath: string | null }
  | { kind: "limit"; hit: LimitHit }
  | { kind: "needs_user" }
  | { kind: "error"; errorText: string }
  | { kind: "timeout" };

async function git(repo: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout: stdout || stderr };
}

function slug(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "job";
}

async function defaultBranch(repo: string): Promise<string> {
  const r = await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "");
  return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

export async function ensureWorktree(job: Job, cfg: Config): Promise<void> {
  if (job.worktree && existsSync(job.worktree)) return;
  const wt = worktreePath(job.id);
  const base = job.baseBranch ?? (await defaultBranch(job.repo));
  job.branch = `${cfg.branchPrefix}/${job.id.slice(0, 8)}-${slug(job.prompt)}`;
  await git(job.repo, ["worktree", "remove", "--force", wt]); // leftover from a crash; ignore failure
  await git(job.repo, ["worktree", "prune"]);
  await git(job.repo, ["branch", "-D", job.branch]); // ignore failure
  const r = await git(job.repo, ["worktree", "add", "-b", job.branch, wt, base]);
  if (r.code !== 0) throw new Error(`worktree add failed: ${r.stdout}`);
  job.worktree = wt;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(tmux: Tmux, name: string, job: Job, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let prev = "";
  while (Date.now() < deadline) {
    const pane = await tmux.captureVisible(name);
    if (looksLikeTrustDialog(pane)) {
      await tmux.sendKeys(name, ["Enter"]); // "Yes, proceed" is the default selection
      await sleep(1500);
      prev = "";
      continue;
    }
    // composer rendered AND pane stable across two polls — startup dialogs/notices race the composer
    if (/[❯>]\s|\? for shortcuts/i.test(pane) && pane === prev) return;
    if (await tmux.paneDead(name)) throw new Error(`claude exited during startup:\n${pane.trim().slice(-2000)}`);
    prev = pane;
    await sleep(2000);
  }
  throw new Error("claude UI not ready within readyTimeoutSec");
}

/** Claude is visibly working (spinner/interrupt hint) or has consumed the prompt. */
const ACTIVITY_RE = /esc to interrupt|✻|✽|✶|thinking|tokens/i;

async function submitPrompt(tmux: Tmux, name: string, job: Job, text: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tmux.paste(name, text);
    await sleep(5000);
    const pane = await tmux.captureVisible(name);
    // accepted = working, finished already, limit reported, or a dialog popped — main loop handles all of those
    if (ACTIVITY_RE.test(pane) || readSignal(job.id) || parseLimitError(pane) || looksLikePermissionDialog(pane)) return;
    appendLog(job.id, `paste attempt ${attempt} not accepted, retrying\n${pane.slice(-1500)}`);
    await sleep(3000);
  }
  throw new Error("prompt was not accepted by claude UI after 3 paste attempts");
}

/**
 * Run one job inside tmux until Stop-hook signal / limit / needs_user / timeout.
 * Session is left alive only for needs_user; every other outcome kills it.
 */
export async function runJob(job: Job, cfg: Config): Promise<RunOutcome> {
  const tmux = makeTmux(cfg.tmuxBin);
  const name = sessionName(job.id);
  const hookSettings = ensureHookSettings();

  await ensureWorktree(job, cfg);
  // prompt never landed in the previous attempt → the old session has no context worth resuming
  const resuming = job.promptSent && !!job.sessionId;
  if (!resuming) job.sessionId = crypto.randomUUID();
  clearSignal(job.id);

  const model = job.model ?? cfg.model;
  const claudeBin = Bun.which(cfg.claudeBin) ?? cfg.claudeBin; // absolute: tmux shells may lack user PATH
  const parts = [
    `"${claudeBin}"`,
    resuming ? `--resume ${job.sessionId}` : `--session-id ${job.sessionId}`,
    `--permission-mode ${job.permissionMode ?? cfg.permissionMode}`,
    `--settings "${hookSettings}"`,
    model ? `--model ${model}` : "",
  ];
  if (await tmux.hasSession(name)) await tmux.killSession(name);
  await tmux.newSession(name, job.worktree!, parts.filter(Boolean).join(" "));

  try {
    await waitForReady(tmux, name, job, cfg.readyTimeoutSec);
    await submitPrompt(tmux, name, job, resuming ? "continue" : job.prompt);
    job.promptSent = true;
  } catch (e: any) {
    const pane = await tmux.capturePane(name).catch(() => "");
    appendLog(job.id, pane);
    await tmux.killSession(name);
    return { kind: "error", errorText: e.message };
  }

  const timeoutMs = (job.timeoutSec ?? cfg.jobTimeoutSec) * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    await sleep(5000);
    const signal = readSignal(job.id);
    const pane = await tmux.capturePane(name).catch(() => "");
    if (pane && Date.now() - lastLogAt > 60_000) {
      appendLog(job.id, pane);
      lastLogAt = Date.now();
    }
    lastPane = pane || lastPane;

    const hit = parseLimitError(pane);
    if (hit) {
      appendLog(job.id, pane);
      await tmux.killSession(name);
      return { kind: "limit", hit };
    }

    if (signal) {
      appendLog(job.id, pane);
      await tmux.killSession(name);
      return { kind: "done", transcriptPath: signal.transcript_path ?? null };
    }

    const visible = await tmux.captureVisible(name).catch(() => "");
    if (looksLikeTrustDialog(visible)) {
      await tmux.sendKeys(name, ["Enter"]);
      await sleep(1500);
      continue;
    }
    if (looksLikePermissionDialog(visible)) {
      job.denials++;
      if (job.denials > cfg.maxDenials) {
        appendLog(job.id, `needs_user: permission dialog persisted after ${cfg.maxDenials} denials\n${visible}`);
        return { kind: "needs_user" }; // session stays ALIVE for morning attach
      }
      appendLog(job.id, `auto-denying permission dialog (${job.denials}/${cfg.maxDenials})\n${visible}`);
      await tmux.sendKeys(name, ["Escape"]); // Esc = reject/dismiss, Claude continues with denial
      await sleep(3000);
      continue;
    }

    if (await tmux.paneDead(name)) {
      appendLog(job.id, pane);
      await tmux.killSession(name);
      return { kind: "error", errorText: `claude exited without Stop signal:\n${lastPane.trim().slice(-2000)}` };
    }
  }

  appendLog(job.id, lastPane);
  await tmux.killSession(name);
  return { kind: "timeout" };
}

/** Commit whatever the run produced, push, open PR. Never throws — PR/push failure is recorded, not fatal. */
export async function finalize(job: Job, cfg: Config): Promise<void> {
  const wt = job.worktree!;
  const base = job.baseBranch ?? (await defaultBranch(job.repo));

  await git(wt, ["add", "-A"]);
  const dirty = (await git(wt, ["status", "--porcelain"])).stdout.trim().length > 0;
  if (dirty) {
    const msg = job.commitMessage ?? job.prompt.split("\n")[0]!.slice(0, 72);
    const c = await git(wt, ["commit", "-m", msg]);
    if (c.code !== 0) {
      job.error = `commit failed: ${c.stdout.slice(0, 500)}`;
      return;
    }
  }
  const ahead = parseInt((await git(wt, ["rev-list", `${base}..HEAD`, "--count"])).stdout.trim() || "0", 10);
  if (!dirty && ahead === 0) return; // research-only job: transcript is the artifact

  const push = await git(wt, ["push", "-u", "origin", job.branch!]);
  if (push.code !== 0) {
    job.error = `push failed (commit is on local branch ${job.branch}): ${push.stdout.slice(0, 500)}`;
    return;
  }

  if (cfg.alwaysPr && !job.noPr) {
    try {
      const proc = Bun.spawn([cfg.ghBin, "pr", "create", "--fill", "--head", job.branch!, "--base", base], {
        cwd: wt,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      if ((await proc.exited) === 0) {
        job.prUrl = out.match(/https:\/\/\S+/)?.[0] ?? null;
      } else {
        job.error = `pr create failed (branch pushed): ${out.slice(0, 500)}`;
      }
    } catch (e: any) {
      job.error = `pr create failed (branch pushed): ${e.message}`; // e.g. gh binary missing
    }
  }
}

export async function removeWorktree(job: Job): Promise<void> {
  if (!job.worktree) return;
  await git(job.repo, ["worktree", "remove", "--force", job.worktree]);
  await git(job.repo, ["worktree", "prune"]);
  job.worktree = null;
}
