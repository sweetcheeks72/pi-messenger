import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createMonitorRegistry, MonitorRegistry } from "../../src/monitor/index.js";
import type { HealthAlert } from "../../src/monitor/health/types.js";

describe("MonitorRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates all monitor services behind a single import and wires them together", () => {
    const registry = createMonitorRegistry();

    expect(registry).toBeInstanceOf(MonitorRegistry);
    expect(registry.store).toBeDefined();
    expect(registry.emitter).toBeDefined();
    expect(registry.lifecycle).toBeDefined();
    expect(registry.aggregator).toBeDefined();
    expect(registry.commandHandler).toBeDefined();
    expect(registry.healthMonitor).toBeDefined();
    expect(registry.replayer).toBeDefined();
    expect(registry.exporter).toBeDefined();
    expect(registry.feedSubscriber).toBeDefined();

    const sessionId = registry.lifecycle.start({
      name: "registry-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "ZenJaguar",
      taskId: "task-3",
    });

    registry.emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "tool.call",
        toolName: "bash",
        args: { command: "npm test" },
      },
    });

    expect(registry.store.get(sessionId)?.status).toBe("active");
    expect(registry.commandHandler.execute({ action: "inspect", sessionId }).success).toBe(true);
    expect(registry.aggregator.computeMetrics(sessionId).toolCalls).toBe(1);
    expect(registry.replayer.replay(sessionId).metadata.id).toBe(sessionId);
    expect(registry.exporter.toJSON(sessionId)).toContain(`"sessionId": "${sessionId}"`);
    expect(registry.feedSubscriber.getBuffer().some((event) => event.sessionId === sessionId)).toBe(true);

    registry.dispose();
  });

  it("dispose stops health polling and detaches metric aggregation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const registry = createMonitorRegistry();
    registry.healthMonitor.setThresholds({
      staleAfterMs: 10,
      stuckAfterMs: 20,
      errorRateThreshold: 0.5,
    });

    const alerts: HealthAlert[] = [];
    registry.healthMonitor.onAlert((alert) => alerts.push(alert));

    const sessionId = registry.lifecycle.start({
      name: "polling-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "ZenJaguar",
      taskId: "task-3",
    });

    registry.healthMonitor.start(5);
    registry.dispose();

    vi.advanceTimersByTime(100);
    expect(alerts).toHaveLength(0);

    const metricsBefore = registry.aggregator.computeMetrics(sessionId);
    registry.emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "tool.call",
        toolName: "bash",
      },
    });

    const metricsAfter = registry.aggregator.computeMetrics(sessionId);
    expect(metricsAfter.totalEvents).toBe(metricsBefore.totalEvents);
  });

  it("applies custom health thresholds from crew config", () => {
    const registry = createMonitorRegistry({
      healthConfig: {
        staleAfterMs: 10_000,
        stuckAfterMs: 60_000,
        errorRateThreshold: 0.3,
        pollIntervalMs: 2_000,
      },
    });

    // pollIntervalMs is exposed on the registry
    expect(registry.pollIntervalMs).toBe(2_000);

    // Verify thresholds were applied: a session stale for 15s should be degraded
    // (custom staleAfterMs=10000, default would be 30000)
    const sessionId = registry.lifecycle.start({
      name: "threshold-test-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "DarkNova",
      taskId: "task-7",
    });

    // Emit an event to initialise signal history with a past timestamp
    const staleTime = Date.now() - 15_000; // 15 seconds ago — past custom 10s threshold
    registry["healthMonitor"]["signalHistory"].set(sessionId, {
      lastHeartbeatAt: staleTime,
      lastOutputAt: staleTime,
      lastToolActivityAt: staleTime,
      waiting: false,
      waitingReason: undefined,
      waitingAt: undefined,
      retryCount: 0,
    });

    const status = registry.healthMonitor.checkHealth(sessionId);
    expect(status).toBe("degraded");

    registry.dispose();
  });

  it("falls back to defaults for invalid health config values", () => {
    const registry = createMonitorRegistry({
      healthConfig: {
        staleAfterMs: -1,      // invalid — negative
        stuckAfterMs: NaN,     // invalid — not finite
        errorRateThreshold: 2, // invalid — > 1
        pollIntervalMs: 0,     // invalid — not positive
      },
    });

    expect(registry.pollIntervalMs).toBe(5_000);

    // With default staleAfterMs=30000, a session stale for 15s should be healthy
    const sessionId = registry.lifecycle.start({
      name: "fallback-defaults-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "DarkNova",
      taskId: "task-7",
    });

    const staleTime = Date.now() - 15_000;
    registry["healthMonitor"]["signalHistory"].set(sessionId, {
      lastHeartbeatAt: staleTime,
      lastOutputAt: staleTime,
      lastToolActivityAt: staleTime,
      waiting: false,
      waitingReason: undefined,
      waitingAt: undefined,
      retryCount: 0,
    });

    const status = registry.healthMonitor.checkHealth(sessionId);
    expect(status).toBe("healthy");

    registry.dispose();
  });

  it("reads health config from a crew config JSON file", async () => {
    const { tmpdir } = await import("node:os");
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const dir = join(tmpdir(), `registry-test-${Date.now()}`);
    const configPath = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        health: {
          staleAfterMs: 8_000,
          stuckAfterMs: 50_000,
          errorRateThreshold: 0.25,
          pollIntervalMs: 1_500,
        },
      }),
    );

    const registry = createMonitorRegistry({ crewConfigPath: configPath });
    expect(registry.pollIntervalMs).toBe(1_500);

    const sessionId = registry.lifecycle.start({
      name: "file-config-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "DarkNova",
      taskId: "task-7",
    });

    // Session stale for 10s — past custom 8s threshold → degraded
    const staleTime = Date.now() - 10_000;
    registry["healthMonitor"]["signalHistory"].set(sessionId, {
      lastHeartbeatAt: staleTime,
      lastOutputAt: staleTime,
      lastToolActivityAt: staleTime,
      waiting: false,
      waitingReason: undefined,
      waitingAt: undefined,
      retryCount: 0,
    });

    const status = registry.healthMonitor.checkHealth(sessionId);
    expect(status).toBe("degraded");

    registry.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});
