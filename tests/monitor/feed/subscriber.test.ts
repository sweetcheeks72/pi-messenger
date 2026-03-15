import { describe, it, expect, beforeEach } from "vitest";
import { SessionEventEmitter, createSessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import { SessionFeedSubscriber, createSessionFeedSubscriber } from "../../../src/monitor/feed/subscriber.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: overrides.id ?? "evt-" + Math.random().toString(36).slice(2),
    type: overrides.type ?? "session.start",
    sessionId: overrides.sessionId ?? "sess-1",
    timestamp: overrides.timestamp ?? Date.now(),
    sequence: overrides.sequence ?? 0,
    payload: overrides.payload ?? {
      type: "session.start",
      agentName: "test-agent",
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionFeedSubscriber", () => {
  let emitter: SessionEventEmitter;
  let subscriber: SessionFeedSubscriber;

  beforeEach(() => {
    emitter = createSessionEventEmitter();
    subscriber = new SessionFeedSubscriber(emitter, { bufferSize: 10 });
  });

  // 1. Subscribe and receive events
  it("receives events after subscribe()", () => {
    subscriber.subscribe();
    emitter.emit(makeEvent({ id: "e1" }));
    emitter.emit(makeEvent({ id: "e2" }));

    const buf = subscriber.getBuffer();
    expect(buf).toHaveLength(2);
    expect(buf[0].id).toBe("e1");
    expect(buf[1].id).toBe("e2");
  });

  // 2. Does not receive events before subscribe()
  it("does not buffer events emitted before subscribe()", () => {
    emitter.emit(makeEvent({ id: "e-pre" }));
    subscriber.subscribe();
    emitter.emit(makeEvent({ id: "e-post" }));

    const buf = subscriber.getBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0].id).toBe("e-post");
  });

  // 3. Buffer overflow — ring buffer wraps around
  it("respects bufferSize and overwrites oldest events on overflow", () => {
    subscriber = new SessionFeedSubscriber(emitter, { bufferSize: 3 });
    subscriber.subscribe();

    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ id: `e${i}` }));
    }

    const buf = subscriber.getBuffer();
    expect(buf).toHaveLength(3);
    // Should contain the 3 most recent: e2, e3, e4
    expect(buf.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  // 4. getOffset() increments with each received event
  it("getOffset() returns total events received", () => {
    subscriber.subscribe();
    expect(subscriber.getOffset()).toBe(0);

    emitter.emit(makeEvent());
    expect(subscriber.getOffset()).toBe(1);

    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    expect(subscriber.getOffset()).toBe(3);
  });

  // 5. replayFrom(0) returns all buffered events
  it("replayFrom(0) returns the full buffer", () => {
    subscriber.subscribe();
    emitter.emit(makeEvent({ id: "e0" }));
    emitter.emit(makeEvent({ id: "e1" }));
    emitter.emit(makeEvent({ id: "e2" }));

    const replayed = subscriber.replayFrom(0);
    expect(replayed).toHaveLength(3);
    expect(replayed.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
  });

  // 6. replayFrom(offset) returns only events from that offset onward
  it("replayFrom(offset) returns events from offset to head", () => {
    subscriber.subscribe();
    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ id: `e${i}` }));
    }

    const replayed = subscriber.replayFrom(2);
    expect(replayed.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  // 7. replayFrom() beyond offset returns empty array
  it("replayFrom(offset) returns [] when offset >= current offset", () => {
    subscriber.subscribe();
    emitter.emit(makeEvent());
    emitter.emit(makeEvent());

    expect(subscriber.replayFrom(2)).toEqual([]);
    expect(subscriber.replayFrom(100)).toEqual([]);
  });

  // 8. replayFrom() with overflow — partial history
  it("replayFrom handles offset that fell off the buffer", () => {
    subscriber = new SessionFeedSubscriber(emitter, { bufferSize: 3 });
    subscriber.subscribe();

    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ id: `e${i}` }));
    }
    // Buffer holds e2, e3, e4. Offset=5. bufferStart=2.
    // replayFrom(0) should return what's available (e2,e3,e4)
    const replayed = subscriber.replayFrom(0);
    expect(replayed.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  // 9. unsubscribe stops receiving events
  it("stops buffering after unsubscribe()", () => {
    subscriber.subscribe();
    emitter.emit(makeEvent({ id: "before" }));
    subscriber.unsubscribe();
    emitter.emit(makeEvent({ id: "after" }));

    const buf = subscriber.getBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0].id).toBe("before");
  });

  // 10. unsubscribe() is idempotent
  it("unsubscribe() can be called multiple times safely", () => {
    subscriber.subscribe();
    emitter.emit(makeEvent());
    subscriber.unsubscribe();
    subscriber.unsubscribe(); // should not throw
    expect(subscriber.getBuffer()).toHaveLength(1);
  });

  // 11. onEvent handler is called for each event
  it("onEvent() handler fires for each buffered event", () => {
    subscriber.subscribe();
    const received: SessionEvent[] = [];
    subscriber.onEvent((e) => received.push(e));

    emitter.emit(makeEvent({ id: "h1" }));
    emitter.emit(makeEvent({ id: "h2" }));

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.id)).toEqual(["h1", "h2"]);
  });

  // 12. onEvent() removal function works
  it("onEvent() returns a removal function that stops the handler", () => {
    subscriber.subscribe();
    const received: SessionEvent[] = [];
    const remove = subscriber.onEvent((e) => received.push(e));

    emitter.emit(makeEvent({ id: "before-remove" }));
    remove();
    emitter.emit(makeEvent({ id: "after-remove" }));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("before-remove");
  });

  // 13. concurrent subscribers — independent ring buffers
  it("two subscribers on the same emitter maintain independent buffers", () => {
    const subA = new SessionFeedSubscriber(emitter, { bufferSize: 5 });
    const subB = new SessionFeedSubscriber(emitter, { bufferSize: 3 });

    subA.subscribe();
    subB.subscribe();

    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ id: `e${i}` }));
    }

    expect(subA.getBuffer()).toHaveLength(5);
    expect(subA.getBuffer().map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);

    expect(subB.getBuffer()).toHaveLength(3);
    expect(subB.getBuffer().map((e) => e.id)).toEqual(["e2", "e3", "e4"]);

    subA.unsubscribe();
    subB.unsubscribe();
  });

  // 14. createSessionFeedSubscriber factory subscribes automatically
  it("createSessionFeedSubscriber() is already subscribed on return", () => {
    const sub = createSessionFeedSubscriber(emitter, { bufferSize: 5 });
    emitter.emit(makeEvent({ id: "factory-evt" }));

    expect(sub.getBuffer()).toHaveLength(1);
    expect(sub.getBuffer()[0].id).toBe("factory-evt");
    sub.unsubscribe();
  });

  // 15. subscribe() is idempotent — calling twice does not double-buffer events
  it("subscribe() is idempotent — calling twice does not double-buffer", () => {
    subscriber.subscribe();
    subscriber.subscribe(); // second call should be a no-op

    emitter.emit(makeEvent({ id: "single" }));

    expect(subscriber.getBuffer()).toHaveLength(1);
    expect(subscriber.getOffset()).toBe(1);
  });
});
