import { describe, expect, test } from "bun:test";
import { isInWindow, looksLikePermissionDialog, looksLikeTrustDialog, nextWindowEnd, nextWindowOpen, nightAnchor, parseLimitError, trustDialogKey, weeklyGuard } from "./guard.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import type { UsageSnapshot, WindowCfg } from "./types.ts";

const W: WindowCfg = { start: "23:00", end: "08:00", tz: "Europe/Budapest", days: [0, 1, 2, 3, 4, 5, 6] };

/** Budapest local time → epoch ms. July = CEST (UTC+2). */
function bud(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h - 2, mi);
}

describe("isInWindow (overnight 23:00–08:00)", () => {
  test("22:59 outside", () => expect(isInWindow(bud(2026, 7, 15, 22, 59), W)).toBe(false));
  test("23:00 inside", () => expect(isInWindow(bud(2026, 7, 15, 23, 0), W)).toBe(true));
  test("00:30 inside", () => expect(isInWindow(bud(2026, 7, 16, 0, 30), W)).toBe(true));
  test("07:59 inside", () => expect(isInWindow(bud(2026, 7, 16, 7, 59), W)).toBe(true));
  test("08:00 outside", () => expect(isInWindow(bud(2026, 7, 16, 8, 0), W)).toBe(false));

  test("days gate anchors to evening of open", () => {
    // 2026-07-15 is a Wednesday (dow 3). Window without Wednesday:
    const noWed = { ...W, days: [0, 1, 2, 4, 5, 6] };
    expect(isInWindow(bud(2026, 7, 15, 23, 30), noWed)).toBe(false); // Wed evening
    expect(isInWindow(bud(2026, 7, 16, 2, 0), noWed)).toBe(false); // Thu 02:00 belongs to Wed's window
    expect(isInWindow(bud(2026, 7, 16, 23, 30), noWed)).toBe(true); // Thu evening fine
  });
});

describe("nextWindowOpen / nightAnchor", () => {
  test("mid-day → tonight 23:00", () => {
    const open = nextWindowOpen(bud(2026, 7, 15, 12, 0), W);
    expect(open).toBe(bud(2026, 7, 15, 23, 0));
  });
  test("anchor of 02:00 is prior evening 23:00", () => {
    expect(nightAnchor(bud(2026, 7, 16, 2, 0), W)).toBe(bud(2026, 7, 15, 23, 0));
  });
});

describe("nextWindowEnd (ccq now → run until morning)", () => {
  test("midday → next 08:00 is tomorrow", () => {
    expect(nextWindowEnd(bud(2026, 7, 15, 12, 0), W)).toBe(bud(2026, 7, 16, 8, 0));
  });
  test("02:00 inside window → 08:00 same morning", () => {
    expect(nextWindowEnd(bud(2026, 7, 16, 2, 0), W)).toBe(bud(2026, 7, 16, 8, 0));
  });
  test("exactly 08:00 → next day's 08:00 (strictly after now)", () => {
    expect(nextWindowEnd(bud(2026, 7, 15, 8, 0), W)).toBe(bud(2026, 7, 16, 8, 0));
  });
});

describe("weeklyGuard", () => {
  const now = Date.UTC(2026, 6, 15, 12, 0); // arbitrary fixed point
  const snap = (usedPct: number, daysToReset: number): UsageSnapshot => ({
    ts: now,
    five_hour: { used_percentage: 0, resets_at: Math.floor(now / 1000) + 3600 },
    seven_day: { used_percentage: usedPct, resets_at: Math.floor(now / 1000) + daysToReset * 86400 },
  });

  test("no snapshot → refuse", () => expect(weeklyGuard(null, DEFAULT_CONFIG, now).ok).toBe(false));

  test("stale snapshot (past reset) → refuse", () => {
    const s = snap(10, 1);
    expect(weeklyGuard(s, DEFAULT_CONFIG, now + 2 * 86_400_000).ok).toBe(false);
  });

  test("user example: reset Sun 18:00, now Sun 08:00 → daysRemaining 1, allowed ~85.7", () => {
    const s = snap(50, 10 / 24); // 10h to reset
    const v = weeklyGuard(s, DEFAULT_CONFIG, now);
    expect(v.allowed).toBeCloseTo((100 / 7) * 6, 1);
    expect(v.ok).toBe(true); // 50 + 2 < 85.7
  });

  test("first night after reset gets one-day floor", () => {
    const s = snap(0, 6.9); // daysRemaining ceil → 7 → formula 0, floor 14.3
    const v = weeklyGuard(s, DEFAULT_CONFIG, now);
    expect(v.allowed).toBeCloseTo(100 / 7, 1);
    expect(v.ok).toBe(true); // 0 + 2 < 14.3
  });

  test("over pace → refuse", () => {
    const s = snap(60, 4); // daysRemaining 4 → allowed 42.9
    expect(weeklyGuard(s, DEFAULT_CONFIG, now).ok).toBe(false);
  });

  test("boundary: effective just under allowed passes", () => {
    const s = snap(40, 4); // allowed 42.9; 40 + 2 = 42 < 42.9
    expect(weeklyGuard(s, DEFAULT_CONFIG, now).ok).toBe(true);
  });
});

describe("parseLimitError", () => {
  // Wed 2026-07-15 15:00 local as "now"
  const now = new Date(2026, 6, 15, 15, 0).getTime();

  test("session limit same day", () => {
    const hit = parseLimitError("You've hit your session limit · resets 3:45pm", now)!;
    expect(hit.limitKind).toBe("session");
    expect(new Date(hit.resetAt).getHours()).toBe(15);
    expect(new Date(hit.resetAt).getMinutes()).toBe(45);
    expect(hit.resetAt).toBeGreaterThan(now);
  });

  test("session limit rolls to next day when time passed", () => {
    const hit = parseLimitError("You've hit your session limit · resets 2:00pm", now)!;
    expect(hit.resetAt).toBeGreaterThan(now);
    expect(new Date(hit.resetAt).getDate()).toBe(16);
  });

  test("weekly limit next monday", () => {
    const hit = parseLimitError("You've hit your weekly limit · resets Mon 12:00am", now)!;
    expect(hit.limitKind).toBe("weekly");
    const d = new Date(hit.resetAt);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(hit.resetAt).toBeGreaterThan(now);
  });

  test("5-hour phrasing variant", () => {
    expect(parseLimitError("You've hit your 5-hour limit · resets 6pm", now)!.limitKind).toBe("session");
  });

  test("garbage → null", () => {
    expect(parseLimitError("some unrelated error", now)).toBeNull();
  });
});

describe("trust dialog", () => {
  const NEW_DIALOG = [
    " Accessing workspace:",
    " /Users/x/.ccq/worktrees/abc",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).",
    " Claude Code'll be able to read, edit, and execute files here.",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const OLD_DIALOG = [
    " Do you trust the files in this folder?",
    " ❯ 1. Yes, proceed",
    "   2. No, exit",
  ].join("\n");

  test("detects the current wording", () => {
    expect(looksLikeTrustDialog(NEW_DIALOG)).toBe(true);
    expect(looksLikePermissionDialog(NEW_DIALOG)).toBe(false);
  });
  test("still detects the older wording", () => {
    expect(looksLikeTrustDialog(OLD_DIALOG)).toBe(true);
    expect(looksLikePermissionDialog(OLD_DIALOG)).toBe(false);
  });
  test("moves off a preselected No instead of confirming it", () => {
    expect(trustDialogKey(NEW_DIALOG)).toBe("Down");
  });
  test("confirms once Yes is selected", () => {
    expect(trustDialogKey(NEW_DIALOG.replace("❯ No, exit", "  No, exit").replace("   Yes, I trust", " ❯ Yes, I trust"))).toBe("Enter");
    expect(trustDialogKey(OLD_DIALOG)).toBe("Enter");
  });
  test("a permission dialog quoting the trust text stays a permission dialog", () => {
    const pane = [
      " Edit file src/guard.ts",
      "  167 -const TRUST_RE = /do you trust the files in this folder/i;",
      "  167 +const TRUST_RE = /do you trust the files in this folder|is this a project you created or one you trust|yes, i trust this folder/i;",
      "  168 +// Quick safety check: Is this a project you created or one you trust?",
      "  169 +//   Yes, I trust this folder",
      " Do you want to make this edit to guard.ts?",
      " ❯ 1. Yes",
      "   2. Yes, allow all edits during this session",
      "   3. No",
    ].join("\n");
    expect(looksLikeTrustDialog(pane)).toBe(false);
    expect(looksLikePermissionDialog(pane)).toBe(true);
  });
  test("a prose mention of the wording is not a trust dialog", () => {
    expect(looksLikeTrustDialog(' The dialog reads "Is this a project you created or one you trust?" with "No, exit" preselected.')).toBe(false);
  });
  test("Yes inside another selected line does not confirm", () => {
    expect(trustDialogKey(NEW_DIALOG.replace("❯ No, exit", "❯ No, exit (Yes is below)"))).toBe("Down");
  });
  test("an ordinary composer is not a trust dialog", () => {
    expect(looksLikeTrustDialog("❯ \n? for shortcuts")).toBe(false);
  });
});
