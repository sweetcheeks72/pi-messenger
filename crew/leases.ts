/**
 * Crew - Durable Worker Lease Store
 *
 * Provides read/write/delete operations for worker-leases.json,
 * plus staleness and liveness primitives for the reconciler.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerLease, WorkerLeaseStore } from "./types.js";

const LEASES_FILENAME = "worker-leases.json";

/** Timeout after which a lease is considered stale (no heartbeat). */
export const HEARTBEAT_TIMEOUT_MS = 30_000;

// =============================================================================
// Path Helpers
// =============================================================================

export function getLeasesPath(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "crew", LEASES_FILENAME);
}

// =============================================================================
// Read
// =============================================================================

export function readLeases(cwd: string): WorkerLease[] {
  const leasesPath = getLeasesPath(cwd);
  if (!fs.existsSync(leasesPath)) return [];
  try {
    const raw = fs.readFileSync(leasesPath, "utf-8");
    const store: WorkerLeaseStore = JSON.parse(raw);
    return Array.isArray(store.leases) ? store.leases : [];
  } catch {
    return [];
  }
}

// =============================================================================
// Write
// =============================================================================

export function writeLease(cwd: string, lease: WorkerLease): void {
  const leasesPath = getLeasesPath(cwd);
  const existing = readLeases(cwd);
  const idx = existing.findIndex(l => l.taskId === lease.taskId);
  if (idx >= 0) {
    existing[idx] = lease;
  } else {
    existing.push(lease);
  }

  const store: WorkerLeaseStore = {
    version: "1",
    updatedAt: new Date().toISOString(),
    leases: existing,
  };

  fs.mkdirSync(path.dirname(leasesPath), { recursive: true });
  const tmp = `${leasesPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, leasesPath);
}

// =============================================================================
// Delete
// =============================================================================

export function deleteLease(cwd: string, taskId: string): void {
  const leasesPath = getLeasesPath(cwd);
  const existing = readLeases(cwd);
  const filtered = existing.filter(l => l.taskId !== taskId);

  const store: WorkerLeaseStore = {
    version: "1",
    updatedAt: new Date().toISOString(),
    leases: filtered,
  };

  if (fs.existsSync(leasesPath)) {
    const tmp = `${leasesPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, leasesPath);
  }
}

// =============================================================================
// Staleness Check
// =============================================================================

/**
 * Returns true if the lease has not received a heartbeat within HEARTBEAT_TIMEOUT_MS.
 *
 * Decision order:
 *   1. If heartbeatAt is set, compare it against now.
 *   2. Else if spawnedAt is set, compare it against now (process may never have started).
 *   3. Else (no timestamps at all) → always stale.
 */
export function isLeaseStale(lease: WorkerLease): boolean {
  const now = Date.now();
  if (lease.heartbeatAt) {
    return now - new Date(lease.heartbeatAt).getTime() > HEARTBEAT_TIMEOUT_MS;
  }
  if (lease.spawnedAt) {
    return now - new Date(lease.spawnedAt).getTime() > HEARTBEAT_TIMEOUT_MS;
  }
  // No timestamps at all — treat as stale
  return true;
}

// =============================================================================
// Process Liveness
// =============================================================================

/**
 * Returns true if the OS process with the given PID is currently alive.
 * Uses signal 0 (existence check — no signal actually sent).
 */
export function isProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
