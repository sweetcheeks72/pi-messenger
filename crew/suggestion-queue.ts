/**
 * Suggestion Queue — Agent-to-Orchestrator Return Channel
 *
 * Provides a structured mechanism for agents to propose actions that
 * require orchestrator or human approval. Supports submit/approve/reject/expire
 * lifecycle with TTL support. JSON-persisted at .pi/messenger/crew/suggestions.json.
 *
 * Part of TASK-04: Suggestion Queue + Orchestrator Hook
 */

import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

export type SuggestionPriority = "low" | "medium" | "high" | "critical";
export type SuggestionStatus = "pending" | "approved" | "rejected" | "expired";

export interface Suggestion {
  id: string;                     // sg-XXXXX
  agentName: string;
  taskId?: string;
  priority: SuggestionPriority;
  title: string;
  description: string;
  status: SuggestionStatus;
  created_at: string;             // ISO timestamp
  resolved_at?: string;           // ISO timestamp
  resolved_by?: string;           // 'human' | agent name
  ttl_ms?: number;                // auto-expire after N ms (undefined = no expiry)
}

export interface SuggestionInput {
  agentName: string;
  taskId?: string;
  priority: SuggestionPriority;
  title: string;
  description: string;
  ttl_ms?: number;
}

interface SuggestionStore {
  version: "1";
  suggestions: Suggestion[];
}

// =============================================================================
// Constants
// =============================================================================

const STORE_FILENAME = "suggestions.json";
const ID_PREFIX = "sg-";

// =============================================================================
// Helpers
// =============================================================================

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 5; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${ID_PREFIX}${id}`;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStore(storePath: string): SuggestionStore {
  if (!fs.existsSync(storePath)) {
    return { version: "1", suggestions: [] };
  }
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === "1" && Array.isArray(parsed.suggestions)) {
      return parsed as SuggestionStore;
    }
    return { version: "1", suggestions: [] };
  } catch {
    return { version: "1", suggestions: [] };
  }
}

function writeStore(storePath: string, store: SuggestionStore): void {
  ensureDir(path.dirname(storePath));
  const temp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, storePath);
}

// =============================================================================
// SuggestionQueue Class
// =============================================================================

export class SuggestionQueue {
  private readonly storePath: string;

  /**
   * @param crewDir - Path to the .pi/messenger/crew directory.
   *   The store file will be at <crewDir>/suggestions.json
   */
  constructor(crewDir: string) {
    this.storePath = path.join(crewDir, STORE_FILENAME);
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  /**
   * Submit a new suggestion. Returns the created Suggestion with
   * id, status='pending', and created_at timestamp.
   */
  submit(input: SuggestionInput): Suggestion {
    const store = readStore(this.storePath);

    const suggestion: Suggestion = {
      id: generateId(),
      agentName: input.agentName,
      taskId: input.taskId,
      priority: input.priority,
      title: input.title,
      description: input.description,
      status: "pending",
      created_at: new Date().toISOString(),
      ttl_ms: input.ttl_ms,
    };

    store.suggestions.push(suggestion);
    writeStore(this.storePath, store);

    return suggestion;
  }

  // ---------------------------------------------------------------------------
  // Approve / Reject
  // ---------------------------------------------------------------------------

  /**
   * Approve a pending suggestion. Throws if not found or not pending.
   */
  approve(id: string, by: string): Suggestion {
    return this.resolve(id, "approved", by);
  }

  /**
   * Reject a pending suggestion. Throws if not found or not pending.
   */
  reject(id: string, by: string): Suggestion {
    return this.resolve(id, "rejected", by);
  }

  private resolve(
    id: string,
    status: "approved" | "rejected",
    by: string,
  ): Suggestion {
    const store = readStore(this.storePath);
    const suggestion = store.suggestions.find((s) => s.id === id);

    if (!suggestion) {
      throw new Error(`Suggestion ${id} not found`);
    }
    if (suggestion.status !== "pending") {
      throw new Error(
        `Suggestion ${id} is ${suggestion.status}, not pending`,
      );
    }

    suggestion.status = status;
    suggestion.resolved_at = new Date().toISOString();
    suggestion.resolved_by = by;

    writeStore(this.storePath, store);
    return { ...suggestion };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get all pending suggestions (not expired, not resolved).
   * Automatically expires stale suggestions before returning.
   */
  getPending(): Suggestion[] {
    this.expireStale();
    const store = readStore(this.storePath);
    return store.suggestions.filter((s) => s.status === "pending");
  }

  /**
   * Get all suggestions regardless of status.
   */
  getAll(): Suggestion[] {
    return readStore(this.storePath).suggestions;
  }

  /**
   * Get a suggestion by ID, or undefined.
   */
  getById(id: string): Suggestion | undefined {
    const store = readStore(this.storePath);
    return store.suggestions.find((s) => s.id === id);
  }

  /**
   * Get the count of pending suggestions (used for badge rendering).
   * Automatically expires stale suggestions first.
   */
  getPendingCount(): number {
    return this.getPending().length;
  }

  // ---------------------------------------------------------------------------
  // TTL Expiry
  // ---------------------------------------------------------------------------

  /**
   * Expire suggestions that have exceeded their TTL.
   * Returns the number of suggestions expired.
   */
  expireStale(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    const store = readStore(this.storePath);
    let expiredCount = 0;

    for (const suggestion of store.suggestions) {
      if (
        suggestion.status === "pending" &&
        suggestion.ttl_ms !== undefined &&
        suggestion.ttl_ms > 0
      ) {
        const createdMs = new Date(suggestion.created_at).getTime();
        if (now - createdMs >= suggestion.ttl_ms) {
          suggestion.status = "expired";
          suggestion.resolved_at = new Date(now).toISOString();
          suggestion.resolved_by = "system";
          expiredCount++;
        }
      }
    }

    if (expiredCount > 0) {
      writeStore(this.storePath, store);
    }

    return expiredCount;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Remove all resolved (approved/rejected/expired) suggestions older
   * than the given age. Returns the count removed.
   */
  prune(maxAgeMs: number, nowMs?: number): number {
    const now = nowMs ?? Date.now();
    const store = readStore(this.storePath);
    const before = store.suggestions.length;

    store.suggestions = store.suggestions.filter((s) => {
      if (s.status === "pending") return true; // never prune pending
      const resolvedMs = s.resolved_at
        ? new Date(s.resolved_at).getTime()
        : new Date(s.created_at).getTime();
      return now - resolvedMs < maxAgeMs;
    });

    const pruned = before - store.suggestions.length;
    if (pruned > 0) {
      writeStore(this.storePath, store);
    }
    return pruned;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

const instances = new Map<string, SuggestionQueue>();

/**
 * Get a SuggestionQueue for the given cwd.
 * Caches instances per cwd.
 */
export function getSuggestionQueue(cwd: string): SuggestionQueue {
  const crewDir = path.join(cwd, ".pi", "messenger", "crew");
  const cached = instances.get(crewDir);
  if (cached) return cached;

  const queue = new SuggestionQueue(crewDir);
  instances.set(crewDir, queue);
  return queue;
}

/**
 * Reset all cached instances. For testing only.
 * @internal
 */
export function resetSuggestionQueues(): void {
  instances.clear();
}
