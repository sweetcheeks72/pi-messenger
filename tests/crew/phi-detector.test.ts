import { describe, expect, it, beforeEach } from "vitest";
import {
  PhiAccrualDetector,
  PHI_DEGRADED,
  PHI_CRITICAL,
  PHI_FAILED,
  PHI_MAX,
  type HealthState,
} from "../../crew/phi-detector.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Simulate regular heartbeats at a fixed interval.
 * Returns the timestamp of the LAST heartbeat recorded.
 */
function simulateRegularHeartbeats(
  detector: PhiAccrualDetector,
  agentId: string,
  count: number,
  intervalMs: number,
  startTime = 0,
): number {
  let t = startTime;
  for (let i = 0; i < count; i++) {
    detector.recordHeartbeat(agentId, t);
    t += intervalMs;
  }
  // Return time of the last heartbeat, not the next expected time
  return t - intervalMs;
}

/**
 * Simulate heartbeats with natural jitter around a mean interval.
 * Returns the timestamp of the LAST heartbeat recorded.
 */
function simulateJitteryHeartbeats(
  detector: PhiAccrualDetector,
  agentId: string,
  intervals: number[],
  startTime = 0,
): number {
  let t = startTime;
  detector.recordHeartbeat(agentId, t);
  for (const interval of intervals) {
    t += interval;
    detector.recordHeartbeat(agentId, t);
  }
  return t;
}

// =============================================================================
// Tests
// =============================================================================

describe("PhiAccrualDetector", () => {
  let detector: PhiAccrualDetector;

  beforeEach(() => {
    detector = new PhiAccrualDetector({ windowSize: 100, minSamples: 3 });
  });

  // ---------------------------------------------------------------------------
  // Construction & Configuration
  // ---------------------------------------------------------------------------

  describe("construction", () => {
    it("creates with default config", () => {
      const d = new PhiAccrualDetector();
      expect(d).toBeInstanceOf(PhiAccrualDetector);
    });

    it("accepts custom windowSize and minSamples", () => {
      const d = new PhiAccrualDetector({ windowSize: 10, minSamples: 5 });
      expect(d).toBeInstanceOf(PhiAccrualDetector);
    });
  });

  // ---------------------------------------------------------------------------
  // Heartbeat Recording
  // ---------------------------------------------------------------------------

  describe("recordHeartbeat", () => {
    it("tracks an agent after first heartbeat", () => {
      detector.recordHeartbeat("agent-1", 1000);
      expect(detector.hasAgent("agent-1")).toBe(true);
      expect(detector.getTrackedAgents()).toEqual(["agent-1"]);
    });

    it("tracks multiple agents independently", () => {
      detector.recordHeartbeat("agent-1", 1000);
      detector.recordHeartbeat("agent-2", 2000);
      expect(detector.getTrackedAgents()).toContain("agent-1");
      expect(detector.getTrackedAgents()).toContain("agent-2");
    });

    it("builds interval window from successive heartbeats", () => {
      // 5 heartbeats at 1000ms intervals = 4 intervals recorded
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 5, 1000, 0);
      const info = detector.getAgentPhi("agent-1", lastTime);
      expect(info).toBeDefined();
      expect(info!.sampleCount).toBe(4);
    });

    it("respects windowSize limit", () => {
      const small = new PhiAccrualDetector({ windowSize: 5, minSamples: 3 });
      // 10 heartbeats = 9 intervals, but window capped at 5
      const lastTime = simulateRegularHeartbeats(small, "agent-1", 10, 1000, 0);
      const info = small.getAgentPhi("agent-1", lastTime);
      expect(info).toBeDefined();
      expect(info!.sampleCount).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Φ Computation
  // ---------------------------------------------------------------------------

  describe("phi", () => {
    it("returns 0 for unknown agent", () => {
      expect(detector.phi("unknown")).toBe(0);
    });

    it("returns 0 with insufficient samples", () => {
      // Only 1 heartbeat = 0 intervals
      detector.recordHeartbeat("agent-1", 0);
      expect(detector.phi("agent-1", 5000)).toBe(0);

      // 2 heartbeats = 1 interval (still < minSamples=3)
      detector.recordHeartbeat("agent-1", 1000);
      expect(detector.phi("agent-1", 5000)).toBe(0);
    });

    it("returns 0 when checked at or before last heartbeat", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 5, 1000, 0);
      // Check at exactly the last heartbeat time
      expect(detector.phi("agent-1", lastTime)).toBe(0);
      // Check before the last heartbeat
      expect(detector.phi("agent-1", lastTime - 500)).toBe(0);
    });

    it("keeps Φ < 1 for regular heartbeats checked shortly after", () => {
      // Build a baseline of 1000ms intervals (last heartbeat at t=9000)
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);

      // Check 200ms after last heartbeat — well within expected interval
      const phi = detector.phi("agent-1", lastTime + 200);
      expect(phi).toBeLessThan(PHI_DEGRADED);
    });

    it("raises Φ > 3 for significantly missed heartbeats", () => {
      // Build a baseline of 1000ms intervals (last heartbeat at t=9000)
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);

      // Check 5000ms after last heartbeat — 5x the expected interval
      const phi = detector.phi("agent-1", lastTime + 5000);
      expect(phi).toBeGreaterThan(PHI_CRITICAL);
    });

    it("raises Φ > 8 for heavily missed heartbeats", () => {
      // Build a baseline of 1000ms intervals (last heartbeat at t=9000)
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);

      // Check 10000ms after last heartbeat — 10x the expected interval
      const phi = detector.phi("agent-1", lastTime + 10000);
      expect(phi).toBeGreaterThan(PHI_FAILED);
    });

    it("increases monotonically as time since last heartbeat grows", () => {
      // Use jittery intervals so the distribution has natural width
      const lastTime = simulateJitteryHeartbeats(
        detector,
        "agent-1",
        [900, 1100, 950, 1050, 980, 1020, 1000, 1100, 900, 1050, 950],
        0,
      );

      // Pick 4 progressively later check times — all within the finite range
      const phi1 = detector.phi("agent-1", lastTime + 500);
      const phi2 = detector.phi("agent-1", lastTime + 900);
      const phi3 = detector.phi("agent-1", lastTime + 1050);
      const phi4 = detector.phi("agent-1", lastTime + 1150);

      expect(phi2).toBeGreaterThan(phi1);
      expect(phi3).toBeGreaterThan(phi2);
      expect(phi4).toBeGreaterThan(phi3);
    });

    it("is capped at PHI_MAX for extreme delays", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);
      const phi = detector.phi("agent-1", lastTime + 1_000_000);
      expect(phi).toBe(PHI_MAX);
      expect(Number.isFinite(phi)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Health State Mapping
  // ---------------------------------------------------------------------------

  describe("healthState", () => {
    it("returns 'healthy' for unknown agent", () => {
      expect(detector.healthState("unknown")).toBe("healthy");
    });

    it("returns 'healthy' for regular heartbeats checked shortly after", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);
      // 200ms after last heartbeat — well within expectations
      expect(detector.healthState("agent-1", lastTime + 200)).toBe("healthy");
    });

    it("returns degraded or worse at moderate delay", () => {
      // Use jittery intervals for a realistic distribution
      const lastTime = simulateJitteryHeartbeats(
        detector,
        "agent-1",
        [900, 1100, 950, 1050, 980, 1020, 1000, 1100, 900],
        0,
      );
      // ~1.2x expected interval past last heartbeat
      const state = detector.healthState("agent-1", lastTime + 1200);
      expect(state).not.toBe("healthy");
    });

    it("returns 'critical' or 'failed' at significant delay", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);
      // 5x expected interval
      const state = detector.healthState("agent-1", lastTime + 5000);
      expect(["critical", "failed"]).toContain(state);
    });

    it("returns 'failed' at extreme delay", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);
      // 10x expected interval — clearly failed
      expect(detector.healthState("agent-1", lastTime + 10000)).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Different Agent Rhythms (Adaptive Baseline)
  // ---------------------------------------------------------------------------

  describe("adaptive baseline", () => {
    it("produces different Φ for same delay with different rhythms", () => {
      // Agent A: fast heartbeat (100ms intervals)
      const fastDetector = new PhiAccrualDetector({ minSamples: 3 });
      const lastFast = simulateRegularHeartbeats(fastDetector, "fast", 10, 100, 0);

      // Agent B: slow heartbeat (5000ms intervals)
      const slowDetector = new PhiAccrualDetector({ minSamples: 3 });
      const lastSlow = simulateRegularHeartbeats(slowDetector, "slow", 10, 5000, 0);

      // Same absolute delay of 500ms after last heartbeat
      const phiFast = fastDetector.phi("fast", lastFast + 500);
      const phiSlow = slowDetector.phi("slow", lastSlow + 500);

      // 500ms delay is catastrophic for 100ms rhythm but routine for 5000ms rhythm
      expect(phiFast).toBeGreaterThan(PHI_CRITICAL);
      expect(phiSlow).toBeLessThan(PHI_DEGRADED);
    });

    it("adapts when heartbeat rhythm changes", () => {
      // Use a small window so old intervals are pushed out
      const d = new PhiAccrualDetector({ windowSize: 20, minSamples: 3 });

      // Start with 1000ms rhythm
      const t1 = simulateRegularHeartbeats(d, "agent-1", 10, 1000, 0);

      // Switch to 2000ms rhythm — enough heartbeats to fill the window
      const t2 = simulateRegularHeartbeats(d, "agent-1", 25, 2000, t1 + 2000);

      // After adaptation to 2000ms rhythm, 2500ms since last heartbeat should be moderate
      const phi = d.phi("agent-1", t2 + 2500);
      expect(phi).toBeLessThan(PHI_CRITICAL);
      expect(phi).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Agent Management
  // ---------------------------------------------------------------------------

  describe("agent management", () => {
    it("removeAgent stops tracking", () => {
      detector.recordHeartbeat("agent-1", 1000);
      expect(detector.hasAgent("agent-1")).toBe(true);
      detector.removeAgent("agent-1");
      expect(detector.hasAgent("agent-1")).toBe(false);
      expect(detector.phi("agent-1")).toBe(0);
    });

    it("removeAgent returns false for unknown agent", () => {
      expect(detector.removeAgent("ghost")).toBe(false);
    });

    it("getTrackedAgents returns empty initially", () => {
      expect(detector.getTrackedAgents()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getAgentPhi / getAllAgentPhi
  // ---------------------------------------------------------------------------

  describe("getAgentPhi", () => {
    it("returns undefined for unknown agent", () => {
      expect(detector.getAgentPhi("unknown")).toBeUndefined();
    });

    it("returns full status for tracked agent", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 5, 1000, 0);
      const info = detector.getAgentPhi("agent-1", lastTime + 500);
      expect(info).toBeDefined();
      expect(info!.agentId).toBe("agent-1");
      expect(info!.sampleCount).toBe(4);
      expect(info!.lastHeartbeat).toBe(lastTime);
      expect(typeof info!.phi).toBe("number");
      expect(["healthy", "degraded", "critical", "failed"]).toContain(info!.state);
    });
  });

  describe("getAllAgentPhi", () => {
    it("returns empty array when no agents tracked", () => {
      expect(detector.getAllAgentPhi()).toEqual([]);
    });

    it("returns status for all tracked agents", () => {
      simulateRegularHeartbeats(detector, "agent-1", 5, 1000, 0);
      simulateRegularHeartbeats(detector, "agent-2", 5, 2000, 0);
      const all = detector.getAllAgentPhi(5000);
      expect(all).toHaveLength(2);
      expect(all.map((a) => a.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles extremely regular intervals (zero variance)", () => {
      // All intervals exactly 1000ms → stddev floored at 10% of mean
      const lastTime = simulateRegularHeartbeats(detector, "exact", 10, 1000, 0);
      // Check 1.2x the interval after last heartbeat
      const phi = detector.phi("exact", lastTime + 1200);
      expect(Number.isFinite(phi)).toBe(true);
      expect(phi).toBeGreaterThan(0);
    });

    it("handles very short intervals", () => {
      // 10ms rhythm
      const lastTime = simulateRegularHeartbeats(detector, "fast", 10, 10, 0);
      // Check 12ms after last heartbeat (1.2x interval)
      const phi = detector.phi("fast", lastTime + 12);
      expect(Number.isFinite(phi)).toBe(true);
      expect(phi).toBeGreaterThan(0);
    });

    it("handles very long intervals", () => {
      // 60s rhythm
      const lastTime = simulateRegularHeartbeats(detector, "slow", 10, 60000, 0);
      // Check 90s after last heartbeat (1.5x interval)
      const phi = detector.phi("slow", lastTime + 90000);
      expect(Number.isFinite(phi)).toBe(true);
      expect(phi).toBeGreaterThan(PHI_CRITICAL);
    });

    it("caps Φ at PHI_MAX for extremely large delays", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);
      // 1 hour after last heartbeat on a 1s rhythm
      const phi = detector.phi("agent-1", lastTime + 3_600_000);
      expect(phi).toBe(PHI_MAX);
      expect(Number.isFinite(phi)).toBe(true);
    });

    it("Φ drops after a new heartbeat arrives (recovery)", () => {
      const lastTime = simulateRegularHeartbeats(detector, "agent-1", 10, 1000, 0);

      // Φ is high after delay
      const phiHigh = detector.phi("agent-1", lastTime + 5000);
      expect(phiHigh).toBeGreaterThan(PHI_CRITICAL);

      // Agent recovers — new heartbeat arrives
      detector.recordHeartbeat("agent-1", lastTime + 5000);

      // Φ drops immediately after recovery (200ms after recovery heartbeat)
      const phiAfter = detector.phi("agent-1", lastTime + 5200);
      expect(phiAfter).toBeLessThan(phiHigh);
    });
  });
});
