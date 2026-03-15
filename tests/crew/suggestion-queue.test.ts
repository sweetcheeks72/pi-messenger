/**
 * SuggestionQueue Tests — TASK-04
 *
 * Tests for the suggestion queue: submit/approve/reject lifecycle,
 * TTL expiry, pending count, and singleton factory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  SuggestionQueue,
  getSuggestionQueue,
  resetSuggestionQueues,
  type Suggestion,
  type SuggestionInput,
  type SuggestionPriority,
  type SuggestionStatus,
} from "../../crew/suggestion-queue.js";

// =============================================================================
// Test Helpers
// =============================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sq-test-"));
}

function makeCrewDir(tmpDir: string): string {
  const crewDir = path.join(tmpDir, ".pi", "messenger", "crew");
  fs.mkdirSync(crewDir, { recursive: true });
  return crewDir;
}

function makeInput(overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    agentName: "worker-alpha",
    taskId: "task-1",
    priority: "medium",
    title: "Suggest refactoring utils",
    description: "The utils module has grown too large. Split into submodules.",
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("SuggestionQueue", () => {
  let tmpDir: string;
  let crewDir: string;
  let queue: SuggestionQueue;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    crewDir = makeCrewDir(tmpDir);
    queue = new SuggestionQueue(crewDir);
  });

  afterEach(() => {
    resetSuggestionQueues();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // submit()
  // ===========================================================================

  describe("submit()", () => {
    it("creates a suggestion with pending status and generated id", () => {
      const result = queue.submit(makeInput());

      expect(result.id).toMatch(/^sg-[a-z0-9]{5}$/);
      expect(result.status).toBe("pending");
      expect(result.agentName).toBe("worker-alpha");
      expect(result.taskId).toBe("task-1");
      expect(result.priority).toBe("medium");
      expect(result.title).toBe("Suggest refactoring utils");
      expect(result.description).toContain("utils module");
      expect(result.created_at).toBeTruthy();
      expect(result.resolved_at).toBeUndefined();
      expect(result.resolved_by).toBeUndefined();
    });

    it("persists suggestion to JSON file", () => {
      queue.submit(makeInput());

      const filePath = path.join(crewDir, "suggestions.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(raw.version).toBe("1");
      expect(raw.suggestions).toHaveLength(1);
      expect(raw.suggestions[0].status).toBe("pending");
    });

    it("generates unique IDs for multiple submissions", () => {
      const s1 = queue.submit(makeInput({ title: "First" }));
      const s2 = queue.submit(makeInput({ title: "Second" }));
      const s3 = queue.submit(makeInput({ title: "Third" }));

      expect(s1.id).not.toBe(s2.id);
      expect(s2.id).not.toBe(s3.id);
      expect(s1.id).not.toBe(s3.id);
    });

    it("stores TTL when provided", () => {
      const result = queue.submit(makeInput({ ttl_ms: 60_000 }));
      expect(result.ttl_ms).toBe(60_000);
    });

    it("handles all priority levels", () => {
      const priorities: SuggestionPriority[] = ["low", "medium", "high", "critical"];
      for (const p of priorities) {
        const result = queue.submit(makeInput({ priority: p }));
        expect(result.priority).toBe(p);
      }
    });

    it("works when no taskId is provided", () => {
      const result = queue.submit(makeInput({ taskId: undefined }));
      expect(result.taskId).toBeUndefined();
    });
  });

  // ===========================================================================
  // approve()
  // ===========================================================================

  describe("approve()", () => {
    it("transitions a pending suggestion to approved", () => {
      const s = queue.submit(makeInput());
      const approved = queue.approve(s.id, "human");

      expect(approved.status).toBe("approved");
      expect(approved.resolved_at).toBeTruthy();
      expect(approved.resolved_by).toBe("human");
    });

    it("persists the approved state", () => {
      const s = queue.submit(makeInput());
      queue.approve(s.id, "orchestrator");

      // Reload from fresh queue instance
      const freshQueue = new SuggestionQueue(crewDir);
      const reloaded = freshQueue.getById(s.id);
      expect(reloaded?.status).toBe("approved");
      expect(reloaded?.resolved_by).toBe("orchestrator");
    });

    it("throws when suggestion not found", () => {
      expect(() => queue.approve("sg-nope0", "human")).toThrow("not found");
    });

    it("throws when suggestion is already approved", () => {
      const s = queue.submit(makeInput());
      queue.approve(s.id, "human");
      expect(() => queue.approve(s.id, "human")).toThrow("not pending");
    });

    it("throws when suggestion is already rejected", () => {
      const s = queue.submit(makeInput());
      queue.reject(s.id, "human");
      expect(() => queue.approve(s.id, "human")).toThrow("not pending");
    });
  });

  // ===========================================================================
  // reject()
  // ===========================================================================

  describe("reject()", () => {
    it("transitions a pending suggestion to rejected", () => {
      const s = queue.submit(makeInput());
      const rejected = queue.reject(s.id, "human");

      expect(rejected.status).toBe("rejected");
      expect(rejected.resolved_at).toBeTruthy();
      expect(rejected.resolved_by).toBe("human");
    });

    it("persists the rejected state", () => {
      const s = queue.submit(makeInput());
      queue.reject(s.id, "reviewer-murray");

      const freshQueue = new SuggestionQueue(crewDir);
      const reloaded = freshQueue.getById(s.id);
      expect(reloaded?.status).toBe("rejected");
      expect(reloaded?.resolved_by).toBe("reviewer-murray");
    });

    it("throws when suggestion not found", () => {
      expect(() => queue.reject("sg-nope0", "human")).toThrow("not found");
    });

    it("throws when suggestion is already resolved", () => {
      const s = queue.submit(makeInput());
      queue.approve(s.id, "human");
      expect(() => queue.reject(s.id, "human")).toThrow("not pending");
    });
  });

  // ===========================================================================
  // getPending()
  // ===========================================================================

  describe("getPending()", () => {
    it("returns empty array when no suggestions", () => {
      expect(queue.getPending()).toEqual([]);
    });

    it("returns only pending suggestions", () => {
      const s1 = queue.submit(makeInput({ title: "Pending one" }));
      const s2 = queue.submit(makeInput({ title: "Will approve" }));
      const s3 = queue.submit(makeInput({ title: "Pending two" }));

      queue.approve(s2.id, "human");

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
      expect(pending.map((s) => s.title)).toEqual(["Pending one", "Pending two"]);
    });

    it("excludes expired suggestions", () => {
      // Submit with a very short TTL in the past
      const s = queue.submit(makeInput({ title: "Will expire", ttl_ms: 1 }));

      // Force time forward by calling expireStale with a future timestamp
      const futureMs = Date.now() + 1000;
      queue.expireStale(futureMs);

      const pending = queue.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  // ===========================================================================
  // getAll()
  // ===========================================================================

  describe("getAll()", () => {
    it("returns all suggestions regardless of status", () => {
      const s1 = queue.submit(makeInput({ title: "A" }));
      const s2 = queue.submit(makeInput({ title: "B" }));
      queue.approve(s1.id, "human");
      queue.reject(s2.id, "human");
      queue.submit(makeInput({ title: "C" }));

      const all = queue.getAll();
      expect(all).toHaveLength(3);
    });
  });

  // ===========================================================================
  // getById()
  // ===========================================================================

  describe("getById()", () => {
    it("returns undefined for nonexistent id", () => {
      expect(queue.getById("sg-nope0")).toBeUndefined();
    });

    it("returns the correct suggestion", () => {
      const s = queue.submit(makeInput({ title: "Find me" }));
      const found = queue.getById(s.id);
      expect(found?.title).toBe("Find me");
    });
  });

  // ===========================================================================
  // getPendingCount()
  // ===========================================================================

  describe("getPendingCount()", () => {
    it("returns 0 when empty", () => {
      expect(queue.getPendingCount()).toBe(0);
    });

    it("returns count of pending suggestions only", () => {
      const s1 = queue.submit(makeInput());
      queue.submit(makeInput());
      queue.submit(makeInput());
      queue.approve(s1.id, "human");

      expect(queue.getPendingCount()).toBe(2);
    });
  });

  // ===========================================================================
  // expireStale()
  // ===========================================================================

  describe("expireStale()", () => {
    it("returns 0 when no suggestions have TTL", () => {
      queue.submit(makeInput()); // no ttl_ms
      expect(queue.expireStale()).toBe(0);
    });

    it("expires suggestions past their TTL", () => {
      // Submit with short TTL
      queue.submit(makeInput({ title: "Short-lived", ttl_ms: 100 }));
      queue.submit(makeInput({ title: "Also short", ttl_ms: 200 }));
      queue.submit(makeInput({ title: "No expiry" }));

      // Move time forward past both TTLs
      const futureMs = Date.now() + 500;
      const count = queue.expireStale(futureMs);

      expect(count).toBe(2);

      const all = queue.getAll();
      const expired = all.filter((s) => s.status === "expired");
      expect(expired).toHaveLength(2);
      expect(expired[0].resolved_by).toBe("system");
    });

    it("does not expire suggestions with TTL not yet exceeded", () => {
      queue.submit(makeInput({ title: "Long-lived", ttl_ms: 60_000 }));

      const count = queue.expireStale(); // now — just created
      expect(count).toBe(0);

      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
    });

    it("does not expire already resolved suggestions", () => {
      const s = queue.submit(makeInput({ ttl_ms: 1 }));
      queue.approve(s.id, "human");

      const futureMs = Date.now() + 1000;
      const count = queue.expireStale(futureMs);
      expect(count).toBe(0);

      const found = queue.getById(s.id);
      expect(found?.status).toBe("approved"); // not expired
    });

    it("sets resolved_at and resolved_by on expired suggestions", () => {
      queue.submit(makeInput({ ttl_ms: 50 }));

      const futureMs = Date.now() + 100;
      queue.expireStale(futureMs);

      const all = queue.getAll();
      expect(all[0].status).toBe("expired");
      expect(all[0].resolved_at).toBeTruthy();
      expect(all[0].resolved_by).toBe("system");
    });
  });

  // ===========================================================================
  // prune()
  // ===========================================================================

  describe("prune()", () => {
    it("removes old resolved suggestions", () => {
      const s1 = queue.submit(makeInput({ title: "Old approved" }));
      queue.approve(s1.id, "human");

      const now = Date.now() + 100_000; // 100s later
      const pruned = queue.prune(50_000, now); // prune anything older than 50s
      expect(pruned).toBe(1);
      expect(queue.getAll()).toHaveLength(0);
    });

    it("never prunes pending suggestions", () => {
      queue.submit(makeInput({ title: "Still pending" }));

      const now = Date.now() + 1_000_000;
      const pruned = queue.prune(1, now);
      expect(pruned).toBe(0);
      expect(queue.getAll()).toHaveLength(1);
    });

    it("keeps recently resolved suggestions", () => {
      const s = queue.submit(makeInput());
      queue.reject(s.id, "human");

      const pruned = queue.prune(60_000); // 1 min max age
      expect(pruned).toBe(0);
      expect(queue.getAll()).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Persistence across instances
  // ===========================================================================

  describe("persistence", () => {
    it("new SuggestionQueue instance reads existing data", () => {
      const s = queue.submit(makeInput({ title: "Persisted" }));

      const newQueue = new SuggestionQueue(crewDir);
      const found = newQueue.getById(s.id);
      expect(found?.title).toBe("Persisted");
      expect(found?.status).toBe("pending");
    });

    it("handles missing or corrupted file gracefully", () => {
      const filePath = path.join(crewDir, "suggestions.json");

      // Write corrupted JSON
      fs.writeFileSync(filePath, "not valid json!!!");
      expect(queue.getAll()).toEqual([]);

      // Write wrong structure
      fs.writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      expect(queue.getAll()).toEqual([]);
    });
  });

  // ===========================================================================
  // getSuggestionQueue() singleton
  // ===========================================================================

  describe("getSuggestionQueue()", () => {
    it("returns the same instance for the same cwd", () => {
      const q1 = getSuggestionQueue(tmpDir);
      const q2 = getSuggestionQueue(tmpDir);
      expect(q1).toBe(q2);
    });

    it("returns different instances for different cwds", () => {
      const tmpDir2 = makeTmpDir();
      try {
        const q1 = getSuggestionQueue(tmpDir);
        const q2 = getSuggestionQueue(tmpDir2);
        expect(q1).not.toBe(q2);
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });
});
