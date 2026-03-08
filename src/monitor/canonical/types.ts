/**
 * Canonical Session/Operator Monitor State Model — task-1
 *
 * Defines the canonical state vocabulary for the session monitor.
 * These types are the source of truth for section derivations, attention
 * views, and overall monitor health — consumed by any future UI layer.
 *
 * Design principles:
 *  - Schema-first: every enum is backed by a Zod schema for runtime validation
 *  - Backward compatible: does NOT modify legacy SessionStatus / HealthStatus
 *  - Input types describe what pi-messenger runtime data looks like before mapping
 *  - Output types (CanonicalSession, SessionSections, AttentionView) are pure
 *    data — no rendering dependencies
 */

import { z } from "zod";

// ─── Canonical lifecycle state ────────────────────────────────────────────────

/**
 * Canonical session lifecycle state.
 *
 * | State     | Description                                              |
 * |-----------|----------------------------------------------------------|
 * | queued    | Session created but not yet started (pending activation) |
 * | starting  | Session is initialising (spawning process, loading tools)|
 * | running   | Session is actively executing work                       |
 * | waiting   | Session is suspended, awaiting external input            |
 * | completed | Session finished normally                                |
 * | failed    | Session terminated due to an unrecoverable error         |
 * | canceled  | Session was deliberately stopped before completion       |
 */
export const CanonicalLifecycleStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
]);
export type CanonicalLifecycleState = z.infer<typeof CanonicalLifecycleStateSchema>;

// ─── Canonical health state ───────────────────────────────────────────────────

/**
 * Canonical health state for a session or operator.
 *
 * | State    | Description                                               |
 * |----------|-----------------------------------------------------------|
 * | active   | Operating normally with recent activity                   |
 * | idle     | Running but no recent work (normal for queued sessions)   |
 * | waiting  | Suspended and waiting for input (mirrors lifecycle)       |
 * | degraded | Showing signs of staleness — reduced throughput           |
 * | stuck    | No progress detected for an extended period               |
 * | offline  | Session has ended or is unreachable                       |
 */
export const CanonicalHealthStateSchema = z.enum([
  "active",
  "idle",
  "waiting",
  "degraded",
  "stuck",
  "offline",
]);
export type CanonicalHealthState = z.infer<typeof CanonicalHealthStateSchema>;

// ─── Canonical monitor/run state ──────────────────────────────────────────────

/**
 * Overall canonical monitor state across all sessions.
 *
 * | State           | Description                                         |
 * |-----------------|-----------------------------------------------------|
 * | healthy         | All sessions are running normally                   |
 * | attention_needed| One or more sessions are degraded (but not blocked) |
 * | blocked         | One or more sessions are stuck                      |
 * | recovering      | All work ended but some sessions failed             |
 * | completed       | All sessions finished without failures              |
 */
export const CanonicalMonitorStateSchema = z.enum([
  "healthy",
  "attention_needed",
  "blocked",
  "recovering",
  "completed",
]);
export type CanonicalMonitorState = z.infer<typeof CanonicalMonitorStateSchema>;

// ─── Input types for runtime mapping ─────────────────────────────────────────

/**
 * Minimal runtime session data needed for lifecycle mapping.
 *
 * Accepts the legacy `SessionStatus` values from pi-messenger
 * (`idle | active | paused | ended | error`) and optional timing/counters
 * that future mappings may use for richer derivation.
 */
export interface RuntimeSessionInput {
  /** Session identifier (matches SessionMetadata.id) */
  id: string;
  /**
   * Legacy status from pi-messenger `SessionStatus`.
   * Typed as string literal union to mirror SessionStatus without a hard
   * import cycle; mapSessionLifecycle validates exhaustively at the switch level.
   */
  status: "idle" | "active" | "paused" | "ended" | "error";
  /** Epoch ms when the session started (optional for queued sessions) */
  startedAt?: number;
  /** Epoch ms of last recorded activity (for staleness / stuck detection) */
  lastActivityAt?: number;
  /** Cumulative error count for richer failed/recovering distinction */
  errorCount?: number;
}

/**
 * Minimal runtime health data needed for health state mapping.
 *
 * Accepts the legacy `HealthStatus` values from the health monitor
 * (`healthy | degraded | critical`).
 */
export interface RuntimeHealthInput {
  /** Session identifier */
  sessionId: string;
  /**
   * Legacy health status from `SessionHealthMonitor`.
   * Typed as string literal union to mirror HealthStatus without a hard
   * import cycle.
   */
  health: "healthy" | "degraded" | "critical";
}

// ─── Canonical session record ─────────────────────────────────────────────────

/**
 * Fully normalized representation of a session with canonical states.
 *
 * Produced by the normalization pipeline; consumed by section and
 * attention derivations. Intentionally minimal — add fields only when
 * a derivation function demonstrably requires them.
 */
export interface CanonicalSession {
  /** Session identifier */
  id: string;
  /** Canonical lifecycle state */
  lifecycle: CanonicalLifecycleState;
  /** Canonical health state */
  health: CanonicalHealthState;
}

// ─── Section view ─────────────────────────────────────────────────────────────

/**
 * Grouped session sections for overview display.
 *
 * Derived deterministically from `CanonicalSession.lifecycle`.
 * Each array is a stable, ordered subset of the input list.
 */
export interface SessionSections {
  /** Sessions that are actively executing (lifecycle: running | starting) */
  running: CanonicalSession[];
  /** Sessions pending activation (lifecycle: queued) */
  queued: CanonicalSession[];
  /** Sessions that finished normally (lifecycle: completed | canceled) */
  completed: CanonicalSession[];
  /** Sessions that terminated with an error (lifecycle: failed) */
  failed: CanonicalSession[];
}

// ─── Attention view ───────────────────────────────────────────────────────────

/**
 * Filtered sessions needing operator attention.
 *
 * Derived deterministically from `CanonicalSession.health`.
 * `needingAttention` is the ordered union of `degraded` then `stuck`.
 */
export interface AttentionView {
  /** Sessions with degraded health (stale / reduced throughput) */
  degraded: CanonicalSession[];
  /** Sessions with stuck health (no progress detected) */
  stuck: CanonicalSession[];
  /** Union: all sessions with degraded or stuck health, degraded first */
  needingAttention: CanonicalSession[];
}
