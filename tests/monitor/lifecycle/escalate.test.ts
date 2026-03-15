/**
 * SessionLifecycleManager.escalate() — targeted FSM and event tests.
 *
 * Verifies that escalate:
 *   1. Uses the FSM transition (active → error) rather than bypassing it.
 *   2. Emits a "session.error" event with appropriate payload.
 *   3. Throws for invalid source states (e.g. already-ended session).
 */

import { describe, it, expect } from "vitest";
import { SessionLifecycleManager } from "../../../src/monitor/lifecycle/manager.js";
import { OperatorCommandHandler } from "../../../src/monitor/commands/handler.js";

function makeMetadata(id: string) {
  return {
    id,
    name: "Escalate Test",
    cwd: "/tmp",
    model: "test-model",
    startedAt: new Date().toISOString(),
    agent: "test-agent",
  };
}

describe("SessionLifecycleManager.escalate()", () => {
  it("transitions active → error via the FSM", () => {
    const lifecycle = new SessionLifecycleManager();
    const id = lifecycle.start(makeMetadata("esc-1"));
    expect(lifecycle.getState(id)).toBe("active");

    lifecycle.escalate(id);

    expect(lifecycle.getState(id)).toBe("error");
  });

  it("emits a session.error event when escalated", () => {
    const lifecycle = new SessionLifecycleManager();
    const id = lifecycle.start(makeMetadata("esc-2"));

    const emitted: string[] = [];
    lifecycle.getEmitter().subscribe((e) => {
      emitted.push(e.type);
    });

    lifecycle.escalate(id, "stuck for too long");

    expect(emitted).toContain("session.error");
  });

  it("session.error event carries the escalation reason", () => {
    const lifecycle = new SessionLifecycleManager();
    const id = lifecycle.start(makeMetadata("esc-3"));

    const errorEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    lifecycle.getEmitter().subscribe((e) => {
      if (e.type === "session.error") {
        errorEvents.push({ type: e.type, payload: e.payload as Record<string, unknown> });
      }
    });

    lifecycle.escalate(id, "critical task failure");

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload["message"]).toContain("critical task failure");
  });

  it("throws when escalating a session that does not exist", () => {
    const lifecycle = new SessionLifecycleManager();
    expect(() => lifecycle.escalate("ghost-session")).toThrow("not found");
  });

  it("throws for invalid FSM transition (ended → error is disallowed)", () => {
    const lifecycle = new SessionLifecycleManager();
    const id = lifecycle.start(makeMetadata("esc-5"));
    lifecycle.end(id);

    // ended → error is NOT in the FSM transition table
    expect(() => lifecycle.escalate(id)).toThrow(/invalid.*transition/i);
  });

  it("error state allows only 'ended' as the next valid transition", () => {
    const lifecycle = new SessionLifecycleManager();
    const id = lifecycle.start(makeMetadata("esc-6"));
    lifecycle.escalate(id);

    // Should be able to end from error
    expect(() => lifecycle.end(id)).not.toThrow();
    expect(lifecycle.getState(id)).toBe("ended");
  });
});

describe("OperatorCommandHandler escalate — goes through lifecycle FSM", () => {
  it("escalate command transitions session to error state via FSM (not a raw store update)", () => {
    const lifecycle = new SessionLifecycleManager();
    const handler = new OperatorCommandHandler(lifecycle);
    const id = lifecycle.start({
      name: "Cmd Esc Test",
      cwd: "/tmp",
      model: "test-model",
      agent: "test-agent",
    });

    const errorEvents: string[] = [];
    lifecycle.getEmitter().subscribe((e) => {
      if (e.type === "session.error") errorEvents.push(e.sessionId);
    });

    const result = handler.execute({ action: "escalate", sessionId: id, reason: "review needed" });

    expect(result.success).toBe(true);
    const state = result.result as { status: string };
    expect(state.status).toBe("error");
    // Confirm a session.error event was emitted (FSM path, not raw update)
    expect(errorEvents).toContain(id);
  });

  it("escalate on nonexistent session returns success=false", () => {
    const lifecycle = new SessionLifecycleManager();
    const handler = new OperatorCommandHandler(lifecycle);

    const result = handler.execute({ action: "escalate", sessionId: "ghost" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("escalate on already-ended session returns success=false (FSM rejects it)", () => {
    const lifecycle = new SessionLifecycleManager();
    const handler = new OperatorCommandHandler(lifecycle);
    const id = lifecycle.start({
      name: "Ended Esc Test",
      cwd: "/tmp",
      model: "test-model",
      agent: "test-agent",
    });
    lifecycle.end(id);

    const result = handler.execute({ action: "escalate", sessionId: id });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/transition/i);
  });
});
