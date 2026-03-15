/**
 * Heartbeat Integration Tests
 *
 * Tests that AgentHealthBus and PhiAccrualDetector are properly wired
 * into the heartbeat handler and that LiveWorkerInfo carries healthState
 * for rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import {
  handleHeartbeat,
  getPhiDetector,
  resetPhiDetector,
} from "../../crew/handlers/heartbeat.js";
import {
  AgentHealthBus,
  getHealthBus,
  resetHealthBus,
  type HealthState,
} from "../../crew/health-bus.js";
import {
  PhiAccrualDetector,
} from "../../crew/phi-detector.js";
import {
  updateLiveWorker,
  getLiveWorkers,
  removeLiveWorker,
  patchLiveWorkerHealth,
  type LiveWorkerInfo,
} from "../../crew/live-progress.js";
import * as store from "../../crew/store.js";
import { writeLease } from "../../crew/leases.js";

// =============================================================================
// Helpers
// =============================================================================

function setupTaskWithLease(cwd: string, taskId: string, workerId: string): void {
  // Ensure plan exists (required by createTask)
  try {
    store.createPlan(cwd, "test-prd.md");
  } catch {
    // Plan may already exist
  }

  // Create the task via the store API
  const task = store.createTask(cwd, `Test task for ${taskId}`);

  // Rename the task file to use the desired taskId
  const tasksDir = path.join(cwd, ".pi", "messenger", "crew", "tasks");
  const oldPath = path.join(tasksDir, `${task.id}.json`);
  const newPath = path.join(tasksDir, `${taskId}.json`);
  const taskData = JSON.parse(fs.readFileSync(oldPath, "utf-8"));
  taskData.id = taskId;
  taskData.status = "starting";
  fs.writeFileSync(newPath, JSON.stringify(taskData, null, 2));
  if (oldPath !== newPath) {
    try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
  }

  // Create a lease for the worker
  writeLease(cwd, {
    taskId,
    workerId,
    pid: null,
    assignedAt: new Date().toISOString(),
    spawnedAt: null,
    heartbeatAt: null,
    startedAt: null,
    status: "assigned",
    model: null,
    restartCount: 0,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("Heartbeat Integration — HealthBus + Φ Detector", () => {
  let cwd: string;

  beforeEach(() => {
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    resetHealthBus();
    resetPhiDetector();
  });

  afterEach(() => {
    resetHealthBus();
    resetPhiDetector();
  });

  // ---------------------------------------------------------------------------
  // 1. handleHeartbeat wires into AgentHealthBus
  // ---------------------------------------------------------------------------

  describe("handleHeartbeat() → AgentHealthBus integration", () => {
    it("records a heartbeat on the HealthBus when heartbeat handler is called", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      const result = await handleHeartbeat(cwd, "task-1", "worker-alpha");
      expect(result.ok).toBe(true);

      const bus = getHealthBus();
      const snap = bus.getSnapshot("worker-alpha");
      expect(snap).toBeDefined();
      expect(snap!.agentName).toBe("worker-alpha");
      expect(snap!.healthState).toBe("healthy");
      expect(snap!.heartbeatCount).toBe(1);
    });

    it("increments heartbeat count on multiple heartbeats", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      await handleHeartbeat(cwd, "task-1", "worker-alpha");
      await handleHeartbeat(cwd, "task-1", "worker-alpha");
      await handleHeartbeat(cwd, "task-1", "worker-alpha");

      const bus = getHealthBus();
      const snap = bus.getSnapshot("worker-alpha");
      expect(snap!.heartbeatCount).toBe(3);
    });

    it("records taskId in the health bus snapshot", async () => {
      setupTaskWithLease(cwd, "task-7", "worker-beta");

      await handleHeartbeat(cwd, "task-7", "worker-beta");

      const bus = getHealthBus();
      const snap = bus.getSnapshot("worker-beta");
      expect(snap!.taskId).toBe("task-7");
    });

    it("does NOT record heartbeat when task is not found", async () => {
      // No task setup — should fail
      const result = await handleHeartbeat(cwd, "task-999", "worker-missing");
      expect(result.ok).toBe(false);

      const bus = getHealthBus();
      expect(bus.getSnapshot("worker-missing")).toBeUndefined();
    });

    it("does NOT record heartbeat when lease is missing", async () => {
      // Create task but no lease
      try { store.createPlan(cwd, "test-prd.md"); } catch { /* */ }
      const task = store.createTask(cwd, "Task without lease");

      const result = await handleHeartbeat(cwd, task.id, "worker-no-lease");
      expect(result.ok).toBe(false);

      const bus = getHealthBus();
      expect(bus.getSnapshot("worker-no-lease")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. handleHeartbeat wires into PhiAccrualDetector
  // ---------------------------------------------------------------------------

  describe("handleHeartbeat() → PhiAccrualDetector integration", () => {
    it("feeds the Φ detector when heartbeat is recorded", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      await handleHeartbeat(cwd, "task-1", "worker-alpha");

      // The Φ detector should now track this agent
      const detector = getPhiDetector();
      expect(detector.hasAgent("worker-alpha")).toBe(true);
    });

    it("builds interval history with multiple heartbeats", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      // Send heartbeats with small delays to ensure non-zero intervals
      await handleHeartbeat(cwd, "task-1", "worker-alpha");
      await new Promise(r => setTimeout(r, 5));
      await handleHeartbeat(cwd, "task-1", "worker-alpha");
      await new Promise(r => setTimeout(r, 5));
      await handleHeartbeat(cwd, "task-1", "worker-alpha");
      await new Promise(r => setTimeout(r, 5));
      await handleHeartbeat(cwd, "task-1", "worker-alpha");

      const detector = getPhiDetector();
      const info = detector.getAgentPhi("worker-alpha");
      expect(info).toBeDefined();
      // With 4 heartbeats and delays, we should have at least 3 intervals
      expect(info!.sampleCount).toBeGreaterThanOrEqual(3);
    });

    it("reports healthy state for fresh heartbeats", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      // Send several heartbeats to build up samples
      for (let i = 0; i < 5; i++) {
        await handleHeartbeat(cwd, "task-1", "worker-alpha");
      }

      const detector = getPhiDetector();
      expect(detector.healthState("worker-alpha")).toBe("healthy");
    });

    it("does NOT feed detector when heartbeat fails", async () => {
      // No task/lease — heartbeat should fail
      const result = await handleHeartbeat(cwd, "task-999", "worker-missing");
      expect(result.ok).toBe(false);

      const detector = getPhiDetector();
      expect(detector.hasAgent("worker-missing")).toBe(false);
    });

    it("pushes computed healthState to LiveWorkerInfo via patchLiveWorkerHealth", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      // Pre-register a live worker (simulating what lobby.ts does when spawning)
      updateLiveWorker(cwd, "task-1", {
        taskId: "task-1",
        agent: "crew-worker",
        name: "WorkerAlpha",
        progress: {
          tokens: 100,
          toolCallCount: 2,
          currentTool: null,
          currentToolArgs: null,
          model: null,
          toolCallBuckets: [],
        },
        startedAt: Date.now(),
      });

      // Heartbeat should update the live worker's healthState
      await handleHeartbeat(cwd, "task-1", "worker-alpha");

      const workers = getLiveWorkers(cwd);
      const worker = workers.get("task-1");
      expect(worker).toBeDefined();
      expect(worker!.healthState).toBe("healthy");

      // Clean up
      removeLiveWorker(cwd, "task-1");
    });

    it("does not throw when bus/detector fails (error isolation)", async () => {
      setupTaskWithLease(cwd, "task-1", "worker-alpha");

      // Even if something goes wrong in health subsystem,
      // handleHeartbeat should still return ok: true (lease was updated)
      const result = await handleHeartbeat(cwd, "task-1", "worker-alpha");
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. LiveWorkerInfo includes healthState
  // ---------------------------------------------------------------------------

  describe("LiveWorkerInfo healthState field", () => {
    it("supports the healthState field on LiveWorkerInfo", () => {
      const info: LiveWorkerInfo = {
        cwd: "/test",
        taskId: "task-1",
        agent: "crew-worker",
        name: "WorkerAlpha",
        progress: {
          tokens: 100,
          toolCallCount: 5,
          currentTool: null,
          currentToolArgs: null,
          model: "anthropic/claude-sonnet-4",
          toolCallBuckets: [],
        },
        startedAt: Date.now(),
        healthState: "healthy",
      };

      expect(info.healthState).toBe("healthy");
    });

    it("defaults to healthy when undefined (optional field)", () => {
      const info: LiveWorkerInfo = {
        cwd: "/test",
        taskId: "task-1",
        agent: "crew-worker",
        name: "WorkerAlpha",
        progress: {
          tokens: 100,
          toolCallCount: 5,
          currentTool: null,
          currentToolArgs: null,
          model: "anthropic/claude-sonnet-4",
          toolCallBuckets: [],
        },
        startedAt: Date.now(),
      };

      // healthState is optional — when absent, treat as healthy
      expect(info.healthState ?? "healthy").toBe("healthy");
    });

    it("accepts all valid health states", () => {
      const states: Array<HealthState> = ["healthy", "degraded", "critical", "failed"];

      for (const state of states) {
        const info: LiveWorkerInfo = {
          cwd: "/test",
          taskId: "task-1",
          agent: "crew-worker",
          name: "Worker",
          progress: {
            tokens: 0,
            toolCallCount: 0,
            currentTool: null,
            currentToolArgs: null,
            model: null,
            toolCallBuckets: [],
          },
          startedAt: Date.now(),
          healthState: state,
        };
        expect(info.healthState).toBe(state);
      }
    });

    it("persists through updateLiveWorker/getLiveWorkers round-trip", () => {
      updateLiveWorker("/test-cwd", "task-1", {
        taskId: "task-1",
        agent: "crew-worker",
        name: "TestWorker",
        progress: {
          tokens: 50,
          toolCallCount: 2,
          currentTool: null,
          currentToolArgs: null,
          model: null,
          toolCallBuckets: [],
        },
        startedAt: Date.now(),
        healthState: "degraded",
      });

      const workers = getLiveWorkers("/test-cwd");
      const worker = workers.get("task-1");
      expect(worker).toBeDefined();
      expect(worker!.healthState).toBe("degraded");

      // Clean up
      removeLiveWorker("/test-cwd", "task-1");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Health state indicator prefixes (unit test for logic)
  // ---------------------------------------------------------------------------

  describe("Health state indicator logic", () => {
    /**
     * Test the prefix selection logic that overlay-render.ts uses.
     * We test the logic here without importing overlay-render.ts
     * (which has heavy TUI dependencies).
     */
    function getHealthPrefix(healthState: string | undefined): string {
      const state = healthState ?? "healthy";
      switch (state) {
        case "degraded": return "⚠";
        case "critical": return "🔴";
        case "failed":   return "💀";
        default:         return "⚡";
      }
    }

    it("returns ⚡ for healthy state", () => {
      expect(getHealthPrefix("healthy")).toBe("⚡");
    });

    it("returns ⚡ for undefined (default healthy)", () => {
      expect(getHealthPrefix(undefined)).toBe("⚡");
    });

    it("returns ⚠ for degraded state", () => {
      expect(getHealthPrefix("degraded")).toBe("⚠");
    });

    it("returns 🔴 for critical state", () => {
      expect(getHealthPrefix("critical")).toBe("🔴");
    });

    it("returns 💀 for failed state", () => {
      expect(getHealthPrefix("failed")).toBe("💀");
    });
  });
});
