/**
 * Crew - Heartbeat Handler
 *
 * Workers call this periodically (every ~30 s) to signal they are still alive.
 * The first heartbeat transitions the task from "starting" -> "in_progress".
 * Subsequent heartbeats update the lease's heartbeatAt timestamp, preventing
 * the reconciler from marking the task as orphaned.
 *
 * Integration:
 *   - AgentHealthBus: records unified health snapshot per agent
 *   - PhiAccrualDetector: feeds inter-heartbeat intervals for statistical
 *     failure detection (Φ accrual)
 *   - LiveWorkerInfo: pushes computed healthState for overlay rendering
 */

import * as store from "../store.js";
import { readLeases, writeLease } from "../leases.js";
import { getHealthBus } from "../health-bus.js";
import { PhiAccrualDetector } from "../phi-detector.js";
import { patchLiveWorkerHealth } from "../live-progress.js";

export interface HeartbeatResult {
  ok: boolean;
  message: string;
}

// =============================================================================
// Φ Detector Singleton
// =============================================================================

let phiDetector: PhiAccrualDetector | undefined;

/** Get the global PhiAccrualDetector singleton. */
export function getPhiDetector(): PhiAccrualDetector {
  if (!phiDetector) {
    phiDetector = new PhiAccrualDetector();
  }
  return phiDetector;
}

/**
 * Reset the Φ detector singleton. For testing only.
 * @internal
 */
export function resetPhiDetector(): void {
  phiDetector = undefined;
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Record a worker heartbeat for a task.
 *
 * @param cwd       Project working directory.
 * @param taskId    The task ID being worked on (e.g. "task-3").
 * @param workerId  The worker unique identifier (e.g. "crew-worker-abc123").
 * @param namespace Optional namespace the task belongs to.
 */
export async function handleHeartbeat(
  cwd: string,
  taskId: string,
  workerId: string,
  namespace?: string,
): Promise<HeartbeatResult> {
  const task = store.getTask(cwd, taskId, namespace);
  if (!task) {
    return { ok: false, message: `Task not found: ${taskId}` };
  }

  const leases = readLeases(cwd);
  const lease = leases.find(l => l.taskId === taskId && l.workerId === workerId);
  if (!lease) {
    return {
      ok: false,
      message: `No lease found for task ${taskId} / worker ${workerId}`,
    };
  }

  const now = new Date().toISOString();
  const isFirstHeartbeat = lease.startedAt === null;

  // Update lease with new heartbeat timestamp
  writeLease(cwd, {
    ...lease,
    heartbeatAt: now,
    startedAt: isFirstHeartbeat ? now : lease.startedAt,
    status: "active",
  });

  // Transition task from "starting" -> "in_progress" on first heartbeat
  if (task.status === "starting" && isFirstHeartbeat) {
    store.updateTask(cwd, taskId, {
      status: "in_progress",
    });
  }

  // --- Integration: HealthBus + Φ Detector ---
  // Wrapped in try-catch to isolate health subsystem failures from
  // core heartbeat/lease functionality. The HeartbeatResult contract
  // promises to always resolve (ok/not-ok), never reject.
  try {
    const bus = getHealthBus();
    bus.recordHeartbeat(workerId, { taskId });

    const detector = getPhiDetector();
    detector.recordHeartbeat(workerId);

    // Push computed health state to LiveWorkerInfo for overlay rendering.
    // Uses the bus's time-based health computation (healthy/degraded/failed).
    const healthState = bus.getHealthState(workerId);
    patchLiveWorkerHealth(cwd, taskId, healthState);
  } catch {
    // Health subsystem error — swallow silently.
    // Core heartbeat (lease update, task transition) already succeeded above.
  }

  return {
    ok: true,
    message: `Heartbeat recorded for task ${taskId} (worker: ${workerId})`,
  };
}
