/**
 * FIX 1: join with isOrchestrator=true writes config.orchestrator
 *
 * Tests:
 *   - joining with isOrchestrator=true writes config.orchestrator = assigned peer name
 *   - subsequent escalate uses that name (routes to correct inbox)
 *   - joining without isOrchestrator does NOT modify config.orchestrator
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { executeCrewAction } from "../../crew/index.js";
import * as store from "../../crew/store.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";
import type { MessengerState, Dirs } from "../../lib.js";
import { execute as executeTask } from "../../crew/handlers/task.js";

function createUnregisteredState(): MessengerState {
  return {
    agentName: "",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test-model",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  } as unknown as MessengerState;
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox } as Dirs;
}

describe("join with isOrchestrator=true", () => {
  it("writes config.orchestrator = assigned peer name on join", async () => {
    const { cwd } = createTempCrewDirs();
    const state = createUnregisteredState();
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    await executeCrewAction(
      "join",
      { isOrchestrator: true },
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    // The agent should have been registered with some assigned name
    expect(state.registered).toBe(true);
    expect(state.agentName).toBeTruthy();

    // config.json must have been written with the assigned peer name
    const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.orchestrator).toBe(state.agentName);
  });

  it("subsequent escalate routes inbox to the dynamically registered orchestrator name", async () => {
    const { cwd } = createTempCrewDirs();
    const orchestratorState = createUnregisteredState();
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    // Orchestrator joins with isOrchestrator=true
    await executeCrewAction(
      "join",
      { isOrchestrator: true },
      orchestratorState,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    const orchestratorName = orchestratorState.agentName;
    expect(orchestratorName).toBeTruthy();

    // Create a task and escalate it
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Test Task");
    store.startTask(cwd, task.id, "WorkerA");

    const workerState = { agentName: "WorkerA", config: {} } as any;
    const workerCtx = { cwd, ui: { notify: () => {} } } as any;

    await executeTask(
      "escalate",
      { id: task.id, reason: "Blocked on DB", severity: "block" },
      workerState,
      workerCtx,
    );

    // Inbox should be in orchestratorName's inbox, NOT hardcoded 'helios'
    const orchInboxDir = path.join(cwd, ".pi", "messenger", "inbox", orchestratorName);
    expect(fs.existsSync(orchInboxDir)).toBe(true);

    const files = fs.readdirSync(orchInboxDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(orchInboxDir, files[0]!), "utf-8"));
    expect(msg.type).toBe("task.escalate");
    expect(msg.taskId).toBe(task.id);
    expect(msg.severity).toBe("block");
  });

  it("joining WITHOUT isOrchestrator does NOT write config.orchestrator", async () => {
    const { cwd } = createTempCrewDirs();
    const state = createUnregisteredState();
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    await executeCrewAction(
      "join",
      {},  // no isOrchestrator
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    expect(state.registered).toBe(true);

    const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
    // Either no config file, or orchestrator was not overwritten
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      // Should not have updated orchestrator to the joined agent name
      // (no isOrchestrator=true means we don't touch it)
      expect(config.orchestrator).not.toBe(state.agentName);
    }
    // If no config.json, that's also fine — we didn't write one
  });
});
