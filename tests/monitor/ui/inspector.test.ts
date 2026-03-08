import { describe, it, expect } from "vitest";
import { renderSessionInspector } from "../../../src/monitor/ui/inspector.js";
import type { SessionState } from "../../../src/monitor/types/session.js";

describe("Session Inspector", () => {
  it("renders a basic active session correctly", () => {
    const session: SessionState = {
      status: "active",
      metadata: {
        id: "sess-123",
        name: "Test Session",
        cwd: "/tmp",
        model: "gpt-4",
        startedAt: "2026-03-08T00:00:00.000Z",
        agent: "TestAgent",
      },
      metrics: {
        duration: 5000,
        eventCount: 2,
        errorCount: 0,
        toolCalls: 1,
        tokensUsed: 100,
      },
      events: [
        {
          type: "session.start",
          timestamp: "2026-03-08T00:00:00.000Z",
          data: { task: "fix bugs" }
        },
        {
          type: "tool.call",
          timestamp: "2026-03-08T00:00:05.000Z",
          data: { toolName: "ls" }
        }
      ]
    };

    const lines = renderSessionInspector(session, "healthy", undefined, 80);
    
    // Check header
    expect(lines.some(l => l.includes("Session Inspector") && l.includes("Test Session"))).toBe(true);
    // Check health & status
    expect(lines.some(l => l.includes("active") && l.includes("healthy"))).toBe(true);
    // Check extracted task
    expect(lines.some(l => l.includes("Task:") && l.includes("fix bugs"))).toBe(true);
    // Check extracted tool
    expect(lines.some(l => l.includes("Last Tool:") && l.includes("ls"))).toBe(true);
  });
});
