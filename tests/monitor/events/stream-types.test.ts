import { describe, expect, it } from "vitest";
import {
  GroupedEventSchema,
  SessionStreamEventSchema,
} from "../../../src/monitor/events/index.js";

describe("SessionStreamEventSchema", () => {
  it("derives lane and severity for health alerts", () => {
    const event = SessionStreamEventSchema.parse({
      id: "stream-1",
      type: "health.alert",
      source: "health-monitor",
      sessionId: "sess-1",
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "health.alert",
        severity: "critical",
        message: "Session has been stuck for 120s",
      },
      summary: "Session has been stuck for 120s",
      diagnostic: {
        code: "stuck",
        severity: "critical",
        fingerprint: "abc123",
        dedupeKey: "stuck:SessionHealthMonitor",
      },
    });

    expect(event.lane).toBe("diagnostic");
    expect(event.severity).toBe("critical");
    expect(event.diagnostic?.repeatCount).toBe(1);
  });
});

describe("GroupedEventSchema", () => {
  it("defaults count to the number of grouped events", () => {
    const group = GroupedEventSchema.parse({
      category: "tool",
      events: [
        {
          id: "evt-1",
          type: "tool.call",
          sessionId: "sess-1",
          timestamp: Date.now(),
          sequence: 1,
          payload: { type: "tool.call", toolName: "bash" },
        },
      ],
    });

    expect(group.count).toBe(1);
  });
});
