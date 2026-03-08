import { describe, expect, it } from "vitest";
import {
  SessionMetadataSchema,
  buildWorkerSessionMetadata,
} from "../../../src/monitor/types/session.js";
import type { LiveWorkerInfo } from "../../../crew/live-progress.js";

describe("SessionMetadataSchema crew fields", () => {
  it("accepts optional crew worker fields", () => {
    const metadata = SessionMetadataSchema.parse({
      id: "task-2",
      name: "FastNova",
      cwd: "/tmp/project",
      model: "anthropic/claude-haiku-4-5",
      startedAt: "2026-03-08T03:35:16.816Z",
      agent: "crew-worker",
      taskId: "task-2",
      workerPid: 1234,
      agentRole: "crew-worker",
    });

    expect(metadata.taskId).toBe("task-2");
    expect(metadata.workerPid).toBe(1234);
    expect(metadata.agentRole).toBe("crew-worker");
  });

  it("builds session metadata from a live worker snapshot", () => {
    const worker: LiveWorkerInfo = {
      cwd: "/tmp/project",
      taskId: "task-2",
      agent: "crew-worker",
      name: "FastNova",
      startedAt: Date.UTC(2026, 2, 8, 3, 35, 16, 816),
      progress: {
        agent: "crew-worker",
        status: "running",
        recentTools: [],
        toolCallCount: 1,
        tokens: 24,
        durationMs: 1000,
        filesModified: [],
        toolCallBuckets: [],
        model: "anthropic/claude-haiku-4-5",
      },
    };

    const metadata = buildWorkerSessionMetadata(worker);
    expect(metadata.id).toBe("task-2");
    expect(metadata.name).toBe("FastNova");
    expect(metadata.taskId).toBe("task-2");
    expect(metadata.model).toBe("anthropic/claude-haiku-4-5");
  });
});
