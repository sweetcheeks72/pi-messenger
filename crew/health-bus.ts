/**
 * AgentHealthBus — Unified Health State
 *
 * Map-based AgentHealthSnapshot store with pub/sub pattern.
 * Provides a single source of truth for agent health across the system
 * (crew heartbeat, governance watchdog, session-mesh-bus).
 *
 * Methods: recordHeartbeat(), recordToolCall(), recordProgress(),
 *          getSnapshot(), getAllSnapshots(), subscribe()
 * Derived: getHealthState(), getStaleAgents(), getDegradedAgents()
 * Singleton: getHealthBus()
 */

// =============================================================================
// Types
// =============================================================================

export type HealthState = "healthy" | "degraded" | "critical" | "failed" | "unknown";

export interface AgentHealthSnapshot {
  agentName: string;
  taskId?: string;
  healthState: HealthState;
  lastHeartbeatAt: number;       // epoch ms
  lastToolCallAt?: number;       // epoch ms
  lastProgressAt?: number;       // epoch ms
  progress?: number;             // 0-100
  heartbeatCount: number;
  toolCallCount: number;
  createdAt: number;             // epoch ms
  updatedAt: number;             // epoch ms
}

export type HealthBusEventType = "heartbeat" | "toolCall" | "progress" | "stateChange";

export interface HealthBusEvent {
  type: HealthBusEventType;
  agentName: string;
  snapshot: AgentHealthSnapshot;
  previousState?: HealthState;   // only on stateChange
}

export type HealthBusListener = (event: HealthBusEvent) => void;

export interface HealthBusConfig {
  /** Time (ms) before an agent is considered degraded. Default: 60_000 (1 min) */
  degradedThresholdMs?: number;
  /** Time (ms) before an agent is considered failed/stale. Default: 120_000 (2 min) */
  staleThresholdMs?: number;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_DEGRADED_MS = 60_000;
const DEFAULT_STALE_MS = 120_000;

// =============================================================================
// AgentHealthBus Class
// =============================================================================

export class AgentHealthBus {
  private readonly snapshots = new Map<string, AgentHealthSnapshot>();
  private readonly listeners = new Set<HealthBusListener>();
  private readonly degradedThresholdMs: number;
  private readonly staleThresholdMs: number;

  constructor(config: HealthBusConfig = {}) {
    this.degradedThresholdMs = config.degradedThresholdMs ?? DEFAULT_DEGRADED_MS;
    this.staleThresholdMs = config.staleThresholdMs ?? DEFAULT_STALE_MS;
  }

  // ---------------------------------------------------------------------------
  // Recording Methods
  // ---------------------------------------------------------------------------

  /**
   * Record a heartbeat from an agent. Resets health to "healthy" and
   * increments heartbeat count.
   */
  recordHeartbeat(
    agentName: string,
    data?: { taskId?: string; progress?: number },
  ): void {
    const now = Date.now();
    const existing = this.snapshots.get(agentName);
    const prevState = existing ? this.computeHealthState(existing, now) : "unknown";

    const snapshot: AgentHealthSnapshot = {
      agentName,
      taskId: data?.taskId ?? existing?.taskId,
      healthState: "healthy",
      lastHeartbeatAt: now,
      lastToolCallAt: existing?.lastToolCallAt,
      lastProgressAt:
        data?.progress !== undefined ? now : existing?.lastProgressAt,
      progress: data?.progress ?? existing?.progress,
      heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
      toolCallCount: existing?.toolCallCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.snapshots.set(agentName, snapshot);
    this.emit({ type: "heartbeat", agentName, snapshot });

    if (prevState !== "healthy") {
      this.emit({
        type: "stateChange",
        agentName,
        snapshot,
        previousState: prevState,
      });
    }
  }

  /**
   * Record a tool call from an agent. Increments tool call count
   * but does NOT reset the heartbeat timer (only heartbeats reset health).
   */
  recordToolCall(
    agentName: string,
    data?: { taskId?: string },
  ): void {
    const now = Date.now();
    const existing = this.snapshots.get(agentName);
    const currentState = existing
      ? this.computeHealthState(existing, now)
      : "unknown";

    const snapshot: AgentHealthSnapshot = {
      agentName,
      taskId: data?.taskId ?? existing?.taskId,
      healthState: currentState,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? now,
      lastToolCallAt: now,
      lastProgressAt: existing?.lastProgressAt,
      progress: existing?.progress,
      heartbeatCount: existing?.heartbeatCount ?? 0,
      toolCallCount: (existing?.toolCallCount ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.snapshots.set(agentName, snapshot);
    this.emit({ type: "toolCall", agentName, snapshot });
  }

  /**
   * Record progress from an agent.
   * Updates the progress percentage but does NOT reset the heartbeat timer.
   */
  recordProgress(
    agentName: string,
    progress: number,
    data?: { taskId?: string },
  ): void {
    const now = Date.now();
    const existing = this.snapshots.get(agentName);
    const currentState = existing
      ? this.computeHealthState(existing, now)
      : "unknown";

    const snapshot: AgentHealthSnapshot = {
      agentName,
      taskId: data?.taskId ?? existing?.taskId,
      healthState: currentState,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? now,
      lastToolCallAt: existing?.lastToolCallAt,
      lastProgressAt: now,
      progress,
      heartbeatCount: existing?.heartbeatCount ?? 0,
      toolCallCount: existing?.toolCallCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.snapshots.set(agentName, snapshot);
    this.emit({ type: "progress", agentName, snapshot });
  }

  // ---------------------------------------------------------------------------
  // Snapshot Queries
  // ---------------------------------------------------------------------------

  /** Get the snapshot for a specific agent, or undefined if not tracked. */
  getSnapshot(agentName: string): AgentHealthSnapshot | undefined {
    const snap = this.snapshots.get(agentName);
    if (!snap) return undefined;
    // Return a copy with computed health state
    return { ...snap, healthState: this.computeHealthState(snap) };
  }

  /** Get all agent snapshots, keyed by agent name. */
  getAllSnapshots(): Map<string, AgentHealthSnapshot> {
    const result = new Map<string, AgentHealthSnapshot>();
    const now = Date.now();
    for (const [name, snap] of this.snapshots) {
      result.set(name, {
        ...snap,
        healthState: this.computeHealthState(snap, now),
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Pub/Sub
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to health bus events. Returns an unsubscribe function.
   */
  subscribe(listener: HealthBusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // Derived Queries
  // ---------------------------------------------------------------------------

  /**
   * Get the computed health state for an agent.
   * Factors in time elapsed since last heartbeat.
   */
  getHealthState(agentName: string, now?: number): HealthState {
    const snapshot = this.snapshots.get(agentName);
    if (!snapshot) return "unknown";
    return this.computeHealthState(snapshot, now);
  }

  /**
   * Get all agents whose last heartbeat exceeds the stale threshold.
   * These are agents that have gone silent.
   */
  getStaleAgents(now?: number): AgentHealthSnapshot[] {
    const currentTime = now ?? Date.now();
    return [...this.snapshots.values()]
      .filter((s) => {
        const elapsed = currentTime - s.lastHeartbeatAt;
        return elapsed > this.staleThresholdMs;
      })
      .map((s) => ({
        ...s,
        healthState: this.computeHealthState(s, currentTime),
      }));
  }

  /**
   * Get all agents in a degraded state (degraded, critical, or failed).
   * Useful for dashboards and escalation checks.
   */
  getDegradedAgents(now?: number): AgentHealthSnapshot[] {
    const currentTime = now ?? Date.now();
    return [...this.snapshots.values()]
      .filter((s) => {
        const state = this.computeHealthState(s, currentTime);
        return (
          state === "degraded" || state === "critical" || state === "failed"
        );
      })
      .map((s) => ({
        ...s,
        healthState: this.computeHealthState(s, currentTime),
      }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Remove an agent from tracking (e.g., when task completes). */
  removeAgent(agentName: string): boolean {
    return this.snapshots.delete(agentName);
  }

  /** Clear all state. Useful for testing. */
  reset(): void {
    this.snapshots.clear();
    this.listeners.clear();
  }

  /** Number of agents currently tracked. */
  get size(): number {
    return this.snapshots.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private computeHealthState(
    snapshot: AgentHealthSnapshot,
    now?: number,
  ): HealthState {
    const currentTime = now ?? Date.now();
    const elapsed = currentTime - snapshot.lastHeartbeatAt;

    if (elapsed > this.staleThresholdMs) return "failed";
    if (elapsed > this.degradedThresholdMs) return "degraded";
    return "healthy";
  }

  private emit(event: HealthBusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to prevent one bad subscriber
        // from breaking the health bus pipeline
      }
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let instance: AgentHealthBus | undefined;

/** Get the global AgentHealthBus singleton. */
export function getHealthBus(): AgentHealthBus {
  if (!instance) {
    instance = new AgentHealthBus();
  }
  return instance;
}

/**
 * Reset the singleton. For testing only.
 * @internal
 */
export function resetHealthBus(): void {
  instance?.reset();
  instance = undefined;
}
