import { describe, it, expect } from "vitest";
import {
  EventTypeSchema,
  SessionEventSchema,
  SessionEventPayloadSchema,
  StreamConfigSchema,
  SessionStartPayloadSchema,
  SessionErrorPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  HealthCheckPayloadSchema,
  HealthAlertPayloadSchema,
  MetricsSnapshotPayloadSchema,
} from "../../../src/monitor/events/index.js";

describe("EventTypeSchema", () => {
  it("parses all valid event types", () => {
    const types = [
      "session.start",
      "session.pause",
      "session.resume",
      "session.end",
      "session.error",
      "tool.call",
      "tool.result",
      "operator.action",
      "health.check",
      "health.alert",
      "metrics.snapshot",
    ];
    for (const t of types) {
      expect(EventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects unknown event types", () => {
    expect(() => EventTypeSchema.parse("unknown.type")).toThrow();
  });
});

describe("SessionEventPayloadSchema — discriminated union", () => {
  it("parses session.start payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "session.start",
      agentName: "PurePhoenix",
      model: "claude-3-5-sonnet",
    });
    expect(result.type).toBe("session.start");
    if (result.type === "session.start") {
      expect(result.agentName).toBe("PurePhoenix");
    }
  });

  it("narrows payload type for session.error", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "session.error",
      message: "Something went wrong",
      fatal: true,
    });
    expect(result.type).toBe("session.error");
    if (result.type === "session.error") {
      expect(result.message).toBe("Something went wrong");
      expect(result.fatal).toBe(true);
    }
  });

  it("parses tool.call payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "tool.call",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(result.type).toBe("tool.call");
    if (result.type === "tool.call") {
      expect(result.toolName).toBe("bash");
    }
  });

  it("parses tool.result payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "tool.result",
      toolName: "bash",
      success: true,
      durationMs: 123,
    });
    expect(result.type).toBe("tool.result");
    if (result.type === "tool.result") {
      expect(result.success).toBe(true);
    }
  });

  it("parses health.check payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "health.check",
      status: "healthy",
      checks: { db: true, net: true },
    });
    expect(result.type).toBe("health.check");
    if (result.type === "health.check") {
      expect(result.status).toBe("healthy");
    }
  });

  it("parses health.alert payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "health.alert",
      severity: "critical",
      message: "Memory exceeded",
    });
    expect(result.type).toBe("health.alert");
    if (result.type === "health.alert") {
      expect(result.severity).toBe("critical");
    }
  });

  it("parses metrics.snapshot payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "metrics.snapshot",
      toolCallCount: 42,
      errorCount: 1,
      uptimeMs: 60000,
      memoryMb: 256,
    });
    expect(result.type).toBe("metrics.snapshot");
    if (result.type === "metrics.snapshot") {
      expect(result.toolCallCount).toBe(42);
    }
  });

  it("rejects payload with unknown type", () => {
    expect(() =>
      SessionEventPayloadSchema.parse({
        type: "unknown",
        data: "foo",
      })
    ).toThrow();
  });

  it("rejects session.error payload missing required message", () => {
    expect(() =>
      SessionErrorPayloadSchema.parse({
        type: "session.error",
        // message missing
      })
    ).toThrow();
  });
});

describe("SessionEventSchema", () => {
  it("parses a complete valid event", () => {
    const event = SessionEventSchema.parse({
      id: "evt-001",
      type: "session.start",
      sessionId: "sess-abc",
      timestamp: Date.now(),
      payload: {
        type: "session.start",
        agentName: "TestAgent",
      },
      sequence: 0,
    });
    expect(event.id).toBe("evt-001");
    expect(event.type).toBe("session.start");
    expect(event.sequence).toBe(0);
  });

  it("rejects event with negative sequence", () => {
    expect(() =>
      SessionEventSchema.parse({
        id: "evt-002",
        type: "session.end",
        sessionId: "sess-abc",
        timestamp: Date.now(),
        payload: { type: "session.end" },
        sequence: -1,
      })
    ).toThrow();
  });
});

describe("StreamConfigSchema", () => {
  it("applies default values when no config provided", () => {
    const config = StreamConfigSchema.parse({});
    expect(config.bufferSize).toBe(100);
    expect(config.replayFromOffset).toBe(0);
    expect(config.filterTypes).toEqual([]);
    expect(config.maxAge).toBeUndefined();
  });

  it("accepts custom values overriding defaults", () => {
    const config = StreamConfigSchema.parse({
      bufferSize: 500,
      replayFromOffset: 10,
      filterTypes: ["session.start", "session.end"],
      maxAge: 3600000,
    });
    expect(config.bufferSize).toBe(500);
    expect(config.replayFromOffset).toBe(10);
    expect(config.filterTypes).toEqual(["session.start", "session.end"]);
    expect(config.maxAge).toBe(3600000);
  });

  it("rejects bufferSize of 0 (must be positive)", () => {
    expect(() =>
      StreamConfigSchema.parse({ bufferSize: 0 })
    ).toThrow();
  });
});
