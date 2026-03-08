/**
 * Canonical state model tests — task-1
 *
 * Covers:
 *  1. Exact lifecycle mapping (SessionStatus → CanonicalLifecycleState)
 *  2. Exact health mapping (HealthStatus → CanonicalHealthState)
 *  3. Section derivation (Running / Queued / Completed / Failed)
 *  4. Attention derivation (degraded / stuck / needingAttention)
 */

import { describe, it, expect } from "vitest";
import {
  mapSessionLifecycle,
  mapHealthState,
  normalizeSession,
  normalizeSessions,
  deriveSections,
  deriveAttentionView,
  deriveMonitorState,
  type CanonicalSession,
  type RuntimeSessionInput,
  type RuntimeHealthInput,
} from "../../../src/monitor/canonical/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  id: string,
  lifecycle: CanonicalSession["lifecycle"],
  health: CanonicalSession["health"] = "active"
): CanonicalSession {
  return { id, lifecycle, health };
}

// ─── 1. Exact lifecycle mapping ───────────────────────────────────────────────

describe("mapSessionLifecycle — lifecycle mapping", () => {
  it('maps "idle" → "queued"', () => {
    expect(mapSessionLifecycle("idle")).toBe("queued");
  });

  it('maps "active" → "running"', () => {
    expect(mapSessionLifecycle("active")).toBe("running");
  });

  it('maps "paused" → "waiting"', () => {
    expect(mapSessionLifecycle("paused")).toBe("waiting");
  });

  it('maps "ended" → "completed"', () => {
    expect(mapSessionLifecycle("ended")).toBe("completed");
  });

  it('maps "error" → "failed"', () => {
    expect(mapSessionLifecycle("error")).toBe("failed");
  });
});

// ─── 2. Exact health mapping ──────────────────────────────────────────────────

describe("mapHealthState — health mapping", () => {
  it('maps "healthy" → "active"', () => {
    expect(mapHealthState("healthy")).toBe("active");
  });

  it('maps "degraded" → "degraded"', () => {
    expect(mapHealthState("degraded")).toBe("degraded");
  });

  it('maps "critical" → "stuck"', () => {
    expect(mapHealthState("critical")).toBe("stuck");
  });
});

// ─── normalization pipeline ───────────────────────────────────────────────────

describe("normalizeSession", () => {
  it("produces a CanonicalSession with lifecycle and health from inputs", () => {
    const session: RuntimeSessionInput = { id: "s1", status: "active" };
    const health: RuntimeHealthInput = { sessionId: "s1", health: "healthy" };
    const result = normalizeSession(session, health);

    expect(result).toEqual({ id: "s1", lifecycle: "running", health: "active" });
  });

  it("infers health from lifecycle when no health input provided", () => {
    const session: RuntimeSessionInput = { id: "s2", status: "idle" };
    const result = normalizeSession(session);

    expect(result.id).toBe("s2");
    expect(result.lifecycle).toBe("queued");
    // No health input → inferred from lifecycle (queued → idle)
    expect(result.health).toBe("idle");
  });

  it("maps paused session with degraded health correctly", () => {
    const session: RuntimeSessionInput = { id: "s3", status: "paused" };
    const health: RuntimeHealthInput = { sessionId: "s3", health: "degraded" };
    const result = normalizeSession(session, health);

    expect(result).toEqual({ id: "s3", lifecycle: "waiting", health: "degraded" });
  });
});

describe("normalizeSessions", () => {
  it("maps multiple sessions with a health map", () => {
    const sessions: RuntimeSessionInput[] = [
      { id: "a", status: "active" },
      { id: "b", status: "idle" },
      { id: "c", status: "error" },
    ];
    const healthMap = new Map<string, RuntimeHealthInput>([
      ["a", { sessionId: "a", health: "healthy" }],
      ["c", { sessionId: "c", health: "critical" }],
    ]);

    const results = normalizeSessions(sessions, healthMap);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: "a", lifecycle: "running", health: "active" });
    expect(results[1]).toEqual({ id: "b", lifecycle: "queued", health: "idle" });
    expect(results[2]).toEqual({ id: "c", lifecycle: "failed", health: "stuck" });
  });
});

// ─── 3. Section derivation ────────────────────────────────────────────────────

describe("deriveSections — section derivation", () => {
  it("groups sessions into Running/Queued/Completed/Failed", () => {
    const sessions: CanonicalSession[] = [
      makeSession("r1", "running"),
      makeSession("r2", "starting"),
      makeSession("q1", "queued"),
      makeSession("c1", "completed"),
      makeSession("c2", "canceled"),
      makeSession("f1", "failed"),
    ];

    const sections = deriveSections(sessions);

    expect(sections.running.map((s) => s.id)).toEqual(["r1", "r2"]);
    expect(sections.queued.map((s) => s.id)).toEqual(["q1"]);
    expect(sections.completed.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(sections.failed.map((s) => s.id)).toEqual(["f1"]);
  });

  it("returns empty arrays when no sessions match a section", () => {
    const sessions: CanonicalSession[] = [makeSession("r1", "running")];
    const sections = deriveSections(sessions);

    expect(sections.queued).toHaveLength(0);
    expect(sections.completed).toHaveLength(0);
    expect(sections.failed).toHaveLength(0);
  });

  it("handles empty input", () => {
    const sections = deriveSections([]);
    expect(sections.running).toHaveLength(0);
    expect(sections.queued).toHaveLength(0);
    expect(sections.completed).toHaveLength(0);
    expect(sections.failed).toHaveLength(0);
  });
});

// ─── 4. Attention derivation ──────────────────────────────────────────────────

describe("deriveAttentionView — attention derivation", () => {
  it("separates degraded and stuck sessions, unions into needingAttention", () => {
    const sessions: CanonicalSession[] = [
      makeSession("ok", "running", "active"),
      makeSession("d1", "running", "degraded"),
      makeSession("d2", "waiting", "degraded"),
      makeSession("s1", "running", "stuck"),
    ];

    const view = deriveAttentionView(sessions);

    expect(view.degraded.map((s) => s.id)).toEqual(["d1", "d2"]);
    expect(view.stuck.map((s) => s.id)).toEqual(["s1"]);
    // needingAttention = degraded then stuck
    expect(view.needingAttention.map((s) => s.id)).toEqual(["d1", "d2", "s1"]);
  });

  it("returns empty attention view when all sessions are healthy", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "queued", "idle"),
    ];

    const view = deriveAttentionView(sessions);

    expect(view.degraded).toHaveLength(0);
    expect(view.stuck).toHaveLength(0);
    expect(view.needingAttention).toHaveLength(0);
  });
});

// ─── Overall monitor state derivation ────────────────────────────────────────

describe("deriveMonitorState", () => {
  it("returns healthy when all sessions are running/active", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "queued", "idle"),
    ];
    expect(deriveMonitorState(sessions)).toBe("healthy");
  });

  it("returns blocked when any session is stuck", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "running", "stuck"),
    ];
    expect(deriveMonitorState(sessions)).toBe("blocked");
  });

  it("returns attention_needed when any session is degraded (no stuck)", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "running", "degraded"),
    ];
    expect(deriveMonitorState(sessions)).toBe("attention_needed");
  });

  it("returns completed when all sessions are terminal with no failures", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "completed", "offline"),
      makeSession("b", "canceled", "offline"),
    ];
    expect(deriveMonitorState(sessions)).toBe("completed");
  });

  it("returns recovering when all sessions are terminal but some failed", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "completed", "offline"),
      makeSession("b", "failed", "offline"),
    ];
    expect(deriveMonitorState(sessions)).toBe("recovering");
  });

  it("returns healthy for empty sessions list", () => {
    expect(deriveMonitorState([])).toBe("healthy");
  });
});

// ─── Zod schema validation ────────────────────────────────────────────────────

describe("CanonicalLifecycleStateSchema", () => {
  it("accepts all defined lifecycle states", async () => {
    const { CanonicalLifecycleStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["queued", "starting", "running", "waiting", "completed", "failed", "canceled"];
    for (const v of valid) {
      expect(CanonicalLifecycleStateSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown lifecycle states", async () => {
    const { CanonicalLifecycleStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );
    expect(() => CanonicalLifecycleStateSchema.parse("unknown")).toThrow();
  });
});

describe("CanonicalHealthStateSchema", () => {
  it("accepts all defined health states", async () => {
    const { CanonicalHealthStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["active", "idle", "waiting", "degraded", "stuck", "offline"];
    for (const v of valid) {
      expect(CanonicalHealthStateSchema.parse(v)).toBe(v);
    }
  });
});

describe("CanonicalMonitorStateSchema", () => {
  it("accepts all defined monitor states", async () => {
    const { CanonicalMonitorStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["healthy", "attention_needed", "blocked", "recovering", "completed"];
    for (const v of valid) {
      expect(CanonicalMonitorStateSchema.parse(v)).toBe(v);
    }
  });
});
