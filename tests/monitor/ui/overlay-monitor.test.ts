import { describe, it, expect, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (_data: string, _key: string) => false,
}));

import { renderAttentionQueue, renderMonitorView, renderMonitorDetailView } from "../../../overlay-render.js";
import type { CrewViewState } from "../../../overlay-actions.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";
import { stripAnsi } from "../../../src/monitor/ui/render.js";

function makeViewState(overrides?: Partial<CrewViewState>): CrewViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
    mode: "monitor",
    detailScroll: 0,
    detailAutoScroll: true,
    confirmAction: null,
    blockReasonInput: "",
    messageInput: "",
    inputMode: "normal",
    reviseScope: "single",
    revisePromptInput: "",
    lastSeenEventTs: null,
    notification: null,
    notificationTimer: null,
    feedFocus: false,
    mentionCandidates: [],
    mentionIndex: -1,
    scrollLocked: false,
    monitorSelectedIndex: 0,
    monitorDetailScroll: 0,
    ...overrides,
  };
}

function makeRegistry(): MonitorRegistry {
  return new MonitorRegistry({ healthConfig: {} });
}

function startSession(registry: MonitorRegistry, id: string, name: string, overrides: Record<string, unknown> = {}): string {
  return registry.lifecycle.start({
    id,
    name,
    cwd: "/tmp/project",
    model: "claude-3",
    startedAt: new Date().toISOString(),
    agent: name,
    ...(overrides as any),
  });
}

describe("renderMonitorView", () => {
  it("returns a padded fallback when no registry is available", () => {
    const viewState = makeViewState();
    const lines = renderMonitorView(undefined, 80, 10, viewState);

    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("  No monitor registry available.");
    expect(lines.slice(1)).toEqual(new Array(9).fill(""));
  });

  it("returns a padded empty-state when the registry has no sessions", () => {
    const registry = makeRegistry();
    const lines = renderMonitorView(registry, 80, 10, makeViewState());

    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("  No active sessions.");
    expect(lines[1]).toBe("");
    registry.dispose();
  });

  it("renders grouped session sections and the selected running session", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-running", "Running Session");
    const queuedId = startSession(registry, "sess-queued", "Queued Session");
    registry.lifecycle.pause(queuedId, "awaiting operator input");
    registry.store.update(queuedId, {
      events: [
        { type: "session.pause", timestamp: new Date().toISOString(), data: { reason: "awaiting operator input" } },
      ],
    });
    const completedId = startSession(registry, "sess-ended", "Completed Session");
    registry.lifecycle.end(completedId, "all done");
    const failedId = startSession(registry, "sess-failed", "Failed Session");
    registry.lifecycle.escalate(failedId, "worker crashed");
    registry.store.update(failedId, {
      events: [
        { type: "session.error", timestamp: new Date().toISOString(), data: { message: "worker crashed" } },
      ],
    });

    const lines = renderMonitorView(registry, 120, 20, makeViewState({ monitorSelectedIndex: 0 }));
    const visible = lines.map((line) => stripAnsi(line));

    expect(visible).toContain("⚠ Attention (2)");
    expect(visible).toContain("Running (1)");
    expect(visible).toContain("Queued (1)");
    expect(visible).toContain("Completed (1)");
    expect(visible).toContain("Failed (1)");
    expect(visible.some((line) => line.includes(">") && line.includes("Running Session"))).toBe(true);
    expect(visible.some((line) => line.includes("sess-queued") && line.includes("awaiting operator input"))).toBe(true);
    expect(visible.some((line) => line.includes("Reason: worker crashed"))).toBe(true);

    registry.dispose();
  });

  it("clamps monitorSelectedIndex to the available session range", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-only", "Only Session");
    const viewState = makeViewState({ monitorSelectedIndex: 999 });

    renderMonitorView(registry, 80, 10, viewState);

    expect(viewState.monitorSelectedIndex).toBe(0);
    registry.dispose();
  });

  it("pads monitor output to the requested height", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-height", "Height Session");

    const lines = renderMonitorView(registry, 80, 15, makeViewState());

    expect(lines).toHaveLength(15);
    expect(stripAnsi(lines[0])).toContain("Running (1)");
    expect(stripAnsi(lines[1])).toContain("Height Session");
    expect(lines.at(-1)).toBe("");
    registry.dispose();
  });

  it("renders an attention queue for paused and error sessions but not healthy active sessions", () => {
    const registry = makeRegistry();
    const pausedId = startSession(registry, "sess-paused", "Paused Session");
    registry.lifecycle.pause(pausedId, "waiting for approval");
    registry.store.update(pausedId, {
      events: [
        { type: "session.pause", timestamp: new Date().toISOString(), data: { reason: "waiting for approval" } },
      ],
    });
    const failedId = startSession(registry, "sess-error", "Error Session");
    registry.lifecycle.escalate(failedId, "tool failed repeatedly");
    registry.store.update(failedId, {
      events: [
        { type: "session.error", timestamp: new Date().toISOString(), data: { message: "tool failed repeatedly" } },
      ],
    });
    startSession(registry, "sess-healthy", "Healthy Session");

    const lines = renderMonitorView(registry, 120, 20, makeViewState());
    const visible = lines.map((line) => stripAnsi(line));

    expect(visible[0]).toBe("⚠ Attention (2)");
    expect(visible.some((line) => line.includes("sess-paused") && line.includes("waiting for approval"))).toBe(true);
    expect(visible.some((line) => line.includes("sess-error") && line.includes("Session failed with a recoverable error."))).toBe(true);
    expect(visible.some((line) => line.includes("Resume after operator input."))).toBe(true);
    expect(visible.some((line) => line.includes("Review logs and retry after applying a fix."))).toBe(true);
    expect(visible.some((line) => line.includes("sess-healthy") && line.includes("healthy"))).toBe(false);

    registry.dispose();
  });
});

describe("renderAttentionQueue", () => {
  it("returns an empty array when there are no attention items", () => {
    expect(renderAttentionQueue([], 80)).toEqual([]);
  });

  it("renders a concrete header, reason label, message, and recommendation", () => {
    const items = [
      {
        id: "att-1",
        sessionId: "sess-test-1234567890",
        reason: "stuck" as const,
        message: "No progress detected",
        recommendedAction: "Inspect and retry",
        timestamp: new Date("2026-03-08T12:34:56.000Z").toISOString(),
      },
    ];

    const lines = renderAttentionQueue(items, 80).map((line) => stripAnsi(line));

    expect(lines).toEqual([
      "⚠ Attention (1)",
      "  sess-test-12  stuck: No progress detected",
      "  → Inspect and retry",
      "",
    ]);
  });
});

describe("renderMonitorDetailView", () => {
  it("returns a padded fallback when no registry is available", () => {
    const lines = renderMonitorDetailView(undefined, 80, 10, makeViewState({ mode: "monitor-detail" }));

    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("  No monitor registry available.");
  });

  it("returns a padded fallback when the selected session does not exist", () => {
    const registry = makeRegistry();
    const lines = renderMonitorDetailView(registry, 80, 10, makeViewState({ mode: "monitor-detail", monitorSelectedIndex: 5 }));

    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("  Session not found.");
    registry.dispose();
  });

  it("renders the detail header, health summary, and recent event history for the selected session", () => {
    const registry = makeRegistry();
    const sessionId = startSession(registry, "sess-detail", "Detail Session");
    registry.store.update(sessionId, {
      events: [
        {
          type: "session.start",
          timestamp: new Date("2026-03-08T12:00:00.000Z").toISOString(),
          data: { agentName: "Detail Session" },
        },
        {
          type: "tool.call",
          timestamp: new Date("2026-03-08T12:01:00.000Z").toISOString(),
          data: { type: "tool.call", toolName: "bash" },
        },
        {
          type: "session.error",
          timestamp: new Date("2026-03-08T12:02:00.000Z").toISOString(),
          data: { type: "session.error", message: "needs operator review", fatal: false },
        },
      ],
    });

    registry.healthMonitor["signalHistory"].set(sessionId, {
      lastHeartbeatAt: Date.now() - 40_000,
      lastOutputAt: Date.now() - 40_000,
      lastToolActivityAt: Date.now() - 40_000,
      waiting: false,
      waitingReason: undefined,
      waitingAt: undefined,
      retryCount: 0,
    });
    registry.healthMonitor["trackedSessionState"].set(sessionId, {
      state: "degraded",
      repeatCount: 1,
      historyCount: 3,
    });
    registry.healthMonitor.checkHealth(sessionId);

    const lines = renderMonitorDetailView(
      registry,
      120,
      20,
      makeViewState({ mode: "monitor-detail", monitorSelectedIndex: 0 }),
    ).map((line) => stripAnsi(line));

    expect(lines[0]).toContain("── Session Detail");
    expect(lines[1]).toContain("Agent: Detail Session");
    expect(lines[1]).toContain("Status: active");
    expect(lines[1]).toContain("Health: degraded");
    expect(lines).toContain("Health summary: Session has been stale for 40s with no recent output.");
    expect(lines).toContain("repeat 2 · history 3");
    expect(lines).toContain("Action: Check whether the worker is blocked on a slow tool or loop.");
    expect(lines.some((line) => line.includes("🚀 START"))).toBe(true);
    expect(lines.some((line) => line.includes("🛠 TOOL") && line.includes("Running bash"))).toBe(true);
    expect(lines.some((line) => line.includes("❗ ERROR") && line.includes("needs operator review"))).toBe(true);

    registry.dispose();
  });
});
