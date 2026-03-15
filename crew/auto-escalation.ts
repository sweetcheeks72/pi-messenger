/**
 * Auto-Escalation Pipeline
 *
 * Rule-based auto-escalation engine that watches AgentHealthBus snapshots
 * and fires escalation events when thresholds are breached. Integrates with
 * the Φ accrual failure detector for statistical heartbeat anomaly detection.
 *
 * Features:
 *   - Configurable rule set with severity levels and cooldown windows
 *   - Per-agent, per-rule cooldown tracking to prevent alert storms
 *   - Event-driven evaluation via HealthBus subscription
 *   - Polling mode via start()/stop() for periodic sweeps
 *   - evaluateNow() for on-demand escalation checks
 *
 * Part of TASK-10: Auto-Escalation Pipeline
 */

import {
  AgentHealthBus,
  AgentHealthSnapshot,
  type HealthState,
} from "../health-bus.js";
import { PhiAccrualDetector } from "../phi-detector.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Enriched snapshot passed to escalation rules.
 * Extends AgentHealthSnapshot with phi detector data and convenience aliases.
 */
export interface EscalationSnapshot extends AgentHealthSnapshot {
  /** Current Φ value from the accrual failure detector (0–16) */
  suspicionLevel: number;
  /** Alias for progress field (0-100 or undefined) */
  progressPct?: number;
  /** Cost estimate in USD (placeholder — not yet populated by health bus) */
  costEstimate?: number;
}

/**
 * A single escalation rule evaluated against each agent snapshot.
 */
export interface EscalationRule {
  name: string;
  condition: (snapshot: EscalationSnapshot) => boolean;
  severity: "warn" | "block" | "critical";
  message: (snapshot: EscalationSnapshot) => string;
  cooldownMs: number;
}

/**
 * A fired escalation event.
 */
export interface Escalation {
  rule: string;
  severity: "warn" | "block" | "critical";
  agentName: string;
  taskId?: string;
  message: string;
  timestamp: number;
}

export type EscalationListener = (escalation: Escalation) => void;

// =============================================================================
// Default Rules
// =============================================================================

export const DEFAULT_RULES: EscalationRule[] = [
  {
    name: "phi-degraded",
    condition: (s) => s.suspicionLevel >= 1 && s.suspicionLevel < 3,
    severity: "warn",
    message: (s) =>
      `Agent ${s.agentName} heartbeat irregular (Φ=${s.suspicionLevel.toFixed(1)})`,
    cooldownMs: 60_000,
  },
  {
    name: "phi-critical",
    condition: (s) => s.suspicionLevel >= 3,
    severity: "block",
    message: (s) =>
      `Agent ${s.agentName} likely stalled (Φ=${s.suspicionLevel.toFixed(1)})`,
    cooldownMs: 30_000,
  },
  {
    name: "cost-threshold",
    condition: (s) => (s.costEstimate ?? 0) > 5.0,
    severity: "warn",
    message: (s) =>
      `Agent ${s.agentName} cost $${s.costEstimate?.toFixed(2)} exceeds threshold`,
    cooldownMs: 300_000,
  },
  {
    name: "no-progress",
    condition: (s) =>
      s.healthState === "healthy" && (s.progressPct ?? 0) === 0,
    severity: "warn",
    message: (s) =>
      `Agent ${s.agentName} active but 0% progress`,
    cooldownMs: 120_000,
  },
];

// =============================================================================
// AutoEscalationPipeline
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class AutoEscalationPipeline {
  private readonly healthBus: AgentHealthBus;
  private readonly phiDetector: PhiAccrualDetector;
  private readonly rules: EscalationRule[];
  private readonly listeners = new Set<EscalationListener>();

  /**
   * Cooldown tracker: key = `${ruleName}::${agentName}`, value = last fire timestamp.
   */
  private readonly lastFired = new Map<string, number>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    healthBus: AgentHealthBus,
    phiDetector: PhiAccrualDetector,
    rules?: EscalationRule[],
  ) {
    this.healthBus = healthBus;
    this.phiDetector = phiDetector;
    this.rules = rules ?? DEFAULT_RULES;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start periodic polling for escalation evaluation.
   * Also subscribes to HealthBus heartbeat events for immediate checks.
   */
  start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.pollTimer) return; // Already running

    // Periodic sweep across all agents
    this.pollTimer = setInterval(() => {
      this.evaluateNow();
    }, pollIntervalMs);

    // Event-driven: evaluate on every heartbeat event
    this.unsubscribe = this.healthBus.subscribe((event) => {
      if (event.type === "heartbeat" || event.type === "stateChange") {
        this.evaluateAgent(event.agentName);
      }
    });
  }

  /**
   * Stop the polling loop and unsubscribe from HealthBus events.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate all tracked agents against all rules immediately.
   * Returns all escalations that fired (respecting cooldowns).
   */
  evaluateNow(now?: number): Escalation[] {
    const currentTime = now ?? Date.now();
    const escalations: Escalation[] = [];
    const snapshots = this.healthBus.getAllSnapshots();

    for (const [agentName, snapshot] of snapshots) {
      const enriched = this.enrichSnapshot(snapshot, agentName, currentTime);
      const agentEscalations = this.evaluateRules(enriched, currentTime);
      escalations.push(...agentEscalations);
    }

    return escalations;
  }

  /**
   * Evaluate a single agent against all rules.
   * Called on heartbeat events for immediate response.
   */
  evaluateAgent(agentName: string, now?: number): Escalation[] {
    const currentTime = now ?? Date.now();
    const snapshot = this.healthBus.getSnapshot(agentName);
    if (!snapshot) return [];

    const enriched = this.enrichSnapshot(snapshot, agentName, currentTime);
    return this.evaluateRules(enriched, currentTime);
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to escalation events. Returns an unsubscribe function.
   */
  onEscalation(listener: EscalationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Check whether the pipeline is currently polling. */
  get isRunning(): boolean {
    return this.pollTimer !== null;
  }

  /** Get the current cooldown state (for testing / debugging). */
  getCooldownState(): ReadonlyMap<string, number> {
    return this.lastFired;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Clear all cooldown state. Useful for testing. */
  resetCooldowns(): void {
    this.lastFired.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Enrich an AgentHealthSnapshot with phi detector data.
   */
  private enrichSnapshot(
    snapshot: AgentHealthSnapshot,
    agentName: string,
    now: number,
  ): EscalationSnapshot {
    const phi = this.phiDetector.phi(agentName, now);
    return {
      ...snapshot,
      suspicionLevel: phi,
      progressPct: snapshot.progress,
      costEstimate: undefined, // Placeholder — future cost bus integration
    };
  }

  /**
   * Evaluate all rules against an enriched snapshot.
   * Respects cooldowns and emits escalation events.
   */
  private evaluateRules(
    snapshot: EscalationSnapshot,
    now: number,
  ): Escalation[] {
    const escalations: Escalation[] = [];

    for (const rule of this.rules) {
      const cooldownKey = `${rule.name}::${snapshot.agentName}`;
      const lastFiredAt = this.lastFired.get(cooldownKey);

      // Check cooldown
      if (lastFiredAt !== undefined && now - lastFiredAt < rule.cooldownMs) {
        continue;
      }

      // Evaluate condition
      let matches = false;
      try {
        matches = rule.condition(snapshot);
      } catch {
        // Swallow rule evaluation errors — don't let one bad rule
        // break the entire pipeline
        continue;
      }

      if (!matches) continue;

      // Build message
      let message: string;
      try {
        message = rule.message(snapshot);
      } catch {
        message = `Rule ${rule.name} triggered for ${snapshot.agentName}`;
      }

      const escalation: Escalation = {
        rule: rule.name,
        severity: rule.severity,
        agentName: snapshot.agentName,
        taskId: snapshot.taskId,
        message,
        timestamp: now,
      };

      // Record cooldown
      this.lastFired.set(cooldownKey, now);

      // Emit to listeners
      for (const listener of this.listeners) {
        try {
          listener(escalation);
        } catch {
          // Swallow listener errors
        }
      }

      escalations.push(escalation);
    }

    return escalations;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let instance: AutoEscalationPipeline | undefined;

/**
 * Get the global AutoEscalationPipeline singleton.
 * Requires a healthBus and phiDetector for first-time creation.
 */
export function getAutoEscalationPipeline(
  healthBus: AgentHealthBus,
  phiDetector: PhiAccrualDetector,
  rules?: EscalationRule[],
): AutoEscalationPipeline {
  if (!instance) {
    instance = new AutoEscalationPipeline(healthBus, phiDetector, rules);
  }
  return instance;
}

/**
 * Reset the singleton. For testing only.
 * @internal
 */
export function resetAutoEscalationPipeline(): void {
  instance?.stop();
  instance = undefined;
}
