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
