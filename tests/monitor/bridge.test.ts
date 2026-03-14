/**
 * tests/monitor/bridge.test.ts
 *
 * Tests for CrewMonitorBridge — verifies that the bridge correctly maps
 * live-worker events to monitor session lifecycle calls and event emissions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CrewMonitorBridge, createCrewMonitorBridge } from "../../src/monitor/bridge.js";
import { SessionLifecycleManager } from "../../src/monitor/lifecycle/manager.js";
import { SessionEventEmitter } from "../../src/monitor/events/emitter.js";
import { SessionStore } from "../../src/monitor/store/session-store.js";
import { createMonitorRegistry } from "../../src/monitor/index.js";
import type { SessionEvent } from "../../src/monitor/events/types.js";
import type { LiveWorkerInfo } from "../../crew/live-progress.js";
import {
  getLiveWorkers,
  onLiveWorkersChanged,
  removeLiveWorker,
  updateLiveWorker,
} from "../../crew/live-progress.js";

function makeWorker(taskId: string, overrides: Partial<LiveWorkerInfo> = {}): LiveWorkerInfo {
  return {
    cwd: "/tmp/test",
    taskId,
    agent: "TestAgent",
    name: `worker-${taskId}`,
    startedAt: Date.now(),
    progress: {
      agent: "TestAgent",
      status: "running",
      currentTool: undefined,
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
      filesModified: [],
      toolCallBuckets: [],
      ...overrides.progress,
    },
    ...overrides,
  };
}

function addWorker(worker: LiveWorkerInfo): void {
  updateLiveWorker(worker.cwd, worker.taskId, {
    taskId: worker.taskId,
    agent: worker.agent,
    name: worker.name,
    startedAt: worker.startedAt,
    progress: worker.progress,
  });
}

describe("CrewMonitorBridge", () => {
  let lifecycle: SessionLifecycleManager;
  let emitter: SessionEventEmitter;
  let store: SessionStore;
  let emittedEvents: SessionEvent[];
  let createdWorkers: Array<{ cwd: string; taskId: string }>;
  let activeBridges: CrewMonitorBridge[];

  beforeEach(() => {
    store = new SessionStore();
    emitter = new SessionEventEmitter();
    lifecycle = new SessionLifecycleManager(store, emitter);
    emittedEvents = [];
    createdWorkers = [];
    activeBridges = [];
    emitter.subscribe((event) => emittedEvents.push(event));
  });

  afterEach(() => {
    for (const bridge of activeBridges) {
      bridge.dispose();
    }
    for (const worker of createdWorkers) {
      removeLiveWorker(worker.cwd, worker.taskId);
    }
  });

  function trackBridge(bridge: CrewMonitorBridge): CrewMonitorBridge {
    activeBridges.push(bridge);
    return bridge;
  }

  function trackWorker(worker: LiveWorkerInfo): LiveWorkerInfo {
    createdWorkers.push({ cwd: worker.cwd, taskId: worker.taskId });
    return worker;
  }

  it("subscribes to live updates and creates a session when a worker arrives after construction", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    expect(bridge.sessionCount).toBe(0);

    const worker = trackWorker(makeWorker("task-late-join", { name: "Late Join Worker" }));
    addWorker(worker);

    const sessionId = bridge.getSessionId(worker.taskId, worker.cwd);
    expect(sessionId).toBeDefined();
    expect(store.get(sessionId!)).toMatchObject({
      status: "active",
      metadata: {
        id: sessionId,
        name: "Late Join Worker",
        taskId: "task-late-join",
        cwd: "/tmp/test",
        agent: "TestAgent",
      },
    });

    const startEvents = emittedEvents.filter((event) => event.type === "session.start");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      sessionId,
      payload: {
        type: "session.start",
        agentName: "TestAgent",
        workingDir: "/tmp/test",
      },
    });
  });

  it("performs initial sync on construction and picks up pre-existing workers", () => {
    const worker = trackWorker(makeWorker("task-existing", { name: "Existing Worker" }));
    addWorker(worker);

    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));

    const sessionId = bridge.getSessionId("task-existing", "/tmp/test");
    expect(bridge.sessionCount).toBe(1);
    expect(sessionId).toBeDefined();
    expect(store.get(sessionId!)).toMatchObject({
      status: "active",
      metadata: {
        name: "Existing Worker",
        taskId: "task-existing",
      },
    });
  });

  it("ends the mapped monitor session and emits a single session.end event when the worker disappears", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const worker = trackWorker(makeWorker("task-remove", { name: "Remove Worker" }));
    addWorker(worker);

    emittedEvents = [];
    const sessionId = bridge.getSessionId("task-remove", worker.cwd)!;
    removeLiveWorker(worker.cwd, worker.taskId);

    expect(store.get(sessionId)).toMatchObject({
      status: "ended",
      metadata: { name: "Remove Worker" },
    });
    expect(bridge.sessionCount).toBe(0);

    const endEvents = emittedEvents.filter((event) => event.type === "session.end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toMatchObject({
      sessionId,
      payload: { type: "session.end", summary: undefined },
    });
  });

  it("does not emit duplicate session.end events when removal notifications repeat", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const worker = trackWorker(makeWorker("task-double-end"));
    addWorker(worker);

    const sessionId = bridge.getSessionId(worker.taskId, worker.cwd)!;
    removeLiveWorker(worker.cwd, worker.taskId);
    removeLiveWorker(worker.cwd, worker.taskId);

    const endEvents = emittedEvents.filter((event) => event.type === "session.end");
    expect(endEvents).toHaveLength(1);
    expect(store.get(sessionId)?.status).toBe("ended");
  });

  it("emits tool.call events only when the current tool changes", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const worker = trackWorker(makeWorker("task-tools"));
    addWorker(worker);

    emittedEvents = [];

    addWorker(makeWorker("task-tools", { progress: { ...worker.progress, currentTool: "read" } }));
    addWorker(makeWorker("task-tools", { progress: { ...worker.progress, currentTool: "read" } }));
    addWorker(makeWorker("task-tools", { progress: { ...worker.progress, currentTool: undefined } }));
    addWorker(makeWorker("task-tools", { progress: { ...worker.progress, currentTool: "write" } }));
    addWorker(makeWorker("task-tools", { progress: { ...worker.progress, currentTool: "bash" } }));

    const toolCallEvents = emittedEvents.filter((event) => event.type === "tool.call");
    expect(toolCallEvents.map((event) => event.payload)).toEqual([
      { type: "tool.call", toolName: "read" },
      { type: "tool.call", toolName: "write" },
      { type: "tool.call", toolName: "bash" },
    ]);
  });

  it("emits a tool.call immediately when a discovered worker is already running a tool", () => {
    const worker = trackWorker(
      makeWorker("task-pre-tool", {
        progress: {
          agent: "TestAgent",
          status: "running",
          currentTool: "grep",
          recentTools: [],
          toolCallCount: 1,
          tokens: 0,
          durationMs: 0,
          filesModified: [],
          toolCallBuckets: [],
        },
      }),
    );
    addWorker(worker);

    emittedEvents = [];
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));

    const toolCallEvents = emittedEvents.filter((event) => event.type === "tool.call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      sessionId: bridge.getSessionId("task-pre-tool", worker.cwd),
      payload: { type: "tool.call", toolName: "grep" },
    });
  });

  it("returns undefined for an unknown task and resolves duplicate task ids by cwd", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const workerA = trackWorker(makeWorker("task-shared", { cwd: "/tmp/project-a", name: "Worker A" }));
    const workerB = trackWorker(makeWorker("task-shared", { cwd: "/tmp/project-b", name: "Worker B" }));
    addWorker(workerA);
    addWorker(workerB);

    expect(bridge.getSessionId("missing-task")).toBeUndefined();

    const sessionA = bridge.getSessionId("task-shared", "/tmp/project-a");
    const sessionB = bridge.getSessionId("task-shared", "/tmp/project-b");
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    expect(sessionA).not.toBe(sessionB);
    expect(store.get(sessionA!)?.metadata.name).toBe("Worker A");
    expect(store.get(sessionB!)?.metadata.name).toBe("Worker B");
  });

  it("starts a fresh monitor session when the same live worker task is restarted", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const worker = trackWorker(makeWorker("task-restart", { name: "Restart Worker" }));
    addWorker(worker);

    const firstSessionId = bridge.getSessionId(worker.taskId, worker.cwd)!;
    removeLiveWorker(worker.cwd, worker.taskId);

    const restartedWorker = makeWorker("task-restart", { name: "Restart Worker", startedAt: worker.startedAt + 5_000 });
    addWorker(restartedWorker);

    const secondSessionId = bridge.getSessionId(worker.taskId, worker.cwd)!;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(store.get(firstSessionId)).toMatchObject({
      status: "ended",
      metadata: { taskId: "task-restart" },
    });
    expect(store.get(secondSessionId)).toMatchObject({
      status: "active",
      metadata: { taskId: "task-restart" },
    });
  });

  it("dispose prevents future syncs without mutating already-created sessions", () => {
    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    const worker = trackWorker(makeWorker("task-before-dispose"));
    addWorker(worker);

    const sessionId = bridge.getSessionId(worker.taskId, worker.cwd)!;
    bridge.dispose();

    const laterWorker = trackWorker(makeWorker("task-after-dispose", { name: "Ignored Worker" }));
    addWorker(laterWorker);

    expect(bridge.sessionCount).toBe(1);
    expect(bridge.getSessionId(laterWorker.taskId, laterWorker.cwd)).toBeUndefined();
    expect(store.get(sessionId)?.status).toBe("active");
  });

  it("can be created from a registry and respects cwd filtering", () => {
    const registry = createMonitorRegistry();
    const bridge = trackBridge(createCrewMonitorBridge(registry, { cwd: "/tmp/project-a" }));
    const workerA = trackWorker(makeWorker("task-a", { cwd: "/tmp/project-a", name: "Project A Worker" }));
    const workerB = trackWorker(makeWorker("task-b", { cwd: "/tmp/project-b", name: "Project B Worker" }));
    addWorker(workerA);
    addWorker(workerB);

    expect(getLiveWorkers("/tmp/project-a").has("task-a")).toBe(true);
    expect(getLiveWorkers("/tmp/project-a").has("task-b")).toBe(false);
    expect(bridge.sessionCount).toBe(1);

    const sessionId = bridge.getSessionId("task-a", "/tmp/project-a");
    expect(sessionId).toBeDefined();
    expect(registry.store.get(sessionId!)).toMatchObject({
      status: "active",
      metadata: { name: "Project A Worker", cwd: "/tmp/project-a" },
    });

    registry.dispose();
  });

  it("unsubscribes its listener on dispose", () => {
    const before = onLiveWorkersChanged(() => {});
    before();

    const bridge = trackBridge(new CrewMonitorBridge(lifecycle, emitter));
    bridge.dispose();

    const postDisposeWorker = trackWorker(makeWorker("task-post-dispose", { name: "Post Dispose Worker" }));
    addWorker(postDisposeWorker);

    expect(bridge.getSessionId(postDisposeWorker.taskId, postDisposeWorker.cwd)).toBeUndefined();
  });
});
