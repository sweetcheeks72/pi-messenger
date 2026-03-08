#!/usr/bin/env bash
# Creates src/monitor/canonical/{types,normalizer,index}.ts for task-1
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src/monitor/canonical"
mkdir -p "$DEST"

# ── types.ts ──────────────────────────────────────────────────────────────────
cat > "$DEST/types.ts" << 'ENDOFFILE'
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
ENDOFFILE

# ── normalizer.ts ─────────────────────────────────────────────────────────────
cat > "$DEST/normalizer.ts" << 'ENDOFFILE'
/**
 * Canonical State Normalizer — task-1
 *
 * Deterministic mapping utilities that translate legacy pi-messenger runtime
 * data into the canonical state model defined in `./types.ts`.
 *
 * All functions are pure (no side effects, no I/O). Each mapping is a direct
 * switch-based lookup so the compiler enforces exhaustiveness.
 *
 * Mapping tables (source of truth):
 *
 * SessionStatus → CanonicalLifecycleState:
 *   idle    → queued      (pending activation)
 *   active  → running     (actively executing)
 *   paused  → waiting     (suspended, awaiting human input)
 *   ended   → completed   (finished normally)
 *   error   → failed      (terminated by error)
 *
 * HealthStatus → CanonicalHealthState:
 *   healthy  → active     (operating normally)
 *   degraded → degraded   (stale / reduced throughput)
 *   critical → stuck      (no progress for extended period)
 */

import type {
  CanonicalLifecycleState,
  CanonicalHealthState,
  CanonicalMonitorState,
  CanonicalSession,
  RuntimeSessionInput,
  RuntimeHealthInput,
  SessionSections,
  AttentionView,
} from "./types.js";

// ─── Lifecycle mapping ────────────────────────────────────────────────────────

/**
 * Map a legacy `SessionStatus` value to a `CanonicalLifecycleState`.
 *
 * The mapping is intentionally explicit (switch, not a lookup table) so the
 * TypeScript compiler enforces exhaustiveness and catches new legacy values.
 */
export function mapSessionLifecycle(
  status: RuntimeSessionInput["status"]
): CanonicalLifecycleState {
  switch (status) {
    case "idle":
      return "queued";
    case "active":
      return "running";
    case "paused":
      return "waiting";
    case "ended":
      return "completed";
    case "error":
      return "failed";
    default: {
      // TypeScript exhaustiveness guard — never reached at runtime for valid inputs
      const _exhaustive: never = status;
      throw new Error(`Unknown SessionStatus: ${String(_exhaustive)}`);
    }
  }
}

// ─── Health mapping ───────────────────────────────────────────────────────────

/**
 * Map a legacy `HealthStatus` value to a `CanonicalHealthState`.
 *
 * The mapping is intentionally explicit (switch, not a lookup table) so the
 * TypeScript compiler enforces exhaustiveness.
 */
export function mapHealthState(
  health: RuntimeHealthInput["health"]
): CanonicalHealthState {
  switch (health) {
    case "healthy":
      return "active";
    case "degraded":
      return "degraded";
    case "critical":
      return "stuck";
    default: {
      const _exhaustive: never = health;
      throw new Error(`Unknown HealthStatus: ${String(_exhaustive)}`);
    }
  }
}

// ─── Health inference from lifecycle ─────────────────────────────────────────

/**
 * Infer a sensible default `CanonicalHealthState` from the lifecycle state
 * when no explicit health data is available.
 *
 * | Lifecycle           | Inferred health |
 * |---------------------|-----------------|
 * | queued / starting   | idle            |
 * | running             | active          |
 * | waiting             | waiting         |
 * | completed / canceled| offline         |
 * | failed              | offline         |
 */
function inferHealthFromLifecycle(lifecycle: CanonicalLifecycleState): CanonicalHealthState {
  switch (lifecycle) {
    case "queued":
    case "starting":
      return "idle";
    case "running":
      return "active";
    case "waiting":
      return "waiting";
    case "completed":
    case "canceled":
    case "failed":
      return "offline";
    default: {
      const _exhaustive: never = lifecycle;
      throw new Error(`Unknown CanonicalLifecycleState: ${String(_exhaustive)}`);
    }
  }
}

// ─── Normalization pipeline ───────────────────────────────────────────────────

/**
 * Normalize a single runtime session + optional health input into a
 * `CanonicalSession`.
 *
 * When `healthInput` is omitted, the health state is inferred from the
 * lifecycle state via `inferHealthFromLifecycle`.
 */
export function normalizeSession(
  session: RuntimeSessionInput,
  healthInput?: RuntimeHealthInput
): CanonicalSession {
  const lifecycle = mapSessionLifecycle(session.status);
  const health = healthInput
    ? mapHealthState(healthInput.health)
    : inferHealthFromLifecycle(lifecycle);
  return { id: session.id, lifecycle, health };
}

/**
 * Normalize an array of runtime sessions with an optional health map.
 *
 * @param sessions   - Array of runtime session inputs
 * @param healthMap  - Optional map of sessionId → RuntimeHealthInput
 */
export function normalizeSessions(
  sessions: RuntimeSessionInput[],
  healthMap?: Map<string, RuntimeHealthInput>
): CanonicalSession[] {
  return sessions.map((s) => normalizeSession(s, healthMap?.get(s.id)));
}

// ─── Section derivations ──────────────────────────────────────────────────────

/**
 * Derive Running / Queued / Completed / Failed sections from canonical sessions.
 *
 * Grouping rules:
 *  - running:   lifecycle === "running" | "starting"
 *  - queued:    lifecycle === "queued"
 *  - completed: lifecycle === "completed" | "canceled"
 *  - failed:    lifecycle === "failed"
 *
 * Sessions in the `waiting` state are not in any section — they appear in
 * the attention view instead.
 *
 * This function is pure and stable: input order is preserved within each group.
 */
export function deriveSections(sessions: CanonicalSession[]): SessionSections {
  return {
    running: sessions.filter(
      (s) => s.lifecycle === "running" || s.lifecycle === "starting"
    ),
    queued: sessions.filter((s) => s.lifecycle === "queued"),
    completed: sessions.filter(
      (s) => s.lifecycle === "completed" || s.lifecycle === "canceled"
    ),
    failed: sessions.filter((s) => s.lifecycle === "failed"),
  };
}

// ─── Attention derivations ────────────────────────────────────────────────────

/**
 * Derive attention / degraded / stuck views from canonical sessions.
 *
 * Grouping rules:
 *  - degraded:        health === "degraded"
 *  - stuck:           health === "stuck"
 *  - needingAttention: [...degraded, ...stuck] (degraded first, then stuck)
 *
 * This function is pure and stable: input order is preserved within each group.
 */
export function deriveAttentionView(sessions: CanonicalSession[]): AttentionView {
  const degraded = sessions.filter((s) => s.health === "degraded");
  const stuck = sessions.filter((s) => s.health === "stuck");
  return {
    degraded,
    stuck,
    needingAttention: [...degraded, ...stuck],
  };
}

// ─── Overall monitor state derivation ────────────────────────────────────────

/**
 * Derive the overall `CanonicalMonitorState` from a set of canonical sessions.
 *
 * Priority (highest wins):
 *  1. blocked          — any session health === "stuck"
 *  2. attention_needed — any session health === "degraded" (no stuck)
 *  3. recovering       — all sessions terminal but some failed
 *  4. completed        — all sessions terminal, none failed
 *  5. healthy          — default (no special conditions)
 *
 * Empty sessions list returns "healthy".
 */
export function deriveMonitorState(sessions: CanonicalSession[]): CanonicalMonitorState {
  if (sessions.length === 0) return "healthy";

  if (sessions.some((s) => s.health === "stuck")) return "blocked";
  if (sessions.some((s) => s.health === "degraded")) return "attention_needed";

  const allTerminal = sessions.every(
    (s) =>
      s.lifecycle === "completed" ||
      s.lifecycle === "canceled" ||
      s.lifecycle === "failed"
  );

  if (allTerminal) {
    return sessions.some((s) => s.lifecycle === "failed") ? "recovering" : "completed";
  }

  return "healthy";
}
ENDOFFILE

# ── index.ts ──────────────────────────────────────────────────────────────────
cat > "$DEST/index.ts" << 'ENDOFFILE'
/**
 * Canonical State Model — public barrel export
 *
 * Re-exports all types, schemas, and normalization utilities from the
 * canonical state model. Import from this module, not from sub-files.
 *
 * @example
 * ```typescript
 * import { mapSessionLifecycle, deriveSections } from "./src/monitor/canonical/index.js";
 * ```
 */
export * from "./types.js";
export * from "./normalizer.js";
ENDOFFILE

echo "✅ Created $DEST/types.ts, normalizer.ts, index.ts"
