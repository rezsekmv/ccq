import { describe, expect, test } from "bun:test";
import { isAncestor, isJobSession, orphanSessions, paneTarget, sessionName, sessionTarget } from "./tmux.ts";

describe("isJobSession", () => {
  const id = crypto.randomUUID();

  test("matches the session name of a real job", () => {
    expect(isJobSession(sessionName(id))).toBe(true);
  });

  test("ignores non-job sessions that share the ccq prefix", () => {
    for (const n of ["ccq", "ccq-daemon", "ccq-", "ccq-1234567", "ccq-123456789", "ccq-ABCDEF12", "xccq-12345678"]) {
      expect(isJobSession(n)).toBe(false);
    }
  });
});

describe("orphanSessions", () => {
  const live = sessionName(crypto.randomUUID());
  const orphan = sessionName(crypto.randomUUID());

  test("kills orphan job sessions but never the daemon's own session", () => {
    expect(orphanSessions(["ccq-daemon", "ccq", orphan, "main"], new Set())).toEqual([orphan]);
  });

  test("keeps any job-shaped session listed in keepAlive", () => {
    expect(orphanSessions(["ccq-12345678", orphan], new Set(["ccq-12345678"]))).toEqual([orphan]);
  });

  test("keeps sessions of needs_user jobs alive", () => {
    expect(orphanSessions([live, orphan, "ccq-daemon"], new Set([live]))).toEqual([orphan]);
  });
});

describe("exact tmux targets", () => {
  test("session and pane targets disable tmux prefix matching", () => {
    expect(sessionTarget("ccq")).toBe("=ccq");
    expect(paneTarget("ccq-abcdef12")).toBe("=ccq-abcdef12:");
  });
});

describe("isAncestor", () => {
  // 500 -> 400 -> 300 -> 1
  const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
  const parentOf = (p: number) => parents[p] ?? null;

  test("finds the pane process up the parent chain", () => {
    expect(isAncestor(300, 500, parentOf)).toBe(true);
    expect(isAncestor(500, 500, parentOf)).toBe(true);
  });

  test("rejects a pane process that is not an ancestor (stale TMUX_PANE)", () => {
    expect(isAncestor(999, 500, parentOf)).toBe(false);
    expect(isAncestor(1, 500, parentOf)).toBe(false); // init is everyone's ancestor, never proof
    expect(isAncestor(NaN, 500, parentOf)).toBe(false);
  });

  test("terminates on a cyclic parent chain", () => {
    expect(isAncestor(999, 10, (p) => (p === 10 ? 11 : 10))).toBe(false);
  });
});
