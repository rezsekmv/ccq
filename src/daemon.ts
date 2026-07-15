import { isInWindow, nextWindowOpen, nightAnchor, weeklyGuard } from "./guard.ts";
import { finalize, removeWorktree, runJob, type RunOutcome } from "./run.ts";
import { acquireDaemonLock, clearSignal, loadConfig, loadUsage, mutateQueue, readSignal, releaseDaemonLock } from "./store.ts";
import { makeTmux, sessionName } from "./tmux.ts";
import type { Config, Job } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function reconcile(cfg: Config): Promise<void> {
  const keepAlive = new Set<string>();
  await mutateQueue((q) => {
    for (const job of q.jobs) {
      if (job.state === "running") {
        job.state = "paused_limit"; // daemon died mid-run; resume path picks it up
        job.resumeAt = Date.now();
        log(`reconcile: job ${job.id.slice(0, 8)} running → paused_limit`);
      }
      if (job.state === "needs_user") keepAlive.add(sessionName(job.id));
    }
  });
  const tmux = makeTmux(cfg.tmuxBin);
  for (const name of await tmux.listCcqSessions()) {
    if (!keepAlive.has(name)) {
      log(`reconcile: killing orphan tmux session ${name}`);
      await tmux.killSession(name);
    }
  }
}

/** needs_user jobs finish when the user answers the dialog and Claude's Stop hook fires. */
async function sweepNeedsUser(cfg: Config): Promise<void> {
  const jobs = (await mutateQueue((q) => q.jobs.filter((j) => j.state === "needs_user"))) as Job[];
  for (const job of jobs) {
    const signal = readSignal(job.id);
    if (!signal) continue;
    log(`needs_user job ${job.id.slice(0, 8)} answered — finalizing`);
    job.transcriptPath = signal.transcript_path ?? null;
    await makeTmux(cfg.tmuxBin).killSession(sessionName(job.id));
    await finalize(job, cfg);
    await removeWorktree(job);
    job.state = "done";
    job.finishedAt = Date.now();
    await mutateQueue((q) => {
      const i = q.jobs.findIndex((x) => x.id === job.id);
      // rm during finalize marks it cancelled — never overwrite that
      if (i >= 0 && q.jobs[i]!.state !== "cancelled") q.jobs[i] = job;
    });
    clearSignal(job.id); // after persist — crash in between must not strand a needs_user job without its signal
  }
}

async function dispatchOne(cfg: Config): Promise<"ran" | "idle" | { sleepUntil: number }> {
  const now = Date.now();

  const picked = await mutateQueue((q) => {
    const anchor = nightAnchor(now, cfg.window);
    if (q.meta.nightAnchor !== anchor) {
      q.meta.nightAnchor = anchor;
      q.meta.jobsThisNight = 0;
    }
    if (q.meta.jobsThisNight >= cfg.maxJobsPerNight) return "night-cap";

    const resumable = q.jobs.find((j) => j.state === "paused_limit" && (j.resumeAt ?? 0) <= now);
    const job = resumable ?? q.jobs.find((j) => j.state === "queued");
    if (!job) return null;

    const verdict = weeklyGuard(loadUsage(), cfg, now);
    if (!verdict.ok) return { guard: verdict.reason };

    job.state = "running";
    return { job: structuredClone(job), resuming: !!resumable };
  });

  if (picked === null) return "idle";
  if (picked === "night-cap") {
    log(`night cap reached (${cfg.maxJobsPerNight}) — sleeping to next window`);
    return { sleepUntil: nextWindowOpen(now, cfg.window) };
  }
  if ("guard" in picked) {
    log(`weekly guard refused: ${picked.guard}`);
    return { sleepUntil: now + 30 * 60_000 }; // allowed rises daily; recheck in 30m
  }

  const { job, resuming } = picked;
  log(`${resuming ? "resuming" : "starting"} job ${job.id.slice(0, 8)}: ${job.prompt.split("\n")[0]!.slice(0, 60)}`);

  // blocking; may overrun window end by design. A setup throw (worktree/tmux) must not
  // strand the job in "running" — fold it into the error outcome path.
  const outcome = await runJob(job, cfg).catch((e): RunOutcome => ({ kind: "error", errorText: e.message }));
  let sleepUntil: number | null = null;

  switch (outcome.kind) {
    case "done":
      job.transcriptPath = outcome.transcriptPath;
      await finalize(job, cfg);
      await removeWorktree(job);
      job.state = "done";
      job.finishedAt = Date.now();
      clearSignal(job.id);
      log(`job ${job.id.slice(0, 8)} done${job.prUrl ? ` — PR ${job.prUrl}` : ""}${job.error ? ` (warning: ${job.error})` : ""}`);
      break;
    case "limit":
      job.state = "paused_limit";
      job.limitKind = outcome.hit.limitKind;
      job.resumeAt = outcome.hit.resetAt + cfg.resetBufferSec * 1000;
      sleepUntil = job.resumeAt;
      log(`job ${job.id.slice(0, 8)} hit ${job.limitKind} limit — resume at ${new Date(job.resumeAt).toISOString()}`);
      break;
    case "needs_user":
      job.state = "needs_user";
      log(`job ${job.id.slice(0, 8)} needs user — attach: tmux attach -t ${sessionName(job.id)}`);
      break;
    case "error":
      if (job.retries < cfg.maxRetries) {
        job.retries++;
        job.state = "paused_limit"; // reuse resume path: same session, "continue"
        job.resumeAt = Date.now();
        log(`job ${job.id.slice(0, 8)} error, retry ${job.retries}/${cfg.maxRetries}: ${outcome.errorText.slice(0, 200)}`);
      } else {
        job.state = "failed";
        job.error = outcome.errorText.slice(0, 2000);
        job.finishedAt = Date.now();
        await removeWorktree(job);
        log(`job ${job.id.slice(0, 8)} failed: ${outcome.errorText.slice(0, 200)}`);
      }
      break;
    case "timeout":
      job.state = "failed";
      job.error = `timeout after ${job.timeoutSec ?? cfg.jobTimeoutSec}s`;
      job.finishedAt = Date.now();
      await removeWorktree(job);
      log(`job ${job.id.slice(0, 8)} timed out`);
      break;
  }

  const cancelledMidRun = await mutateQueue((q) => {
    const i = q.jobs.findIndex((x) => x.id === job.id);
    // rm-while-running marks the job cancelled — never overwrite that
    if (i >= 0 && q.jobs[i]!.state === "cancelled") return true;
    if (i >= 0) q.jobs[i] = job;
    if (outcome.kind === "done") q.meta.jobsThisNight++;
    return false;
  });
  if (cancelledMidRun) {
    log(`job ${job.id.slice(0, 8)} was cancelled mid-run — cleaning up`);
    await makeTmux(cfg.tmuxBin).killSession(sessionName(job.id));
    await removeWorktree(job);
  }

  if (sleepUntil) return { sleepUntil };
  return "ran";
}

export async function daemon(once: boolean): Promise<void> {
  const cfg = loadConfig();
  if (!acquireDaemonLock()) {
    console.error("another ccq daemon is already running");
    process.exit(1);
  }
  process.on("exit", releaseDaemonLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  log(`ccq daemon up — window ${cfg.window.start}–${cfg.window.end} ${cfg.window.tz}`);
  await reconcile(cfg);

  for (;;) {
    const now = Date.now();
    // one failing job must never kill the daemon — log and keep polling
    await sweepNeedsUser(cfg).catch((e) => log(`sweepNeedsUser error: ${e.message}`));

    if (!isInWindow(now, cfg.window)) {
      if (once) return log("outside window — exiting (--once)");
      const open = nextWindowOpen(now, cfg.window);
      const wait = Math.min(cfg.pollIntervalSec * 1000, open - now);
      await sleep(Math.max(wait, 1000));
      continue;
    }

    const result = await dispatchOne(cfg).catch((e): "idle" => {
      log(`dispatchOne error: ${e.message}`);
      return "idle";
    });
    if (once) return log("--once done");
    if (result === "idle") {
      await sleep(cfg.pollIntervalSec * 1000);
    } else if (typeof result === "object") {
      const wait = Math.max(result.sleepUntil - Date.now(), cfg.pollIntervalSec * 1000);
      await sleep(Math.min(wait, 60 * 60_000)); // wake at least hourly (needs_user sweep, fresh config read of usage)
    }
  }
}
