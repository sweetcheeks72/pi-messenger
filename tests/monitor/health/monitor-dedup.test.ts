/**
 * Health monitor — alert deduplication tests.
 *
 * Verifies that identical health-alert statuses are NOT re-emitted on every
 * polling cycle, but NEW statuses (e.g. degraded → critical) DO generate a
 * fresh alert.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionHealthMonitor } from "../../../src/monitor/health/monitor.js";
import { SessionStore } from "../../../src/monitor/store/session-store.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import type { HealthAlert } from "../../../src/monitor/health/types.js";

function makeStore() {
  return new SessionStore();
}

function makeEmitter() {
  return new SessionEventEmitter();
}

function createActiveSession(store: SessionStore, emitter: SessionEventEmitter, id = "sess-dedup") {
  store.create({
    id,
    name: "dedup-session",
    cwd: "/tmp",
    model: "test-model",
    agent: "test-agent",
    startedAt: new Date().toISOString(),
  });
  store.update(id, { status: "active" });

  emitter.emit({
    id: `evt-${id}-start`,
    type: "session.start",
    sessionId: id,
    timestamp: Date.now(),
    sequence: 0,
    payload: { type: "session.start", agentName: "test-agent" },
  });

  return id;
}

describe("SessionHealthMonitor — alert deduplication", () => {
  let store: SessionStore;
  let emitter: SessionEventEmitter;
  let monitor: SessionHealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    store = makeStore();
    emitter = makeEmitter();
    monitor = new SessionHealthMonitor(store, emitter);
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("emits only one alert when checkHealth is called multiple times with the same unhealthy status", () => {
    const id = createActiveSession(store, emitter);
    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(6_000); // past stale threshold

    monitor.checkHealth(id); // → degraded, first alert → emit
    monitor.checkHealth(id); // → degraded, same status → suppress
    monitor.checkHealth(id); // → degraded, same status → suppress

    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("degraded");
  });

  it("emits a new alert when status escalates from degraded to critical", () => {
    const id = createActiveSession(store, emitter);
    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    // Phase 1: stale (degraded)
    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id); // degraded alert
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("degraded");

    // Phase 2: stuck (critical) — advance past stuck threshold
    vi.advanceTimersByTime(25_000); // total 31s > stuckAfterMs (30s)
    monitor.checkHealth(id); // critical alert — different status → emit
    expect(alerts).toHaveLength(2);
    expect(alerts[1].status).toBe("critical");
  });

  it("resets dedup state when session recovers to healthy (new event arrives)", () => {
    const id = createActiveSession(store, emitter);
    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    // Make session stale → first degraded alert
    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);
    expect(alerts).toHaveLength(1);

    // Simulate a new event arriving (session recovers)
    emitter.emit({
      id: `evt-${id}-recovery`,
      type: "agent.progress",
      sessionId: id,
      timestamp: Date.now(),
      sequence: 1,
      payload: { type: "agent.progress", message: "recovered" },
    });

    // Now healthy — check resets the tracking
    monitor.checkHealth(id); // healthy → clears lastAlertStatus
    expect(alerts).toHaveLength(1); // still 1 (healthy → no alert)

    // Stale again after enough time — should get a SECOND alert (tracking was reset)
    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].status).toBe("degraded");
  });

  it("polling suppresses repeated identical alerts across multiple cycles", () => {
    const id = createActiveSession(store, emitter);
    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    // Start polling every 3s; stale threshold 5s → first poll at 3s (not stale), second at 6s (stale)
    monitor.start(3_000);
    vi.advanceTimersByTime(15_000); // 5 polling cycles, 4 of them while stale

    // Should emit exactly 1 degraded alert (first detection), not 4
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("degraded");
  });
});
