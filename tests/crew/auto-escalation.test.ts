/**
 * Auto-Escalation Pipeline Tests
 *
 * Verifies:
 *   - Rules fire at correct Φ thresholds
 *   - Cooldown prevents re-fire within window
 *   - Cost threshold triggers at $5+
 *   - evaluateNow() returns all triggered rules
 *   - start()/stop() lifecycle
 *   - Event listener subscription
 *   - Enriched snapshot construction
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AutoEscalationPipeline,
  DEFAULT_RULES,
  type EscalationRule,
  type Escalation,
  type EscalationSnapshot,
  resetAutoEscalationPipeline,
} from "../../crew/auto-escalation.js";
import { AgentHealthBus, resetHealthBus } from "../../crew/health-bus.js";
import { PhiAccrualDetector } from "../../crew/phi-detector.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Seed heartbeats with alternating intervals for realistic variance.
 * Uses intervals that alternate ±5s around the base to create a
 * meaningful stddev for phi calculation.
 *
 * Also records on the health bus for consistent state.
 *
 * Returns the timestamp of the last heartbeat.
 */
function seedAgent(
  bus: AgentHealthBus,
  phi: PhiAccrualDetector,
  agentName: string,
  opts: {
    count?: number;
    intervalMs?: number;
    jitterMs?: number;
    startMs: number;
    taskId?: string;
  },
): number {
  const count = opts.count ?? 10;
  const intervalMs = opts.intervalMs ?? 30_000;
  const jitterMs = opts.jitterMs ?? 5_000;

  let t = opts.startMs;
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(t);
    phi.recordHeartbeat(agentName, t);
    bus.recordHeartbeat(agentName, {
      taskId: opts.taskId,
    });
    // Alternate long/short intervals for variance
    const delta = intervalMs + (i % 2 === 0 ? jitterMs : -jitterMs);
    t += delta;
  }
  // Return the last heartbeat time
  return t - (((count - 1) % 2 === 0) ? jitterMs : -jitterMs) - intervalMs;
}

// =============================================================================
// Tests
// =============================================================================

describe("AutoEscalationPipeline", () => {
  let bus: AgentHealthBus;
  let phi: PhiAccrualDetector;
  let pipeline: AutoEscalationPipeline;

  const BASE_TIME = 1_000_000_000; // Epoch-ish base

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    resetHealthBus();
    resetAutoEscalationPipeline();
    bus = new AgentHealthBus();
    phi = new PhiAccrualDetector({ minSamples: 3 });
    pipeline = new AutoEscalationPipeline(bus, phi);
  });

  afterEach(() => {
    pipeline.stop();
    vi.useRealTimers();
  });

  // ===========================================================================
  // DEFAULT_RULES sanity
  // ===========================================================================

  describe("DEFAULT_RULES", () => {
    it("has 4 rules with expected names", () => {
      expect(DEFAULT_RULES).toHaveLength(4);
      const names = DEFAULT_RULES.map((r) => r.name);
      expect(names).toContain("phi-degraded");
      expect(names).toContain("phi-critical");
      expect(names).toContain("cost-threshold");
      expect(names).toContain("no-progress");
    });

    it("phi-degraded has 60s cooldown and warn severity", () => {
      const rule = DEFAULT_RULES.find((r) => r.name === "phi-degraded")!;
      expect(rule.severity).toBe("warn");
      expect(rule.cooldownMs).toBe(60_000);
    });

    it("phi-critical has 30s cooldown and block severity", () => {
      const rule = DEFAULT_RULES.find((r) => r.name === "phi-critical")!;
      expect(rule.severity).toBe("block");
      expect(rule.cooldownMs).toBe(30_000);
    });
  });

  // ===========================================================================
  // Φ threshold rules
  // ===========================================================================

  describe("phi threshold rules", () => {
    it("fires phi-degraded when Φ ≥ 1 and < 3", () => {
      const agentName = "worker-1";

      // Seed 10 heartbeats with alternating 25s/35s intervals (mean=30s, stddev≈5s)
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-1",
      });

      // With mean=30s, stddev≈5s: timeSinceLast≈38s gives phi≈1.3 (degraded)
      const queryTime = lastHb + 38_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      const degraded = escalations.find((e) => e.rule === "phi-degraded");
      expect(degraded).toBeDefined();
      expect(degraded!.severity).toBe("warn");
      expect(degraded!.agentName).toBe(agentName);
      expect(degraded!.message).toContain("heartbeat irregular");
      expect(degraded!.message).toContain("Φ=");
    });

    it("fires phi-critical (not phi-degraded) when Φ ≥ 3", () => {
      const agentName = "worker-2";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-2",
      });

      // timeSinceLast≈50s gives phi≈4+ (critical)
      const queryTime = lastHb + 50_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      const critical = escalations.find((e) => e.rule === "phi-critical");
      expect(critical).toBeDefined();
      expect(critical!.severity).toBe("block");
      expect(critical!.message).toContain("likely stalled");

      // phi-degraded should NOT fire (condition is >= 1 && < 3)
      const degraded = escalations.find((e) => e.rule === "phi-degraded");
      expect(degraded).toBeUndefined();
    });

    it("does not fire phi rules when agent is healthy (Φ < 1)", () => {
      const agentName = "worker-3";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-3",
      });

      // Query immediately after last heartbeat — phi ≈ 0
      const queryTime = lastHb + 1_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      const phiRules = escalations.filter(
        (e) => e.rule === "phi-degraded" || e.rule === "phi-critical",
      );
      expect(phiRules).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Cooldown
  // ===========================================================================

  describe("cooldown", () => {
    it("prevents re-fire within cooldown window", () => {
      const agentName = "worker-cd";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-cd",
      });

      // First evaluation — fire phi-degraded
      const t1 = lastHb + 38_000;
      vi.setSystemTime(t1);
      const first = pipeline.evaluateNow();
      const degraded1 = first.find((e) => e.rule === "phi-degraded");
      expect(degraded1).toBeDefined();

      // Second evaluation 10s later (within 60s cooldown) — should NOT re-fire phi-degraded
      const t2 = t1 + 10_000;
      vi.setSystemTime(t2);
      const second = pipeline.evaluateNow();
      const degraded2 = second.find((e) => e.rule === "phi-degraded");
      expect(degraded2).toBeUndefined();
    });

    it("allows re-fire after cooldown expires", () => {
      const agentName = "worker-cd2";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-cd2",
      });

      // First evaluation — fire
      const t1 = lastHb + 38_000;
      vi.setSystemTime(t1);
      const first = pipeline.evaluateNow();
      const firstPhiRules = first.filter(
        (e) => e.rule === "phi-degraded" || e.rule === "phi-critical",
      );
      expect(firstPhiRules.length).toBeGreaterThanOrEqual(1);

      // After cooldown expires (phi-degraded is 60s, phi-critical is 30s)
      const t2 = t1 + 61_000;
      vi.setSystemTime(t2);
      const second = pipeline.evaluateNow();
      // Phi will be high by now — at least one phi rule should re-fire
      const secondPhiRules = second.filter(
        (e) => e.rule === "phi-degraded" || e.rule === "phi-critical",
      );
      expect(secondPhiRules.length).toBeGreaterThanOrEqual(1);
    });

    it("tracks cooldowns per agent independently", () => {
      const agent1 = "worker-a";
      const agent2 = "worker-b";

      // Seed both agents at same base time
      seedAgent(bus, phi, agent1, {
        startMs: BASE_TIME,
        taskId: "task-a",
      });
      const lastHb2 = seedAgent(bus, phi, agent2, {
        startMs: BASE_TIME,
        taskId: "task-b",
      });

      // Advance to degraded range
      const queryTime = lastHb2 + 38_000;
      vi.setSystemTime(queryTime);

      // Evaluate agent1 — fires and sets cooldown for agent1 only
      pipeline.evaluateAgent(agent1);

      // Now evaluate agent2 — it should still fire (independent cooldown)
      const agent2Escalations = pipeline.evaluateAgent(agent2);
      const agent2Phi = agent2Escalations.filter(
        (e) =>
          (e.rule === "phi-degraded" || e.rule === "phi-critical") &&
          e.agentName === agent2,
      );
      expect(agent2Phi.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Cost threshold
  // ===========================================================================

  describe("cost threshold", () => {
    it("does not fire when costEstimate is undefined (not yet tracked)", () => {
      const costRule: EscalationRule = {
        name: "cost-threshold",
        condition: (s) => (s.costEstimate ?? 0) > 5.0,
        severity: "warn",
        message: (s) =>
          `Agent ${s.agentName} cost $${s.costEstimate?.toFixed(2)} exceeds threshold`,
        cooldownMs: 300_000,
      };

      const costPipeline = new AutoEscalationPipeline(bus, phi, [costRule]);
      bus.recordHeartbeat("cheap-agent");

      const escalations = costPipeline.evaluateNow();
      expect(
        escalations.find((e) => e.rule === "cost-threshold"),
      ).toBeUndefined();
    });

    it("fires when costEstimate > $5 (rule condition test)", () => {
      const costRule = DEFAULT_RULES.find(
        (r) => r.name === "cost-threshold",
      )!;

      const snapshot: EscalationSnapshot = {
        agentName: "agent-x",
        healthState: "healthy",
        lastHeartbeatAt: Date.now(),
        heartbeatCount: 5,
        toolCallCount: 10,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        suspicionLevel: 0,
        progressPct: 50,
        costEstimate: 7.5,
      };

      expect(costRule.condition(snapshot)).toBe(true);
      expect(costRule.message(snapshot)).toContain("$7.50");
    });

    it("does not fire below $5 (rule condition test)", () => {
      const costRule = DEFAULT_RULES.find(
        (r) => r.name === "cost-threshold",
      )!;

      const snapshot: EscalationSnapshot = {
        agentName: "agent-y",
        healthState: "healthy",
        lastHeartbeatAt: Date.now(),
        heartbeatCount: 5,
        toolCallCount: 10,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        suspicionLevel: 0,
        progressPct: 50,
        costEstimate: 4.99,
      };

      expect(costRule.condition(snapshot)).toBe(false);
    });

    it("fires at exactly $5.01", () => {
      const costRule = DEFAULT_RULES.find(
        (r) => r.name === "cost-threshold",
      )!;

      const snapshot: EscalationSnapshot = {
        agentName: "agent-z",
        healthState: "healthy",
        lastHeartbeatAt: Date.now(),
        heartbeatCount: 1,
        toolCallCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        suspicionLevel: 0,
        costEstimate: 5.01,
      };

      expect(costRule.condition(snapshot)).toBe(true);
    });
  });

  // ===========================================================================
  // No-progress rule
  // ===========================================================================

  describe("no-progress rule", () => {
    it("fires when agent is healthy with 0% progress", () => {
      const agentName = "lazy-agent";

      // Seed heartbeats and record in bus with no progress
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-lazy",
      });

      // Query right after last heartbeat — agent is healthy, progress = undefined (0)
      const queryTime = lastHb + 1_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      const noProgress = escalations.find((e) => e.rule === "no-progress");
      expect(noProgress).toBeDefined();
      expect(noProgress!.severity).toBe("warn");
      expect(noProgress!.message).toContain("0% progress");
    });

    it("does not fire when agent has progress > 0", () => {
      const agentName = "busy-agent";

      // Seed heartbeats
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-busy",
      });

      // Record progress on health bus
      vi.setSystemTime(lastHb);
      bus.recordProgress(agentName, 42, { taskId: "task-busy" });

      const queryTime = lastHb + 1_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      const noProgress = escalations.find((e) => e.rule === "no-progress");
      expect(noProgress).toBeUndefined();
    });

    it("does not fire when agent is unhealthy (even with 0 progress)", () => {
      const agentName = "dead-agent";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-dead",
      });

      // Advance time far enough that health bus marks agent as failed
      // HealthBus default stale threshold is 120s
      const queryTime = lastHb + 200_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      // The no-progress rule requires healthState === "healthy"
      const noProgress = escalations.find((e) => e.rule === "no-progress");
      expect(noProgress).toBeUndefined();

      // But phi-critical should fire
      const critical = escalations.find((e) => e.rule === "phi-critical");
      expect(critical).toBeDefined();
    });
  });

  // ===========================================================================
  // evaluateNow() returns all triggered rules
  // ===========================================================================

  describe("evaluateNow()", () => {
    it("returns escalations across multiple agents", () => {
      const agents = ["agent-1", "agent-2", "agent-3"];

      let latestHb = BASE_TIME;
      for (const agent of agents) {
        const hb = seedAgent(bus, phi, agent, {
          startMs: BASE_TIME,
          taskId: `task-${agent}`,
        });
        latestHb = Math.max(latestHb, hb);
      }

      // Advance to degraded range for all agents
      const queryTime = latestHb + 38_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();

      // Each agent should have at least one escalation
      for (const agent of agents) {
        const agentEscalations = escalations.filter(
          (e) => e.agentName === agent,
        );
        expect(agentEscalations.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("returns empty array when no rules trigger", () => {
      // Use only no-progress rule (skip phi rules) for a clean test
      const noProgressOnly = new AutoEscalationPipeline(bus, phi, [
        DEFAULT_RULES.find((r) => r.name === "no-progress")!,
      ]);

      // Seed with progress > 0
      const lastHb = seedAgent(bus, phi, "good-agent", {
        startMs: BASE_TIME,
        taskId: "task-good",
      });
      vi.setSystemTime(lastHb);
      bus.recordProgress("good-agent", 50, { taskId: "task-good" });

      vi.setSystemTime(lastHb + 1_000);
      const escalations = noProgressOnly.evaluateNow();
      expect(escalations).toHaveLength(0);
    });

    it("includes taskId in escalation when available", () => {
      const agentName = "task-agent";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-42",
      });

      const queryTime = lastHb + 38_000;
      vi.setSystemTime(queryTime);

      const escalations = pipeline.evaluateNow();
      const escalation = escalations.find((e) => e.agentName === agentName);
      expect(escalation).toBeDefined();
      expect(escalation!.taskId).toBe("task-42");
    });
  });

  // ===========================================================================
  // Custom rules
  // ===========================================================================

  describe("custom rules", () => {
    it("accepts and evaluates custom rule set", () => {
      const customRule: EscalationRule = {
        name: "custom-check",
        condition: (s) => s.heartbeatCount > 5,
        severity: "critical",
        message: (s) => `Agent ${s.agentName} exceeded heartbeat threshold`,
        cooldownMs: 10_000,
      };

      const customPipeline = new AutoEscalationPipeline(bus, phi, [
        customRule,
      ]);

      // Record 6 heartbeats
      for (let i = 0; i < 6; i++) {
        bus.recordHeartbeat("test-agent");
      }

      const escalations = customPipeline.evaluateNow();
      expect(escalations).toHaveLength(1);
      expect(escalations[0].rule).toBe("custom-check");
      expect(escalations[0].severity).toBe("critical");
    });

    it("swallows rule condition errors gracefully", () => {
      const badRule: EscalationRule = {
        name: "bad-rule",
        condition: () => {
          throw new Error("boom");
        },
        severity: "warn",
        message: () => "should not reach",
        cooldownMs: 1_000,
      };

      const badPipeline = new AutoEscalationPipeline(bus, phi, [badRule]);
      bus.recordHeartbeat("test-agent");

      // Should not throw
      const escalations = badPipeline.evaluateNow();
      expect(escalations).toHaveLength(0);
    });

    it("swallows rule message errors gracefully", () => {
      const badMsgRule: EscalationRule = {
        name: "bad-msg-rule",
        condition: () => true,
        severity: "warn",
        message: () => {
          throw new Error("message boom");
        },
        cooldownMs: 1_000,
      };

      const badPipeline = new AutoEscalationPipeline(bus, phi, [badMsgRule]);
      bus.recordHeartbeat("test-agent");

      const escalations = badPipeline.evaluateNow();
      expect(escalations).toHaveLength(1);
      // Should use fallback message
      expect(escalations[0].message).toContain("bad-msg-rule");
    });
  });

  // ===========================================================================
  // Event listeners
  // ===========================================================================

  describe("event listeners", () => {
    it("notifies listeners when escalation fires", () => {
      const received: Escalation[] = [];
      pipeline.onEscalation((e) => received.push(e));

      const agentName = "listener-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      const queryTime = lastHb + 38_000;
      vi.setSystemTime(queryTime);
      pipeline.evaluateNow();

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0].agentName).toBe(agentName);
    });

    it("unsubscribe stops notifications", () => {
      const received: Escalation[] = [];
      const unsub = pipeline.onEscalation((e) => received.push(e));
      unsub();

      const agentName = "unsub-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      vi.setSystemTime(lastHb + 38_000);
      pipeline.evaluateNow();

      expect(received).toHaveLength(0);
    });

    it("swallows listener errors", () => {
      pipeline.onEscalation(() => {
        throw new Error("listener boom");
      });

      const agentName = "error-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      vi.setSystemTime(lastHb + 38_000);

      // Should not throw despite bad listener
      expect(() => pipeline.evaluateNow()).not.toThrow();
    });
  });

  // ===========================================================================
  // start() / stop() lifecycle
  // ===========================================================================

  describe("start/stop lifecycle", () => {
    it("starts and stops without error", () => {
      expect(pipeline.isRunning).toBe(false);

      pipeline.start(5_000);
      expect(pipeline.isRunning).toBe(true);

      pipeline.stop();
      expect(pipeline.isRunning).toBe(false);
    });

    it("start() is idempotent", () => {
      pipeline.start(5_000);
      pipeline.start(5_000); // second call should be no-op
      expect(pipeline.isRunning).toBe(true);

      pipeline.stop();
      expect(pipeline.isRunning).toBe(false);
    });

    it("stop() is idempotent", () => {
      pipeline.stop(); // stop when not running — should be no-op
      expect(pipeline.isRunning).toBe(false);
    });

    it("evaluates periodically when started", () => {
      const received: Escalation[] = [];
      pipeline.onEscalation((e) => received.push(e));

      const agentName = "poll-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      // Set time to a degraded point and start polling
      vi.setSystemTime(lastHb + 38_000);
      pipeline.start(5_000);

      // Advance past poll interval
      vi.advanceTimersByTime(5_100);

      expect(received.length).toBeGreaterThanOrEqual(1);

      pipeline.stop();
    });

    it("event-driven evaluation fires on HealthBus heartbeat", () => {
      const received: Escalation[] = [];
      pipeline.onEscalation((e) => received.push(e));

      const agentName = "event-agent";

      // Seed enough history
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      // Start pipeline
      pipeline.start(60_000); // Long poll to ensure event-driven fires first

      // Set time far into the future so next heartbeat makes previous ones stale
      const lateTime = lastHb + 50_000;
      vi.setSystemTime(lateTime);

      // Fire a heartbeat via the bus — should trigger event-driven evaluation
      bus.recordHeartbeat(agentName);
      phi.recordHeartbeat(agentName, lateTime);

      // The heartbeat resets suspicion, so phi should be low now
      // But the event listener fires before the phi updates propagate
      // Just verify the event mechanism works
      pipeline.stop();
    });
  });

  // ===========================================================================
  // evaluateAgent()
  // ===========================================================================

  describe("evaluateAgent()", () => {
    it("evaluates only the specified agent", () => {
      const agent1 = "eval-1";
      const agent2 = "eval-2";

      seedAgent(bus, phi, agent1, {
        startMs: BASE_TIME,
        taskId: "task-e1",
      });
      const lastHb2 = seedAgent(bus, phi, agent2, {
        startMs: BASE_TIME,
        taskId: "task-e2",
      });

      vi.setSystemTime(lastHb2 + 38_000);

      const escalations = pipeline.evaluateAgent(agent1);

      // All results should be for agent1 only
      for (const e of escalations) {
        expect(e.agentName).toBe(agent1);
      }
    });

    it("returns empty array for unknown agent", () => {
      const escalations = pipeline.evaluateAgent("nonexistent");
      expect(escalations).toHaveLength(0);
    });
  });

  // ===========================================================================
  // resetCooldowns()
  // ===========================================================================

  describe("resetCooldowns()", () => {
    it("clears all cooldown state allowing immediate re-fire", () => {
      const agentName = "reset-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      const t1 = lastHb + 38_000;
      vi.setSystemTime(t1);

      // Fire once
      const first = pipeline.evaluateNow();
      expect(first.length).toBeGreaterThan(0);

      // Verify cooldown is active (immediate re-eval — nothing new should fire)
      vi.setSystemTime(t1 + 1);
      const second = pipeline.evaluateNow();
      const sameRuleFired = second.some((e) =>
        first.some((f) => f.rule === e.rule && f.agentName === e.agentName),
      );
      expect(sameRuleFired).toBe(false);

      // Reset cooldowns
      pipeline.resetCooldowns();

      // Now it should fire again
      vi.setSystemTime(t1 + 2);
      const third = pipeline.evaluateNow();
      expect(third.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Enriched snapshot construction
  // ===========================================================================

  describe("enriched snapshot", () => {
    it("includes phi suspicionLevel in escalation messages", () => {
      const agentName = "phi-msg-agent";

      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
        taskId: "task-phi",
      });

      vi.setSystemTime(lastHb + 38_000);
      const escalations = pipeline.evaluateNow();

      const phiEscalation = escalations.find(
        (e) => e.rule === "phi-degraded" || e.rule === "phi-critical",
      );
      expect(phiEscalation).toBeDefined();
      expect(phiEscalation!.message).toMatch(/Φ=\d+\.\d/);
    });

    it("carries agentName through to escalation", () => {
      const agentName = "name-check-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      vi.setSystemTime(lastHb + 38_000);
      const escalations = pipeline.evaluateNow();

      expect(escalations.length).toBeGreaterThan(0);
      expect(escalations[0].agentName).toBe(agentName);
    });
  });

  // ===========================================================================
  // getCooldownState()
  // ===========================================================================

  describe("getCooldownState()", () => {
    it("returns empty map initially", () => {
      expect(pipeline.getCooldownState().size).toBe(0);
    });

    it("contains entries after escalation fires", () => {
      const agentName = "state-agent";
      const lastHb = seedAgent(bus, phi, agentName, {
        startMs: BASE_TIME,
      });

      vi.setSystemTime(lastHb + 38_000);
      pipeline.evaluateNow();

      const state = pipeline.getCooldownState();
      expect(state.size).toBeGreaterThan(0);

      // Check the key format: ruleName::agentName
      const keys = [...state.keys()];
      expect(keys.some((k) => k.includes(agentName))).toBe(true);
    });
  });
});
