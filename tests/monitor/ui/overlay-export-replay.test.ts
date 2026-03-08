import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (_data: string, _key: string) => false,
}));

import { renderReplayView } from "../../../overlay-render-replay.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";
import { stripAnsi } from "../../../src/monitor/ui/render.js";

function makeRegistry(): MonitorRegistry {
  return new MonitorRegistry({ healthConfig: {} });
}

function startSession(registry: MonitorRegistry, id: string, name = "TestAgent"): void {
  registry.lifecycle.start({
    id,
    name,
    cwd: "/tmp/project",
    model: "claude-3",
    startedAt: new Date("2026-03-08T12:00:00.000Z").toISOString(),
    agent: name,
  });
}

function endSession(registry: MonitorRegistry, id: string, summary = "done"): void {
  registry.lifecycle.end(id, summary);
}

describe("renderReplayView", () => {
  it("renders an idle replay header and empty-state timeline for an unknown session", () => {
    const registry = makeRegistry();
    const lines = renderReplayView(registry, "nonexistent-session", 80, 10, 0);
    const text = stripAnsi(lines.join("\n"));

    expect(lines).toHaveLength(10);
    expect(text).toContain("── Replay: unknown");
    expect(text).toContain("(nonexistent-session)");
    expect(text).toContain("Status: idle");
    expect(text).toContain("Events: 0");
    expect(text).toContain("(no events recorded)");
    registry.dispose();
  });

  it("renders replay timeline entries for a started session", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-1", "ReplayAgent");

    const lines = renderReplayView(registry, "sess-replay-1", 80, 20, 0);
    const text = stripAnsi(lines.join("\n"));

    expect(lines).toHaveLength(20);
    expect(text).toContain("── Replay: ReplayAgent");
    expect(text).toContain("Status: active");
    expect(text).toContain("Events: 1");
    expect(text).toContain("session.start");
    registry.dispose();
  });

  it("renders ended status and both lifecycle events for a completed session", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-2", "CompletedAgent");
    endSession(registry, "sess-replay-2", "completed successfully");

    const text = stripAnsi(renderReplayView(registry, "sess-replay-2", 80, 20, 0).join("\n"));

    expect(text).toContain("── Replay: CompletedAgent");
    expect(text).toContain("Status: ended");
    expect(text).toContain("Events: 2");
    expect(text).toContain("session.start");
    expect(text).toContain("session.end");
    registry.dispose();
  });

  it("pads output to the requested height", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-pad");

    const lines = renderReplayView(registry, "sess-replay-pad", 80, 15, 0);

    expect(lines).toHaveLength(15);
    expect(lines.at(-1)).toBe("");
    registry.dispose();
  });

  it("applies scroll offset by dropping the replay header lines", () => {
    const registry = makeRegistry();
    startSession(registry, "sess-replay-scroll", "ScrollAgent");
    endSession(registry, "sess-replay-scroll");

    const linesNoScroll = renderReplayView(registry, "sess-replay-scroll", 80, 20, 0);
    const linesScrolled = renderReplayView(registry, "sess-replay-scroll", 80, 20, 2);

    expect(stripAnsi(linesNoScroll[0])).toContain("── Replay: ScrollAgent");
    expect(stripAnsi(linesScrolled[0])).toContain("Agent:");
    expect(stripAnsi(linesScrolled.join("\n"))).not.toContain("── Replay: ScrollAgent");
    registry.dispose();
  });

  it("shows the session id in the replay header", () => {
    const registry = makeRegistry();
    startSession(registry, "my-session-id", "MyAgent");

    const text = stripAnsi(renderReplayView(registry, "my-session-id", 80, 20, 0).join("\n"));

    expect(text).toContain("(my-session-id)");
    expect(text).toContain("Agent:");
    registry.dispose();
  });
});

describe("SessionExporter integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-export-test-"));
  });

  it("toJSON produces concrete session metadata and lifecycle events", () => {
    const registry = makeRegistry();
    startSession(registry, "export-sess-1", "ExportAgent");
    endSession(registry, "export-sess-1");

    const parsed = JSON.parse(registry.exporter.toJSON("export-sess-1"));

    expect(parsed.session.metadata).toMatchObject({
      id: "export-sess-1",
      name: "ExportAgent",
      agent: "ExportAgent",
      cwd: "/tmp/project",
      model: "claude-3",
    });
    expect(parsed.events.map((event: { type: string }) => event.type)).toEqual([
      "session.start",
      "session.end",
    ]);
    registry.dispose();
  });

  it("toJSON throws for unknown sessions", () => {
    const registry = makeRegistry();
    expect(() => registry.exporter.toJSON("no-such-session")).toThrow("Session not found");
    registry.dispose();
  });

  it("exportAll writes the requested session JSON to disk", () => {
    const registry = makeRegistry();
    startSession(registry, "export-sess-2", "ExportAgent2");
    endSession(registry, "export-sess-2");

    const exportsDir = path.join(tmpDir, ".pi", "messenger", "exports");
    registry.exporter.exportAll(exportsDir, "json", ["export-sess-2"]);

    const expectedFile = path.join(exportsDir, "export-sess-2.json");
    const parsed = JSON.parse(fs.readFileSync(expectedFile, "utf-8"));

    expect(fs.existsSync(expectedFile)).toBe(true);
    expect(parsed.session.metadata.id).toBe("export-sess-2");
    expect(parsed.events.map((event: { type: string }) => event.type)).toEqual([
      "session.start",
      "session.end",
    ]);
    registry.dispose();
  });
});

describe("SessionReplayer.replay", () => {
  it("returns an idle state with unknown metadata for an unknown session", () => {
    const registry = makeRegistry();
    const state = registry.replayer.replay("no-such-session");

    expect(state).toMatchObject({
      status: "idle",
      metadata: {
        id: "no-such-session",
        name: "unknown",
        agent: "unknown",
        model: "unknown",
      },
      metrics: {
        eventCount: 0,
        errorCount: 0,
        toolCalls: 0,
      },
    });
    expect(state.events).toEqual([]);
    registry.dispose();
  });

  it("projects live history into replayed metrics and event ordering", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-live-history", "ReplayAgent");
    registry.emitter.emit({
      id: "tool-1",
      type: "tool.call",
      sessionId: "replay-live-history",
      timestamp: Date.parse("2026-03-08T12:00:05.000Z"),
      sequence: 0,
      payload: { type: "tool.call", toolName: "bash" },
    });
    registry.emitter.emit({
      id: "tool-2",
      type: "tool.call",
      sessionId: "replay-live-history",
      timestamp: Date.parse("2026-03-08T12:00:10.000Z"),
      sequence: 0,
      payload: { type: "tool.call", toolName: "grep" },
    });
    endSession(registry, "replay-live-history");

    const state = registry.replayer.replay("replay-live-history");

    expect(state.status).toBe("ended");
    expect(state.metrics).toMatchObject({
      eventCount: 4,
      errorCount: 0,
      toolCalls: 2,
    });
    expect(state.events.map((event) => event.type)).toEqual([
      "session.start",
      "tool.call",
      "tool.call",
      "session.end",
    ]);
    expect(state.events[1]).toMatchObject({
      type: "tool.call",
      data: { type: "tool.call", toolName: "bash" },
    });
    expect(state.events[2]).toMatchObject({
      type: "tool.call",
      data: { type: "tool.call", toolName: "grep" },
    });
    registry.dispose();
  });

  it("replay up to a sequence projects a partial lifecycle state", () => {
    const registry = makeRegistry();
    startSession(registry, "replay-partial", "PartialAgent");
    registry.emitter.emit({
      id: "tool-partial",
      type: "tool.call",
      sessionId: "replay-partial",
      timestamp: Date.parse("2026-03-08T12:00:05.000Z"),
      sequence: 0,
      payload: { type: "tool.call", toolName: "read" },
    });
    endSession(registry, "replay-partial", "finished");

    const fullState = registry.replayer.replay("replay-partial");
    const partialState = registry.replayer.replay("replay-partial", 1);

    expect(fullState.status).toBe("ended");
    expect(fullState.events.map((event) => event.type)).toEqual([
      "session.start",
      "tool.call",
      "session.end",
    ]);
    expect(partialState.status).toBe("active");
    expect(partialState.events.map((event) => event.type)).toEqual([
      "session.start",
      "tool.call",
    ]);
    expect(partialState.metrics).toMatchObject({ eventCount: 2, toolCalls: 1 });
    registry.dispose();
  });
});
