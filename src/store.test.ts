import { describe, expect, test } from "bun:test";
import { isCleanable } from "./store.ts";
import { newJob, type Job, type JobState } from "./types.ts";

function job(state: JobState, finishedAt: number | null = null, createdAt = 0): Job {
  return { ...newJob({ repo: "/r", prompt: "p" }), state, finishedAt, createdAt };
}

describe("isCleanable", () => {
  const now = Date.now();

  test("terminal states are cleanable with no cutoff", () => {
    for (const s of ["done", "failed", "cancelled"] as JobState[]) expect(isCleanable(job(s), null)).toBe(true);
  });

  test("active states are never cleanable", () => {
    for (const s of ["queued", "running", "paused_limit", "needs_user"] as JobState[]) {
      expect(isCleanable(job(s), null)).toBe(false);
      expect(isCleanable(job(s, now - 10 * 86_400_000), now)).toBe(false); // even if old
    }
  });

  test("cutoff keeps recently-finished terminal jobs", () => {
    const cutoff = now - 3 * 86_400_000; // 3 days ago
    expect(isCleanable(job("done", now - 5 * 86_400_000), cutoff)).toBe(true); // finished 5d ago → drop
    expect(isCleanable(job("done", now - 1 * 86_400_000), cutoff)).toBe(false); // finished 1d ago → keep
  });

  test("falls back to createdAt when finishedAt is null", () => {
    const cutoff = now - 3 * 86_400_000;
    expect(isCleanable(job("cancelled", null, now - 5 * 86_400_000), cutoff)).toBe(true);
    expect(isCleanable(job("cancelled", null, now - 1 * 86_400_000), cutoff)).toBe(false);
  });
});
