import { describe, expect, test } from "vitest";
import {
  inferLifecyclePhase, formatLifecycleBadge, formatLifecycleBadgePlain,
  getPhaseEmphasis,
} from "../../crew/lifecycle-phase.js";

// Deploy: cp /tmp/agent-channel-staged/lifecycle-phase.test.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/tests/crew/lifecycle-phase.test.ts

describe("inferLifecyclePhase", () => {
  test("returns 'unknown' for empty task list", () => {
    expect(inferLifecyclePhase([])).toBe("unknown");
  });

  test("returns 'planning' when all tasks are todo", () => {
    expect(inferLifecyclePhase([
      { status: "todo" }, { status: "todo" }, { status: "blocked" },
    ])).toBe("planning");
  });

  test("returns 'executing' when tasks are in_progress", () => {
    expect(inferLifecyclePhase([
      { status: "todo" }, { status: "in_progress" }, { status: "done" },
    ])).toBe("executing");
  });

  test("returns 'reviewing' when any task is pending_review", () => {
    expect(inferLifecyclePhase([
      { status: "done" }, { status: "pending_review" }, { status: "done" },
    ])).toBe("reviewing");
  });

  test("returns 'done' when all tasks are done", () => {
    expect(inferLifecyclePhase([
      { status: "done" }, { status: "done" }, { status: "done" },
    ])).toBe("done");
  });

  test("returns 'executing' for mix of done + todo", () => {
    expect(inferLifecyclePhase([
      { status: "done" }, { status: "todo" },
    ])).toBe("executing");
  });
});

describe("formatLifecycleBadge", () => {
  test("contains phase name in uppercase", () => {
    const badge = formatLifecycleBadge("executing");
    expect(badge).toContain("[EXECUTING]");
  });

  test("contains ANSI color codes", () => {
    const badge = formatLifecycleBadge("executing");
    expect(badge).toContain("\x1b[");
  });

  test("works for all phases", () => {
    for (const phase of ["planning", "executing", "reviewing", "done", "unknown"] as const) {
      expect(formatLifecycleBadge(phase)).toContain(phase.toUpperCase());
    }
  });
});

describe("formatLifecycleBadgePlain", () => {
  test("returns plain text badge without ANSI", () => {
    const badge = formatLifecycleBadgePlain("planning");
    expect(badge).toBe("[PLANNING]");
    expect(badge).not.toContain("\x1b");
  });
});

describe("getPhaseEmphasis", () => {
  test("planning highlights plan panel", () => {
    const e = getPhaseEmphasis("planning");
    expect(e.highlightPlan).toBe(true);
    expect(e.highlightWorkers).toBe(false);
    expect(e.highlightReview).toBe(false);
  });

  test("executing highlights worker grid", () => {
    const e = getPhaseEmphasis("executing");
    expect(e.highlightPlan).toBe(false);
    expect(e.highlightWorkers).toBe(true);
    expect(e.highlightReview).toBe(false);
  });

  test("reviewing highlights review panel", () => {
    const e = getPhaseEmphasis("reviewing");
    expect(e.highlightPlan).toBe(false);
    expect(e.highlightWorkers).toBe(false);
    expect(e.highlightReview).toBe(true);
  });

  test("done highlights nothing", () => {
    const e = getPhaseEmphasis("done");
    expect(e.highlightPlan).toBe(false);
    expect(e.highlightWorkers).toBe(false);
    expect(e.highlightReview).toBe(false);
  });
});
