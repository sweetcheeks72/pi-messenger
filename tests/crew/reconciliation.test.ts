/**
 * Tests for crew/reconcile.ts — orphan reconciliation primitives
 */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { reconcileOrphanedTasks } from "../../crew/reconcile.js";
import { writeLease } from "../../crew/leases.js";
import * as store from "../../crew/store.js";
import type { WorkerLease } from "../../crew/types.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function makeLease(taskId: string, overrides: Partial<WorkerLease> = {}): WorkerLease {
  const now = new Date().toISOString();
  return {
    taskId,
    workerId: `crew-worker-${taskId}`,
    pid: null,
    assignedAt: now,
    spawnedAt: now,
    heartbeatAt: now,
    startedAt: now,
    status: "active",
    model: null,
    restartCount: 0,
    ...overrides,
  };
}

function staleLease(taskId: string, overrides: Partial<WorkerLease> = {}): WorkerLease {
  const stale = new Date(Date.now() - 60_000).toISOString();
  return makeLease(taskId, {
    heartbeatAt: stale,
    spawnedAt: stale,
    ...overrides,
  });
}

describe("crew/reconcile", () => {
  let cwd: string;

  beforeEach(() => {
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
  });

  // ──────────────────────────────────────────────────────────
  // reconcileOrphanedTasks
  // ──────────────────────────────────────────────────────────
  describe("reconcileOrphanedTasks", () => {
    it("returns empty arrays when no tasks exist", async () => {
      const result = await reconcileOrphanedTasks(cwd);
      expect(result.reset).toEqual([]);
      expect(result.skipped).toEqual([]);
    });

    it("resets in_progress task that has no lease", async () => {
      const task = store.createTask(cwd, "Task without lease");
      store.updateTask(cwd, task.id, { status: "in_progress" });

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(task.id);
      expect(result.skipped).not.toContain(task.id);

      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("todo");
    });

    it("resets starting task that has no lease", async () => {
      const task = store.createTask(cwd, "Starting task without lease");
      store.updateTask(cwd, task.id, { status: "starting" });

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(task.id);
      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("todo");
    });

    it("resets assigned task that has no lease", async () => {
      const task = store.createTask(cwd, "Assigned task without lease");
      store.updateTask(cwd, task.id, { status: "assigned" });

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(task.id);
      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("todo");
    });

    it("resets in_progress task with stale heartbeat lease", async () => {
      const task = store.createTask(cwd, "Stale heartbeat task");
      store.updateTask(cwd, task.id, { status: "in_progress" });
      writeLease(cwd, staleLease(task.id));

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(task.id);
      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("todo");
    });

    it("skips in_progress task with healthy (recent) lease and alive pid", async () => {
      const task = store.createTask(cwd, "Healthy task");
      store.updateTask(cwd, task.id, { status: "in_progress" });
      writeLease(cwd, makeLease(task.id, { pid: process.pid }));

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.skipped).toContain(task.id);
      expect(result.reset).not.toContain(task.id);

      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("in_progress");
    });

    it("resets task with lease whose pid is dead", async () => {
      const task = store.createTask(cwd, "Dead process task");
      store.updateTask(cwd, task.id, { status: "in_progress" });
      // PID 2147483647 is INT_MAX and extremely unlikely to exist
      writeLease(cwd, makeLease(task.id, { pid: 2147483647 }));

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(task.id);
      const updated = store.getTask(cwd, task.id);
      expect(updated?.status).toBe("todo");
    });

    it("removes stale leases from the lease store when resetting tasks", async () => {
      const task = store.createTask(cwd, "Stale lease cleanup test");
      store.updateTask(cwd, task.id, { status: "in_progress" });
      writeLease(cwd, staleLease(task.id));

      await reconcileOrphanedTasks(cwd);

      const { readLeases } = await import("../../crew/leases.js");
      const remaining = readLeases(cwd);
      expect(remaining.find(l => l.taskId === task.id)).toBeUndefined();
    });

    it("does not reset todo or done tasks", async () => {
      const todoTask = store.createTask(cwd, "Todo task");
      const doneTask = store.createTask(cwd, "Done task");
      store.updateTask(cwd, doneTask.id, {
        status: "done",
        completed_at: new Date().toISOString(),
      });

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).not.toContain(todoTask.id);
      expect(result.reset).not.toContain(doneTask.id);
    });

    it("handles multiple orphaned tasks in one pass", async () => {
      const t1 = store.createTask(cwd, "Orphan 1");
      const t2 = store.createTask(cwd, "Orphan 2");
      const t3 = store.createTask(cwd, "Healthy");

      store.updateTask(cwd, t1.id, { status: "in_progress" });
      store.updateTask(cwd, t2.id, { status: "starting" });
      store.updateTask(cwd, t3.id, { status: "in_progress" });

      // Only t3 has a healthy lease
      writeLease(cwd, makeLease(t3.id, { pid: process.pid }));

      const result = await reconcileOrphanedTasks(cwd);

      expect(result.reset).toContain(t1.id);
      expect(result.reset).toContain(t2.id);
      expect(result.skipped).toContain(t3.id);

      expect(store.getTask(cwd, t1.id)?.status).toBe("todo");
      expect(store.getTask(cwd, t2.id)?.status).toBe("todo");
      expect(store.getTask(cwd, t3.id)?.status).toBe("in_progress");
    });

    it("scopes reconciliation to a namespace when provided", async () => {
      const t1 = store.createTask(cwd, "Orphan in ns", undefined, [], "alpha");
      const t2 = store.createTask(cwd, "Orphan in shared", undefined, [], "shared");

      store.updateTask(cwd, t1.id, { status: "in_progress" });
      store.updateTask(cwd, t2.id, { status: "in_progress" });

      // Only reconcile "alpha" namespace
      const result = await reconcileOrphanedTasks(cwd, "alpha");

      // t1 should be reset (in alpha)
      expect(result.reset).toContain(t1.id);
      // t2 (in shared) should not appear in this run
      expect(result.reset).not.toContain(t2.id);
      expect(result.skipped).not.toContain(t2.id);
    });
  });
});
