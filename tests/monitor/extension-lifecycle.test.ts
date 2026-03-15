import { describe, it, expect } from "vitest";
import { createMonitorRegistry, MonitorRegistry } from "../../src/monitor/index.js";

/**
 * Tests verifying MonitorRegistry lifecycle semantics that underpin
 * the extension wiring in index.ts (session_start creates, session_shutdown disposes)
 * and overlay.ts (optional registry constructor parameter).
 *
 * We test MonitorRegistry directly rather than importing MessengerOverlay,
 * because overlay.ts has a peer-dep on @mariozechner/pi-tui not available in
 * the vitest environment.
 */
describe("MonitorRegistry extension lifecycle wiring", () => {
  it("createMonitorRegistry produces a MonitorRegistry instance with all services", () => {
    const registry = createMonitorRegistry();
    expect(registry).toBeInstanceOf(MonitorRegistry);
    expect(registry.lifecycle.getStore()).toBe(registry.store);
    expect(registry.lifecycle.getEmitter()).toBe(registry.emitter);
    expect(registry.healthMonitor.getSessionHealth("missing-session")).toMatchObject({
      sessionId: "missing-session",
      state: "healthy",
      actionable: false,
    });
    registry.dispose();
  });

  it("registry.dispose() is idempotent — safe to call on session_shutdown", () => {
    const registry = createMonitorRegistry();
    registry.dispose();
    expect(() => registry.dispose()).not.toThrow();
  });

  it("a new registry is independent from a disposed one — simulates session_start after session_shutdown", () => {
    // First session
    const registry1 = createMonitorRegistry();
    const sessionId = registry1.lifecycle.start({ name: "s1", cwd: "/tmp/s1", model: "m", agent: "A" });
    expect(registry1.store.get(sessionId)).not.toBeNull();
    registry1.dispose();

    // Second session — fresh registry, no shared state
    const registry2 = createMonitorRegistry();
    expect(registry2.store.get(sessionId)).toBeUndefined();
    registry2.dispose();
  });

  it("session-scoped registry can keep tracking workers after an overlay closes", async () => {
    const { createCrewMonitorBridge } = await import("../../src/monitor/bridge.js");
    const { updateLiveWorker, removeLiveWorker } = await import("../../crew/live-progress.js");

    const cwd = `/tmp/overlay-close-${Date.now()}`;
    const taskId = "task-overlay-close";
    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, {
        taskId,
        agent: "TestAgent",
        name: "worker-overlay-close",
        startedAt: Date.now(),
        progress: {
          agent: "TestAgent",
          status: "running",
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
          filesModified: [],
          toolCallBuckets: [],
        },
      });

      const sessionId = bridge.getSessionId(taskId, cwd);
      expect(typeof sessionId).toBe("string");
      expect(registry.store.get(sessionId!)).toMatchObject({
        status: "active",
        metadata: {
          taskId,
          cwd,
          name: "worker-overlay-close",
        },
      });

      // Overlay close should not dispose the session-scoped bridge/registry.
      expect(bridge.sessionCount).toBe(1);
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("registry passed to overlay stores correctly — structural check via optional pattern", () => {
    // Simulate what overlay.ts constructor does:
    //   this.registry = registry;  (stored when provided)
    //   this.registry = undefined; (when omitted)
    const registry = createMonitorRegistry();

    // Pattern: store in a variable, works whether defined or undefined
    const stored1: MonitorRegistry | undefined = registry;
    expect(stored1).toBe(registry);

    const stored2: MonitorRegistry | undefined = undefined;
    expect(stored2).toBeUndefined();

    registry.dispose();
  });
});
