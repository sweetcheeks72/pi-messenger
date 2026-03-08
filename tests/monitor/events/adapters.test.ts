import { describe, expect, it } from "vitest";
import {
  groupRepeatedWarnings,
  mapHealthAlertToSessionStreamEvent,
  mapPiEventToSessionStreamEvent,
  mapWorkerSnapshotToSessionStreamEvent,
} from "../../../src/monitor/events/index.js";
import type { LiveWorkerInfo } from "../../../crew/live-progress.js";

describe("mapPiEventToSessionStreamEvent", () => {
  it("maps pi tool execution start into a tool stream event", () => {
    const event = mapPiEventToSessionStreamEvent(
      {
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "npm test" },
      },
      { sessionId: "sess-1", sequence: 3, timestamp: 1000 },
    );

    expect(event?.type).toBe("tool.call");
    expect(event?.lane).toBe("tool");
    expect(event?.source).toBe("pi-runtime");
    expect(event?.payload.type).toBe("tool.call");
    if (event?.payload.type === "tool.call") {
      expect(event.payload.toolName).toBe("bash");
    }
  });
});

describe("mapWorkerSnapshotToSessionStreamEvent", () => {
  it("maps queued workers into waiting events", () => {
    const worker: LiveWorkerInfo = {
      cwd: "/tmp/project",
      taskId: "task-2",
      agent: "crew-worker",
      name: "FastNova",
      startedAt: Date.now(),
      progress: {
        agent: "crew-worker",
        status: "pending",
        recentTools: [],
        toolCallCount: 0,
        tokens: 0,
        durationMs: 0,
        filesModified: [],
        toolCallBuckets: [],
      },
    };

    const event = mapWorkerSnapshotToSessionStreamEvent(worker, { timestamp: 2000 });
    expect(event.type).toBe("agent.waiting");
    expect(event.lane).toBe("waiting");
    expect(event.source).toBe("messenger-runtime");
  });
});

describe("groupRepeatedWarnings", () => {
  it("groups repeated stuck alerts instead of returning spammy duplicates", () => {
    const first = mapHealthAlertToSessionStreamEvent({
      sessionId: "sess-1",
      status: "critical",
      reason: "Session has been stuck for 120s",
      detectedAt: 10_000,
    });
    const second = mapHealthAlertToSessionStreamEvent({
      sessionId: "sess-1",
      status: "critical",
      reason: "Session has been stuck for 121s",
      detectedAt: 12_000,
    });

    const grouped = groupRepeatedWarnings([first, second], { withinMs: 10_000 });

    expect(grouped).toHaveLength(1);
    expect(grouped[0].grouping?.kind).toBe("repeat");
    expect(grouped[0].grouping?.count).toBe(2);
    expect(grouped[0].diagnostic?.repeatCount).toBe(2);
    expect(grouped[0].diagnostic?.code).toBe("stuck");
  });
});
