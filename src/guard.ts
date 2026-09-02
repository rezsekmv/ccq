import type { Config, UsageSnapshot, WindowCfg } from "./types.ts";

const DAY_MS = 86_400_000;

interface LocalTime {
  minutes: number; // minutes since local midnight
  dow: number; // 0=Sun..6=Sat
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function localTime(now: number, tz: string): LocalTime {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    });
    fmtCache.set(tz, fmt); // nextWindowOpen scans ~10k minutes; a fresh formatter per call is seconds of CPU
  }
  const parts = fmt.formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    minutes: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10),
    dow: dows.indexOf(get("weekday")),
  };
}

function hm(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Inside off-peak window? `days` gates the evening the window OPENED (02:00 → prior day). */
export function isInWindow(now: number, w: WindowCfg): boolean {
  const { minutes, dow } = localTime(now, w.tz);
  const start = hm(w.start);
  const end = hm(w.end);
  const overnight = start > end;
  const inTime = overnight ? minutes >= start || minutes < end : minutes >= start && minutes < end;
  if (!inTime) return false;
  const anchorDow = overnight && minutes < end ? (dow + 6) % 7 : dow;
  return w.days.includes(anchorDow);
}

/** Next epoch-ms at which the window opens (scan minute-wise; ponytail: 7 days of minutes is cheap and tz-proof). */
export function nextWindowOpen(now: number, w: WindowCfg): number {
  const step = 60_000;
  let t = now - (now % step);
  for (let i = 0; i < 7 * 24 * 60; i++) {
    t += step;
    if (isInWindow(t, w)) return t;
  }
  return now + DAY_MS; // days:[] — never opens; retry tomorrow
}

/** Next epoch-ms at which the window closes (local time == window.end), strictly after `now`.
 *  Used by `ccq now` to bound "ignore the window" to the upcoming morning. */
export function nextWindowEnd(now: number, w: WindowCfg): number {
  const step = 60_000;
  const end = hm(w.end);
  let t = now - (now % step);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t += step;
    if (localTime(t, w.tz).minutes === end) return t;
  }
  return now + DAY_MS;
}

/** Identifies which night a moment belongs to, for the per-night job counter. */
export function nightAnchor(now: number, w: WindowCfg): number {
  const step = 60_000;
  let t = now - (now % step);
  while (isInWindow(t - step, w)) t -= step;
  return t;
}

export interface GuardVerdict {
  ok: boolean;
  reason: string;
  effective: number;
  allowed: number;
}

/**
 * Weekly pace guard (user formula + one-day floor):
 *   daysRemaining = ceil((resets_at - now) / 1d)
 *   allowed = max(100/7, 100/7 * (7 - daysRemaining))
 * Dispatch iff used% + estWeeklyPctPerJob < allowed.
 */
export function weeklyGuard(snap: UsageSnapshot | null, cfg: Config, now: number): GuardVerdict {
  if (!snap) return { ok: false, reason: "no usage snapshot — open an interactive Claude Code session once (with statusline tee installed)", effective: 0, allowed: 0 };
  const resetMs = snap.seven_day.resets_at * 1000;
  if (now > resetMs) return { ok: false, reason: "usage snapshot stale (past weekly reset) — refresh via an interactive session", effective: 0, allowed: 0 };
  const daysRemaining = Math.ceil((resetMs - now) / DAY_MS);
  const allowed = Math.max(100 / 7, (100 / 7) * (7 - daysRemaining));
  const effective = snap.seven_day.used_percentage + cfg.estWeeklyPctPerJob;
  return {
    ok: effective < allowed,
    reason: `weekly used ${snap.seven_day.used_percentage.toFixed(1)}% + est ${cfg.estWeeklyPctPerJob}% vs allowed ${allowed.toFixed(1)}% (daysRemaining=${daysRemaining})`,
    effective,
    allowed,
  };
}

export interface LimitHit {
  limitKind: "session" | "weekly";
  resetAt: number; // epoch ms
}

const WEEKLY_RE = /hit your weekly limit.*?resets\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/is;
const SESSION_RE = /hit your (?:session|5-hour) limit.*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/is;

function toHour24(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const lower = ampm.toLowerCase();
  if (lower === "pm" && h !== 12) return h + 12;
  if (lower === "am" && h === 12) return 0;
  return h;
}

/** Next occurrence of local hh:mm strictly after `now` (system tz — limit text is rendered in it).
 * Advances by calendar day (setDate) then reasserts hh:mm, so DST transitions can't drift the wall clock. */
function nextLocal(now: number, hour: number, minute: number, targetDow?: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  const bump = () => {
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
  };
  if (targetDow !== undefined) {
    while (d.getDay() !== targetDow || d.getTime() <= now) bump();
  } else if (d.getTime() <= now) {
    bump();
  }
  return d.getTime();
}

/** Parse Claude Code limit-hit text. Null if no match (caller applies conservative fallback). */
export function parseLimitError(text: string, now: number = Date.now()): LimitHit | null {
  const dows = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const w = WEEKLY_RE.exec(text);
  if (w) {
    const dow = dows.indexOf(w[1]!.toLowerCase());
    const hour = toHour24(parseInt(w[2]!, 10), w[4]);
    return { limitKind: "weekly", resetAt: nextLocal(now, hour, parseInt(w[3] ?? "0", 10), dow) };
  }
  const s = SESSION_RE.exec(text);
  if (s) {
    const hour = toHour24(parseInt(s[1]!, 10), s[3]);
    return { limitKind: "session", resetAt: nextLocal(now, hour, parseInt(s[2] ?? "0", 10)) };
  }
  return null;
}

// Permission dialog + trust dialog detection. MUST run on the VISIBLE pane only
// (not scrollback) — a dismissed dialog's text lingers in history and would re-trigger.
// The "❯ 1. Yes" selector line only renders while a dialog is actually open.
const PERMISSION_RE = /❯\s*1\.\s*yes/i;
const TRUST_RE = /do you trust the files in this folder/i;

export function looksLikePermissionDialog(pane: string): boolean {
  return PERMISSION_RE.test(pane) && !TRUST_RE.test(pane);
}

export function looksLikeTrustDialog(pane: string): boolean {
  return TRUST_RE.test(pane);
}
