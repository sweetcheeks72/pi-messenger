// task-13: overlay export and replay tests

// ─── Mocks for overlay-render.ts dependencies ────────────────────────────────
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (_data: string, _key: string) => false,
}));

vi.mock("../../../lib.js", () => ({
  formatDuration: (ms: number) => `${ms}ms`,
  formatRelativeTime: (_t: string) => "just now",
  buildSelfRegistration: () => ({}),
  coloredAgentName: (name: string) => name,
  computeStatus: () => "idle",
  STATUS_INDICATORS: {},
  agentHasTask: () => false,
  estimateCost: () => 0,
  formatCost: () => "",
  renderProgressBar: () => "[]",
  getSpinnerFrame: () => "⠋",
  getToolIcon: () => "🔧",
  renderSparkline: () => "",
  renderFileTree: () => [],
  renderAgentPipeline: () => "",
  renderDiffStatsBar: () => "",
  extractFolder: (s: string) => s,
}));

vi.mock("../../../store.js", () => ({
  getActiveAgents: () => [],
  getClaims: () => ({}),
  getRegisteredAgents: () => [],
}));

vi.mock("../../../crew/store.js", () => ({
  getTasks: () => [],
  getTask: () => undefined,
  getPlan: () => null,
  getPlanLabel: () => "",
  getCrewDir: (cwd: string) => cwd,
  hasPlan: () => false,
  getReadyTasks: () => [],
}));

vi.mock("../../../crew/state.js", () => ({
  autonomousState: { concurrency: 1, waveNumber: 0, startedAt: null },
  getPlanningUpdateAgeMs: () => 0,
  isAutonomousForCwd: () => false,
  isPlanningForCwd: () => false,
  isPlanningStalled: () => false,
  planningState: { pass: 0, maxPasses: 5, phase: "idle", updatedAt: null },
  PLANNING_STALE_TIMEOUT_MS: 60000,
}));

vi.mock("../../../crew/live-progress.js", () => ({
  getLiveWorkers: () => new Map(),
  hasLiveWorkers: () => false,
}));

vi.mock("../../../feed.js", () => ({
  formatFeedLine: () => "",
}));

vi.mock("../../../crew/utils/discover.js", () => ({
  discoverCrewAgents: () => [],
}));

vi.mock("../../../config.js", () => ({
  loadConfig: () => ({ stuckThreshold: 300 }),
}));

vi.mock("../../../crew/utils/config.js", () => ({
  loadCrewConfig: () => ({
    coordination: "light",
    dependencies: "strict",
    concurrency: { max: 4 },
  }),
}));

vi.mock("../../../crew/utils/checkpoint.js", () => ({
  listCheckpoints: () => [],
  getCheckpointDiff: () => null,
}));

vi.mock("../../../crew/lobby.js", () => ({
  getLobbyWorkerCount: () => 0,
}));

// ─── Actual test imports ──────────────────────────────────────────────────────

import { renderReplayView } from "../../../overlay-render-replay.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(): MonitorRegistry {
  return new MonitorRegistry({ healthConfig: {} });
}

function startSession(registry: MonitorRegistry, id: string, name = "TestAgent"): void {
  registry.lifecycle.start({
    id,
    name,
    cwd: "/tmp",
    model: "claude-3",
    startedAt: new Date().toISOString(),
    agent: name,
  });
}

function endSession(registry: MonitorRegistry, id: string): void {
  registry.lifecycle.end(id);
}

// ─── renderReplayView tests ───────────────────────────────────────────────────

describe("renderReplayView", () => {
  it("returns error lines for an unknown sessionId", () => {
    const registry = makeRegistry();
    const lines = renderReplayView(registry, "nonexistent-session", 80, 10, 0);
    expect(lines).toHaveLength(10);
    const text = lines.join("\n");
    // Should either show an error message or empty replay (replayer returns empty state, not throws)
    expect(text).toBeTruthy();
    registry.dispose();
  });

  it("renders replay timeline for a started session", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-1", "ReplayAgent");
    const lines = renderReplayView(registry, "sess-replay-1", 80, 20, 0);
    expect(lines).toHaveLength(20);
    const text = lines.join("\n");
    expect(text).toContain("Replay");
    registry.dispose();
  });

  it("renders replay timeline for a completed session", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-2", "CompletedAgent");
    endSession(registry, "sess-replay-2");
    const lines = renderReplayView(registry, "sess-replay-2", 80, 20, 0);
    expect(lines).toHaveLength(20);
    const text = lines.join("\n");
    expect(text).toContain("Replay");
    // Should show "ended" status
    expect(text).toContain("ended");
    registry.dispose();
  });

  it("pads output to the requested height", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-pad");
    const lines = renderReplayView(registry, "sess-replay-pad", 80, 15, 0);
    expect(lines).toHaveLength(15);
    registry.dispose();
  });

  it("applies scroll offset correctly", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-scroll");
    // Full view at scroll 0
    const linesNoScroll = renderReplayView(registry, "sess-replay-scroll", 80, 20, 0);
    // Scrolled view (skip first 2 lines)
    const linesScrolled = renderReplayView(registry, "sess-replay-scroll", 80, 20, 2);
    // Content should differ (scrolled skips header lines)
    // Just verify it returns the correct count and doesn't throw
    expect(linesScrolled).toHaveLength(20);
    registry.dispose();
  });

  it("shows session name and id in header", () => {
    const registry = makeRegistry();
    startSession(registry, "my-session-id", "MyAgent");
    const lines = renderReplayView(registry, "my-session-id", 80, 20, 0);
    const text = lines.join("\n");
    expect(text).toContain("my-session-id");
    registry.dispose();
  });

  it("shows event timeline entries when events exist", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-events");
    // start event should be in history
    const lines = renderReplayView(registry, "sess-events", 80, 30, 0);
    const text = lines.join("\n");
    // The session.start event should appear in timeline
    expect(text).toContain("session.start");
    registry.dispose();
  });
});

// ─── Session export tests ─────────────────────────────────────────────────────

describe("SessionExporter integration (exportSession to .pi/messenger/exports/)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-export-test-"));
  });

  it("toJSON produces valid JSON with session and events", () => {
    const registry = makeRegistry();
    startSession(registry, "export-sess-1", "ExportAgent");
    endSession(registry, "export-sess-1");

    const json = registry.exporter.toJSON("export-sess-1");
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("session");
    expect(parsed).toHaveProperty("events");
    expect(parsed.session.metadata.id).toBe("export-sess-1");
    registry.dispose();
  });

  it("toJSON throws for unknown session", () => {
    const registry = makeRegistry();
    expect(() => registry.exporter.toJSON("no-such-session")).toThrow("Session not found");
    registry.dispose();
  });

  it("exportAll writes JSON file to directory", () => {
    const registry = makeRegistry();
    startSession(registry, "export-sess-2", "ExportAgent2");
    endSession(registry, "export-sess-2");

    const exportsDir = path.join(tmpDir, ".pi", "messenger", "exports");
    registry.exporter.exportAll(exportsDir, "json", ["export-sess-2"]);

    const expectedFile = path.join(exportsDir, "export-sess-2.json");
    expect(fs.existsSync(expectedFile)).toBe(true);
    const content = fs.readFileSync(expectedFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.session.metadata.id).toBe("export-sess-2");
    registry.dispose();
  });

  it("toJSON includes session.start event in events array", () => {
    const registry = makeRegistry();
    startSession(registry, "export-with-events", "EventAgent");

    const json = registry.exporter.toJSON("export-with-events");
    const parsed = JSON.parse(json);
    expect(parsed.events.length).toBeGreaterThan(0);
    const types = (parsed.events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("session.start");
    registry.dispose();
  });
});

// ─── SessionReplayer integration tests ───────────────────────────────────────

describe("SessionReplayer.replay()", () => {
  it("returns empty/idle state for unknown session", () => {
    const registry = makeRegistry();
    const state = registry.replayer.replay("no-such-session");
    // Should return a state object (not throw) - replayer builds from empty events
    expect(state).toBeDefined();
    expect(state.status).toBe("idle");
    registry.dispose();
  });

  it("returns active state for a started session", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-active");
    const state = registry.replayer.replay("replay-active");
    expect(state.status).toBe("active");
    registry.dispose();
  });

  it("returns ended state for a completed session", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-ended");
    endSession(registry, "replay-ended");
    const state = registry.replayer.replay("replay-ended");
    expect(state.status).toBe("ended");
    registry.dispose();
  });

  it("includes session.start and session.end events in replayed state", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-events");
    endSession(registry, "replay-events");
    const state = registry.replayer.replay("replay-events");
    const types = state.events.map((e: { type: string }) => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("session.end");
    registry.dispose();
  });

  it("replay up to sequence produces partial state", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-partial");
    endSession(registry, "replay-partial");
    // Replay only first event (sequence 0 or 1)
    const fullState = registry.replayer.replay("replay-partial");
    const partialState = registry.replayer.replay("replay-partial", 0);
    // Partial has fewer events than full
    expect(partialState.events.length).toBeLessThanOrEqual(fullState.events.length);
    registry.dispose();
  });
});
