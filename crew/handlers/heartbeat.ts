/**
 * Crew - Heartbeat Handler
 *
 * Workers call this periodically (every ~30 s) to signal they are still alive.
 * The first heartbeat transitions the task from "starting" -> "in_progress".
 * Subsequent heartbeats update the lease's heartbeatAt timestamp, preventing
 * the reconciler from marking the task as orphaned.
 */

import * as store from "../store.js";
import { readLeases, writeLease } from "../leases.js";

export interface HeartbeatResult {
  ok: boolean;
  message: string;
}

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

  return {
    ok: true,
    message: `Heartbeat recorded for task ${taskId} (worker: ${workerId})`,
  };
}
