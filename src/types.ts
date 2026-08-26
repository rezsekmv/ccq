export type JobState =
  | "queued"
  | "running"
  | "paused_limit"
  | "needs_user"
  | "done"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  repo: string;
  prompt: string;
  state: JobState;
  createdAt: number;

  baseBranch: string | null;
  branch: string | null;
  model: string | null;
  permissionMode: string | null;
  push: boolean; // opt-in: push the finished branch to origin. Default false ⇒ commit stays local
  pr: boolean; // opt-in: open a PR (implies push). Default false
  commitMessage: string | null;
  timeoutSec: number | null;
  resumeMessage: string | null; // sent on resume instead of the default "continue"

  sessionId: string | null;
  promptSent: boolean; // initial prompt confirmed accepted — resume sends "continue", else re-sends prompt
  worktree: string | null;
  retries: number;
  denials: number;
  resumeAt: number | null;
  limitKind: "session" | "weekly" | null;

  transcriptPath: string | null;
  error: string | null;
  prUrl: string | null;
  finishedAt: number | null;
}

export interface WindowCfg {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  tz: string; // IANA
  days: number[]; // 0=Sun..6=Sat, gates the evening the window opened
}

export interface Config {
  window: WindowCfg;
  permissionMode: string;
  estWeeklyPctPerJob: number;
  maxJobsPerNight: number;
  maxRetries: number;
  maxDenials: number;
  model: string | null;
  branchPrefix: string;
  pollIntervalSec: number;
  resetBufferSec: number;
  jobTimeoutSec: number;
  readyTimeoutSec: number;
  claudeBin: string;
  ghBin: string;
  tmuxBin: string;
  statuslineBackup: string | null; // original statusLine.command, set by install-statusline
}

export const DEFAULT_CONFIG: Config = {
  window: { start: "23:00", end: "08:00", tz: "Europe/Budapest", days: [0, 1, 2, 3, 4, 5, 6] },
  permissionMode: "auto",
  estWeeklyPctPerJob: 2,
  maxJobsPerNight: 10,
  maxRetries: 1,
  maxDenials: 2,
  model: null,
  branchPrefix: "ccq",
  pollIntervalSec: 60,
  resetBufferSec: 120,
  jobTimeoutSec: 14400,
  readyTimeoutSec: 60,
  claudeBin: "claude",
  ghBin: "gh",
  tmuxBin: "tmux",
  statuslineBackup: null,
};

export interface RateLimit {
  used_percentage: number;
  resets_at: number; // unix epoch SECONDS
}

export interface UsageSnapshot {
  ts: number; // epoch ms when written
  five_hour: RateLimit;
  seven_day: RateLimit;
}

export interface Meta {
  jobsThisNight: number;
  nightAnchor: number | null; // epoch ms of the window-open this counter belongs to
}

export interface Queue {
  jobs: Job[];
  meta: Meta;
}

export interface StopSignal {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export function newJob(partial: Pick<Job, "repo" | "prompt"> & Partial<Job>): Job {
  return {
    id: crypto.randomUUID(),
    state: "queued",
    createdAt: Date.now(),
    baseBranch: null,
    branch: null,
    model: null,
    permissionMode: null,
    push: false,
    pr: false,
    commitMessage: null,
    timeoutSec: null,
    resumeMessage: null,
    sessionId: null,
    promptSent: false,
    worktree: null,
    retries: 0,
    denials: 0,
    resumeAt: null,
    limitKind: null,
    transcriptPath: null,
    error: null,
    prUrl: null,
    finishedAt: null,
    ...partial,
  };
}
