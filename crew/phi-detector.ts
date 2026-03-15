/**
 * Φ Accrual Failure Detector
 *
 * Implementation of Hayashibara et al.'s φ accrual failure detector.
 * Maintains a sliding window of inter-heartbeat intervals per agent,
 * then uses the normal distribution CDF to estimate the probability
 * that the next heartbeat is "late".
 *
 * Φ = −log₁₀(P_later)
 *
 * where P_later = P(next interval > timeSinceLastHeartbeat)
 *              = 1 − CDF(timeSinceLastHeartbeat; μ, σ)
 *
 * Thresholds:
 *   Φ ≥ 1 → degraded  (P_later ≈ 10%)
 *   Φ ≥ 3 → critical  (P_later ≈ 0.1%)
 *   Φ ≥ 8 → failed    (P_later ≈ 10⁻⁸)
 */

// =============================================================================
// Types
// =============================================================================

export type HealthState = "healthy" | "degraded" | "critical" | "failed";

export interface PhiDetectorConfig {
  /** Maximum number of inter-heartbeat intervals to retain (default: 100) */
  windowSize?: number;
  /** Minimum intervals required before computing Φ (default: 3) */
  minSamples?: number;
}

export interface AgentPhi {
  agentId: string;
  phi: number;
  state: HealthState;
  lastHeartbeat: number;
  sampleCount: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Φ threshold for "degraded" health */
const PHI_DEGRADED = 1;
/** Φ threshold for "critical" health */
const PHI_CRITICAL = 3;
/** Φ threshold for "failed" health */
const PHI_FAILED = 8;

/**
 * Maximum Φ value returned (cap to avoid Infinity).
 * Follows Cassandra's convention of bounding the output.
 */
const PHI_MAX = 16;

const DEFAULT_WINDOW_SIZE = 100;
const DEFAULT_MIN_SAMPLES = 3;

// =============================================================================
// Internal State
// =============================================================================

interface AgentWindow {
  /** Sliding window of inter-heartbeat intervals (ms) */
  intervals: number[];
  /** Timestamp (ms) of last recorded heartbeat */
  lastHeartbeat: number;
}

// =============================================================================
// PhiAccrualDetector
// =============================================================================

export class PhiAccrualDetector {
  private readonly agents = new Map<string, AgentWindow>();
  private readonly windowSize: number;
  private readonly minSamples: number;

  constructor(config: PhiDetectorConfig = {}) {
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.minSamples = config.minSamples ?? DEFAULT_MIN_SAMPLES;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat Recording
  // ---------------------------------------------------------------------------

  /**
   * Record a heartbeat arrival for an agent.
   * The first heartbeat establishes a baseline; subsequent heartbeats
   * build the interval window.
   */
  recordHeartbeat(agentId: string, now?: number): void {
    const ts = now ?? Date.now();
    const state = this.agents.get(agentId);

    if (!state) {
      // First heartbeat — establish baseline
      this.agents.set(agentId, { intervals: [], lastHeartbeat: ts });
      return;
    }

    const interval = ts - state.lastHeartbeat;
    if (interval > 0) {
      state.intervals.push(interval);
      // Maintain sliding window size
      while (state.intervals.length > this.windowSize) {
        state.intervals.shift();
      }
    }
    state.lastHeartbeat = ts;
  }

  // ---------------------------------------------------------------------------
  // Φ Computation
  // ---------------------------------------------------------------------------

  /**
   * Compute the current Φ value for an agent.
   *
   * Returns 0 when:
   * - Agent is unknown
   * - Not enough samples collected yet (< minSamples)
   * - Time since last heartbeat is ≤ 0
   *
   * Returns PHI_MAX (16) when P_later is effectively 0.
   */
  phi(agentId: string, now?: number): number {
    const ts = now ?? Date.now();
    const state = this.agents.get(agentId);

    if (!state) return 0;

    const timeSinceLast = ts - state.lastHeartbeat;
    if (timeSinceLast <= 0) return 0;

    if (state.intervals.length < this.minSamples) {
      // Insufficient data for statistical estimation
      return 0;
    }

    const { mean, stddev } = computeStats(state.intervals);

    // Floor stddev at 10% of mean to avoid degenerate distributions
    // when heartbeats are extremely regular (near-zero variance)
    const adjustedStddev = Math.max(stddev, mean * 0.1);

    // P_later = P(X > timeSinceLast) where X ~ N(mean, adjustedStddev²)
    //         = 0.5 · erfc((timeSinceLast − mean) / (adjustedStddev · √2))
    const y = (timeSinceLast - mean) / (adjustedStddev * Math.SQRT2);
    const pLater = 0.5 * erfc(y);

    if (pLater <= 0) return PHI_MAX;
    return Math.min(-Math.log10(pLater), PHI_MAX);
  }

  // ---------------------------------------------------------------------------
  // Health State
  // ---------------------------------------------------------------------------

  /**
   * Map the current Φ value to a discrete health state.
   */
  healthState(agentId: string, now?: number): HealthState {
    return phiToState(this.phi(agentId, now));
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get full status for a single agent.
   */
  getAgentPhi(agentId: string, now?: number): AgentPhi | undefined {
    const state = this.agents.get(agentId);
    if (!state) return undefined;

    const p = this.phi(agentId, now);
    return {
      agentId,
      phi: p,
      state: phiToState(p),
      lastHeartbeat: state.lastHeartbeat,
      sampleCount: state.intervals.length,
    };
  }

  /**
   * Get full status for all tracked agents.
   */
  getAllAgentPhi(now?: number): AgentPhi[] {
    const result: AgentPhi[] = [];
    for (const agentId of this.agents.keys()) {
      const info = this.getAgentPhi(agentId, now);
      if (info) result.push(info);
    }
    return result;
  }

  /**
   * Check if an agent is being tracked.
   */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Remove an agent from tracking.
   */
  removeAgent(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  /**
   * List all tracked agent IDs.
   */
  getTrackedAgents(): string[] {
    return [...this.agents.keys()];
  }
}

// =============================================================================
// Statistics Helpers
// =============================================================================

function computeStats(intervals: number[]): { mean: number; stddev: number } {
  const n = intervals.length;
  const mean = intervals.reduce((a, b) => a + b, 0) / n;
  const variance = intervals.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Map a Φ value to a HealthState.
 */
function phiToState(phi: number): HealthState {
  if (phi >= PHI_FAILED) return "failed";
  if (phi >= PHI_CRITICAL) return "critical";
  if (phi >= PHI_DEGRADED) return "degraded";
  return "healthy";
}

// =============================================================================
// Complementary Error Function
// =============================================================================

/**
 * Complementary error function approximation.
 * Uses Abramowitz & Stegun formula 7.1.26 (rational approximation).
 * Accurate to ~1.5×10⁻⁷ — more than sufficient for failure detection.
 */
function erfc(x: number): number {
  // Clamp for numerical stability
  if (x < -6) return 2;
  if (x > 6) return 0;

  const neg = x < 0;
  const ax = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))));

  const result = poly * Math.exp(-ax * ax);
  return neg ? 2 - result : result;
}

// =============================================================================
// Exports (for testing / downstream consumers)
// =============================================================================

export { PHI_DEGRADED, PHI_CRITICAL, PHI_FAILED, PHI_MAX };
