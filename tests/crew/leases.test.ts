/**
 * Tests for crew/leases.ts — durable worker lease store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  getLeasesPath,
  readLeases,
  writeLease,
  deleteLease,
  isLeaseStale,
  isProcessAlive,
} from "../../crew/leases.js";
import type { WorkerLease } from "../../crew/types.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function makeLease(overrides: Partial<WorkerLease> = {}): WorkerLease {
  const now = new Date().toISOString();
  return {
    taskId: "task-1",
    workerId: "crew-worker-abc123",
    pid: null,
    assignedAt: now,
    spawnedAt: null,
    heartbeatAt: null,
    startedAt: null,
    status: "assigned",
    model: null,
    restartCount: 0,
    ...overrides,
  };
}

describe("crew/leases", () => {
  let cwd: string;

  beforeEach(() => {
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
  });

  // ──────────────────────────────────────────────────────────
  // getLeasesPath
  // ──────────────────────────────────────────────────────────
  describe("getLeasesPath", () => {
    it("returns path under .pi/messenger/crew/worker-leases.json", () => {
      const p = getLeasesPath(cwd);
      expect(p).toBe(path.join(cwd, ".pi", "messenger", "crew", "worker-leases.json"));
    });
  });

  // ──────────────────────────────────────────────────────────
  // readLeases
  // ──────────────────────────────────────────────────────────
  describe("readLeases", () => {
    it("returns empty array when lease file does not exist", () => {
      const leases = readLeases(cwd);
      expect(leases).toEqual([]);
    });

    it("returns leases from existing store", () => {
      const lease = makeLease();
      writeLease(cwd, lease);
      const leases = readLeases(cwd);
      expect(leases).toHaveLength(1);
      expect(leases[0]?.taskId).toBe("task-1");
    });

    it("returns empty array when file contains malformed JSON", () => {
      const leasesPath = getLeasesPath(cwd);
      fs.mkdirSync(path.dirname(leasesPath), { recursive: true });
      fs.writeFileSync(leasesPath, "not-json");
      const leases = readLeases(cwd);
      expect(leases).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────
  // writeLease
  // ──────────────────────────────────────────────────────────
  describe("writeLease", () => {
    it("creates lease file and persists a new lease", () => {
      const lease = makeLease();
      writeLease(cwd, lease);

      const leasesPath = getLeasesPath(cwd);
      expect(fs.existsSync(leasesPath)).toBe(true);

      const stored = readLeases(cwd);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        taskId: "task-1",
        workerId: "crew-worker-abc123",
        status: "assigned",
      });
    });

    it("updates an existing lease when taskId matches", () => {
      const lease = makeLease({ status: "assigned" });
      writeLease(cwd, lease);

      const updated = { ...lease, status: "active" as const, heartbeatAt: new Date().toISOString() };
      writeLease(cwd, updated);

      const stored = readLeases(cwd);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe("active");
      expect(stored[0]?.heartbeatAt).not.toBeNull();
    });

    it("stores multiple leases for different tasks", () => {
      writeLease(cwd, makeLease({ taskId: "task-1" }));
      writeLease(cwd, makeLease({ taskId: "task-2", workerId: "crew-worker-xyz" }));

      const stored = readLeases(cwd);
      expect(stored).toHaveLength(2);
      const ids = stored.map(l => l.taskId);
      expect(ids).toContain("task-1");
      expect(ids).toContain("task-2");
    });

    it("persists store version and updatedAt fields", () => {
      writeLease(cwd, makeLease());
      const raw = JSON.parse(fs.readFileSync(getLeasesPath(cwd), "utf-8"));
      expect(raw.version).toBe("1");
      expect(typeof raw.updatedAt).toBe("string");
      expect(Array.isArray(raw.leases)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────
  // deleteLease
  // ──────────────────────────────────────────────────────────
  describe("deleteLease", () => {
    it("removes the lease for the specified taskId", () => {
      writeLease(cwd, makeLease({ taskId: "task-1" }));
      writeLease(cwd, makeLease({ taskId: "task-2", workerId: "crew-worker-xyz" }));

      deleteLease(cwd, "task-1");

      const stored = readLeases(cwd);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.taskId).toBe("task-2");
    });

    it("is a no-op when taskId does not exist", () => {
      writeLease(cwd, makeLease({ taskId: "task-1" }));
      deleteLease(cwd, "task-99");
      expect(readLeases(cwd)).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────
  // isLeaseStale
  // ──────────────────────────────────────────────────────────
  describe("isLeaseStale", () => {
    it("returns true when lease has no heartbeatAt and no spawnedAt", () => {
      const lease = makeLease({ heartbeatAt: null, spawnedAt: null });
      expect(isLeaseStale(lease)).toBe(true);
    });

    it("returns true when heartbeatAt is older than 30 seconds", () => {
      const staleTime = new Date(Date.now() - 35_000).toISOString();
      const lease = makeLease({ heartbeatAt: staleTime });
      expect(isLeaseStale(lease)).toBe(true);
    });

    it("returns false when heartbeatAt is recent (within 30 s)", () => {
      const recentTime = new Date(Date.now() - 5_000).toISOString();
      const lease = makeLease({ heartbeatAt: recentTime });
      expect(isLeaseStale(lease)).toBe(false);
    });

    it("returns true when no heartbeatAt and spawnedAt is older than 30 s", () => {
      const staleTime = new Date(Date.now() - 35_000).toISOString();
      const lease = makeLease({ heartbeatAt: null, spawnedAt: staleTime });
      expect(isLeaseStale(lease)).toBe(true);
    });

    it("returns false when no heartbeatAt but spawnedAt is recent (within 30 s)", () => {
      const recentTime = new Date(Date.now() - 5_000).toISOString();
      const lease = makeLease({ heartbeatAt: null, spawnedAt: recentTime });
      expect(isLeaseStale(lease)).toBe(false);
    });

    it("heartbeatAt takes precedence over spawnedAt for staleness check", () => {
      // Recent heartbeat with stale spawn — not stale
      const staleSpawn = new Date(Date.now() - 60_000).toISOString();
      const recentHb = new Date(Date.now() - 5_000).toISOString();
      const lease = makeLease({ heartbeatAt: recentHb, spawnedAt: staleSpawn });
      expect(isLeaseStale(lease)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // isProcessAlive
  // ──────────────────────────────────────────────────────────
  describe("isProcessAlive", () => {
    it("returns false for null pid", () => {
      expect(isProcessAlive(null)).toBe(false);
    });

    it("returns true for the current process PID", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a non-existent PID", () => {
      // PID 2147483647 is INT_MAX and very unlikely to exist
      expect(isProcessAlive(2147483647)).toBe(false);
    });
  });
});
