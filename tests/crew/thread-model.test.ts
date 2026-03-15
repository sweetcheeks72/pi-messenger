import { beforeEach, describe, expect, it } from "vitest";
import {
  populateThreadFields,
  getThread,
  getReplyCount,
  groupByThread,
  formatCollapseIndicator,
  formatReplyPrefix,
  shouldCollapse,
  renderThreadGroup,
} from "../../crew/thread-model.js";
import type { FeedEvent } from "../../feed.js";
import { appendFeedEvent, readFeedEvents } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import type { ThreadRenderOptions } from "../../crew/types.js";
import { DEFAULT_THREAD_RENDER_OPTIONS } from "../../crew/types.js";

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<FeedEvent> & { ts: string; agent: string; type: FeedEvent["type"] }): FeedEvent {
  return {
    ts: overrides.ts,
    agent: overrides.agent,
    type: overrides.type,
    target: overrides.target,
    preview: overrides.preview,
    threadId: overrides.threadId,
    parentEventTs: overrides.parentEventTs,
    replyCount: overrides.replyCount,
  };
}

function makeRootEvent(ts: string, agent: string, preview?: string): FeedEvent {
  return makeEvent({ ts, agent, type: "message", preview });
}

function makeReplyEvent(ts: string, agent: string, threadId: string, parentEventTs: string, preview?: string): FeedEvent {
  return makeEvent({ ts, agent, type: "message", preview, threadId, parentEventTs });
}

// =============================================================================
// populateThreadFields()
// =============================================================================

describe("populateThreadFields()", () => {
  it("sets threadId and parentEventTs when parent is a root event", () => {
    const parent = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Hello");
    const newEvent = makeEvent({
      ts: "2026-03-15T10:01:00.000Z",
      agent: "Bob",
      type: "message",
      preview: "Hi Alice!",
    });

    const result = populateThreadFields(newEvent, parent.ts, [parent]);

    expect(result.threadId).toBe(parent.ts);
    expect(result.parentEventTs).toBe(parent.ts);
    expect(result.preview).toBe("Hi Alice!");
  });

  it("preserves existing threadId when replying to a reply", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Thread root");
    const reply1 = makeReplyEvent(
      "2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "First reply",
    );
    const newEvent = makeEvent({
      ts: "2026-03-15T10:02:00.000Z",
      agent: "Charlie",
      type: "message",
      preview: "Reply to reply",
    });

    const result = populateThreadFields(newEvent, reply1.ts, [root, reply1]);

    // Should join the same thread as reply1 (the root's thread)
    expect(result.threadId).toBe(root.ts);
    expect(result.parentEventTs).toBe(reply1.ts);
  });

  it("returns the event unchanged when parent is not found", () => {
    const newEvent = makeEvent({
      ts: "2026-03-15T10:01:00.000Z",
      agent: "Bob",
      type: "message",
      preview: "Orphan reply",
    });

    const result = populateThreadFields(newEvent, "nonexistent-ts", []);

    expect(result.threadId).toBeUndefined();
    expect(result.parentEventTs).toBeUndefined();
    expect(result).toEqual(newEvent);
  });

  it("does not mutate the original event", () => {
    const parent = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const original = makeEvent({
      ts: "2026-03-15T10:01:00.000Z",
      agent: "Bob",
      type: "message",
      preview: "Reply",
    });

    const result = populateThreadFields(original, parent.ts, [parent]);

    expect(original.threadId).toBeUndefined();
    expect(original.parentEventTs).toBeUndefined();
    expect(result.threadId).toBe(parent.ts);
    expect(result).not.toBe(original);
  });

  it("handles non-message event types (e.g., task.progress)", () => {
    const parent = makeRootEvent("2026-03-15T10:00:00.000Z", "Worker1", "Started task");
    const progressEvent = makeEvent({
      ts: "2026-03-15T10:05:00.000Z",
      agent: "Worker1",
      type: "task.progress",
      target: "task-1",
      preview: "50% complete",
    });

    const result = populateThreadFields(progressEvent, parent.ts, [parent]);

    expect(result.threadId).toBe(parent.ts);
    expect(result.parentEventTs).toBe(parent.ts);
    expect(result.type).toBe("task.progress");
  });
});

// =============================================================================
// getThread()
// =============================================================================

describe("getThread()", () => {
  it("returns root and all replies for a thread", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Reply 1");
    const reply2 = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts, "Reply 2");
    const unrelated = makeRootEvent("2026-03-15T10:03:00.000Z", "Dave", "Other message");

    const thread = getThread(root.ts, [root, reply1, reply2, unrelated]);

    expect(thread).toHaveLength(3);
    expect(thread[0].agent).toBe("Alice");
    expect(thread[1].agent).toBe("Bob");
    expect(thread[2].agent).toBe("Charlie");
  });

  it("returns events sorted by timestamp", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const reply2 = makeReplyEvent("2026-03-15T10:03:00.000Z", "Charlie", root.ts, root.ts, "Later");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Earlier");

    // Pass them out of order
    const thread = getThread(root.ts, [reply2, root, reply1]);

    expect(thread).toHaveLength(3);
    expect(thread[0].ts).toBe("2026-03-15T10:00:00.000Z");
    expect(thread[1].ts).toBe("2026-03-15T10:01:00.000Z");
    expect(thread[2].ts).toBe("2026-03-15T10:03:00.000Z");
  });

  it("returns empty array for non-existent thread", () => {
    const event = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Standalone");
    const thread = getThread("nonexistent-thread-id", [event]);

    expect(thread).toHaveLength(0);
  });

  it("returns empty array when events is empty", () => {
    expect(getThread("any-id", [])).toEqual([]);
  });
});

// =============================================================================
// getReplyCount()
// =============================================================================

describe("getReplyCount()", () => {
  it("counts replies (events with parentEventTs) correctly", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts);
    const reply2 = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts);
    const reply3 = makeReplyEvent("2026-03-15T10:03:00.000Z", "Dave", root.ts, reply1.ts);

    expect(getReplyCount(root.ts, [root, reply1, reply2, reply3])).toBe(3);
  });

  it("returns 0 for a thread with no replies", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    expect(getReplyCount(root.ts, [root])).toBe(0);
  });

  it("does not count events from other threads", () => {
    const root1 = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Thread 1");
    const root2 = makeRootEvent("2026-03-15T10:05:00.000Z", "Eve", "Thread 2");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root1.ts, root1.ts);
    const reply2 = makeReplyEvent("2026-03-15T10:06:00.000Z", "Frank", root2.ts, root2.ts);

    expect(getReplyCount(root1.ts, [root1, reply1, root2, reply2])).toBe(1);
    expect(getReplyCount(root2.ts, [root1, reply1, root2, reply2])).toBe(1);
  });
});

// =============================================================================
// groupByThread()
// =============================================================================

describe("groupByThread()", () => {
  it("groups a root event with its replies", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root msg");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Reply 1");
    const reply2 = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts, "Reply 2");

    const groups = groupByThread([root, reply1, reply2]);

    expect(groups).toHaveLength(1);
    expect(groups[0].rootEvent.agent).toBe("Alice");
    expect(groups[0].replies).toHaveLength(2);
    expect(groups[0].replyCount).toBe(2);
  });

  it("keeps standalone events as single-event groups", () => {
    const ev1 = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Msg 1");
    const ev2 = makeRootEvent("2026-03-15T10:01:00.000Z", "Bob", "Msg 2");

    const groups = groupByThread([ev1, ev2]);

    expect(groups).toHaveLength(2);
    expect(groups[0].rootEvent.agent).toBe("Alice");
    expect(groups[0].replies).toHaveLength(0);
    expect(groups[0].replyCount).toBe(0);
    expect(groups[1].rootEvent.agent).toBe("Bob");
  });

  it("handles multiple independent threads", () => {
    const root1 = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Thread 1");
    const root2 = makeRootEvent("2026-03-15T10:01:00.000Z", "Dave", "Thread 2");
    const reply1a = makeReplyEvent("2026-03-15T10:02:00.000Z", "Bob", root1.ts, root1.ts);
    const reply2a = makeReplyEvent("2026-03-15T10:03:00.000Z", "Eve", root2.ts, root2.ts);
    const reply1b = makeReplyEvent("2026-03-15T10:04:00.000Z", "Charlie", root1.ts, root1.ts);

    const groups = groupByThread([root1, root2, reply1a, reply2a, reply1b]);

    expect(groups).toHaveLength(2);

    const thread1 = groups.find((g) => g.rootEvent.agent === "Alice")!;
    expect(thread1.replies).toHaveLength(2);
    expect(thread1.replyCount).toBe(2);

    const thread2 = groups.find((g) => g.rootEvent.agent === "Dave")!;
    expect(thread2.replies).toHaveLength(1);
    expect(thread2.replyCount).toBe(1);
  });

  it("preserves root event order from input", () => {
    const root1 = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "First");
    const root2 = makeRootEvent("2026-03-15T10:01:00.000Z", "Bob", "Second");
    const root3 = makeRootEvent("2026-03-15T10:02:00.000Z", "Charlie", "Third");

    const groups = groupByThread([root1, root2, root3]);

    expect(groups[0].rootEvent.agent).toBe("Alice");
    expect(groups[1].rootEvent.agent).toBe("Bob");
    expect(groups[2].rootEvent.agent).toBe("Charlie");
  });

  it("sorts replies within a group by timestamp", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const replyLate = makeReplyEvent("2026-03-15T10:05:00.000Z", "Charlie", root.ts, root.ts, "Late");
    const replyEarly = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Early");

    const groups = groupByThread([root, replyLate, replyEarly]);

    expect(groups[0].replies[0].preview).toBe("Early");
    expect(groups[0].replies[1].preview).toBe("Late");
  });

  it("handles orphaned replies whose root is not in the event list", () => {
    const orphanReply1 = makeReplyEvent(
      "2026-03-15T10:01:00.000Z", "Bob", "missing-root-ts", "missing-root-ts", "Orphan 1",
    );
    const orphanReply2 = makeReplyEvent(
      "2026-03-15T10:02:00.000Z", "Charlie", "missing-root-ts", "missing-root-ts", "Orphan 2",
    );

    const groups = groupByThread([orphanReply1, orphanReply2]);

    expect(groups).toHaveLength(1);
    // First orphan becomes pseudo-root
    expect(groups[0].rootEvent.preview).toBe("Orphan 1");
    expect(groups[0].replies).toHaveLength(1);
    expect(groups[0].replies[0].preview).toBe("Orphan 2");
  });

  it("returns empty array for empty input", () => {
    expect(groupByThread([])).toEqual([]);
  });

  it("mixes threaded and unthreaded events correctly", () => {
    const standalone1 = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Stand 1");
    const root = makeRootEvent("2026-03-15T10:01:00.000Z", "Bob", "Thread root");
    const reply = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts, "Reply");
    const standalone2 = makeRootEvent("2026-03-15T10:03:00.000Z", "Dave", "Stand 2");

    const groups = groupByThread([standalone1, root, reply, standalone2]);

    expect(groups).toHaveLength(3);
    expect(groups[0].rootEvent.agent).toBe("Alice");
    expect(groups[0].replyCount).toBe(0);
    expect(groups[1].rootEvent.agent).toBe("Bob");
    expect(groups[1].replyCount).toBe(1);
    expect(groups[2].rootEvent.agent).toBe("Dave");
    expect(groups[2].replyCount).toBe(0);
  });
});

// =============================================================================
// formatCollapseIndicator()
// =============================================================================

describe("formatCollapseIndicator()", () => {
  it("returns empty string for 0 replies", () => {
    expect(formatCollapseIndicator(0)).toBe("");
  });

  it("returns singular form for 1 reply", () => {
    expect(formatCollapseIndicator(1)).toBe("[1 reply]");
  });

  it("returns plural form for multiple replies", () => {
    expect(formatCollapseIndicator(5)).toBe("[5 replies]");
  });

  it("handles large numbers", () => {
    expect(formatCollapseIndicator(42)).toBe("[42 replies]");
  });
});

// =============================================================================
// formatReplyPrefix()
// =============================================================================

describe("formatReplyPrefix()", () => {
  it("returns ├─ for non-last replies", () => {
    expect(formatReplyPrefix(false)).toBe("├─");
  });

  it("returns └─ for the last reply", () => {
    expect(formatReplyPrefix(true)).toBe("└─");
  });
});

// =============================================================================
// shouldCollapse()
// =============================================================================

describe("shouldCollapse()", () => {
  it("returns false when replyCount <= maxInlineReplies", () => {
    expect(shouldCollapse(3)).toBe(false);  // default maxInlineReplies is 3
    expect(shouldCollapse(2)).toBe(false);
    expect(shouldCollapse(0)).toBe(false);
  });

  it("returns true when replyCount > maxInlineReplies", () => {
    expect(shouldCollapse(4)).toBe(true);
    expect(shouldCollapse(10)).toBe(true);
  });

  it("respects custom maxInlineReplies option", () => {
    const options: ThreadRenderOptions = { maxInlineReplies: 5, showReplyIndicators: true };
    expect(shouldCollapse(5, options)).toBe(false);
    expect(shouldCollapse(6, options)).toBe(true);
  });
});

// =============================================================================
// renderThreadGroup()
// =============================================================================

describe("renderThreadGroup()", () => {
  const simpleFmt = (e: FeedEvent) => `${e.agent}: ${e.preview ?? "(no preview)"}`;

  it("renders a standalone event with no collapse indicator", () => {
    const group = {
      rootEvent: makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Hello"),
      replies: [],
      replyCount: 0,
    };

    const lines = renderThreadGroup(group, simpleFmt);

    expect(lines).toEqual(["Alice: Hello"]);
  });

  it("renders a thread with replies using tree indicators", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root msg");
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Reply 1");
    const reply2 = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts, "Reply 2");

    const group = { rootEvent: root, replies: [reply1, reply2], replyCount: 2 };
    const lines = renderThreadGroup(group, simpleFmt);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Alice: Root msg  [2 replies]");
    expect(lines[1]).toBe("  ├─ Bob: Reply 1");
    expect(lines[2]).toBe("  └─ Charlie: Reply 2");
  });

  it("collapses threads exceeding maxInlineReplies", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const replies = Array.from({ length: 5 }, (_, i) =>
      makeReplyEvent(
        `2026-03-15T10:0${i + 1}:00.000Z`,
        `Agent${i}`,
        root.ts,
        root.ts,
        `Reply ${i}`,
      ),
    );

    const group = { rootEvent: root, replies, replyCount: 5 };
    const lines = renderThreadGroup(group, simpleFmt);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Alice: Root  [5 replies]");
    expect(lines[1]).toBe("  ├─ Agent0: Reply 0");
    expect(lines[2]).toBe("  └─ ... and 4 more replies");
  });

  it("shows singular 'reply' when 1 more remains in collapsed mode", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    // maxInlineReplies = 1 to force collapse at 2
    const reply1 = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "R1");
    const reply2 = makeReplyEvent("2026-03-15T10:02:00.000Z", "Charlie", root.ts, root.ts, "R2");

    const group = { rootEvent: root, replies: [reply1, reply2], replyCount: 2 };
    const options: ThreadRenderOptions = { maxInlineReplies: 1, showReplyIndicators: true };
    const lines = renderThreadGroup(group, simpleFmt, options);

    expect(lines[2]).toBe("  └─ ... and 1 more reply");
  });

  it("renders without indicators when showReplyIndicators is false", () => {
    const root = makeRootEvent("2026-03-15T10:00:00.000Z", "Alice", "Root");
    const reply = makeReplyEvent("2026-03-15T10:01:00.000Z", "Bob", root.ts, root.ts, "Reply");

    const group = { rootEvent: root, replies: [reply], replyCount: 1 };
    const options: ThreadRenderOptions = { maxInlineReplies: 3, showReplyIndicators: false };
    const lines = renderThreadGroup(group, simpleFmt, options);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Alice: Root  [1 reply]");
    expect(lines[1]).toBe("  Bob: Reply");
  });
});

// =============================================================================
// Integration: FeedEvent with thread fields persisted via feed.ts
// =============================================================================

describe("FeedEvent thread field persistence", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("persists and reads back thread fields through JSONL", () => {
    const rootEvent: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Alice",
      type: "message",
      preview: "Thread root",
    };

    const replyEvent: FeedEvent = {
      ts: "2026-03-15T10:01:00.000Z",
      agent: "Bob",
      type: "message",
      preview: "Reply",
      threadId: rootEvent.ts,
      parentEventTs: rootEvent.ts,
    };

    appendFeedEvent(cwd, rootEvent);
    appendFeedEvent(cwd, replyEvent);

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events[0].threadId).toBeUndefined();
    expect(events[1].threadId).toBe(rootEvent.ts);
    expect(events[1].parentEventTs).toBe(rootEvent.ts);
  });

  it("round-trips populateThreadFields through the feed", () => {
    const root: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Alice",
      type: "message",
      preview: "Start discussion",
    };
    appendFeedEvent(cwd, root);

    const allEvents = readFeedEvents(cwd, 20);

    const reply = populateThreadFields(
      {
        ts: "2026-03-15T10:01:00.000Z",
        agent: "Bob",
        type: "message",
        preview: "Contributing to discussion",
      },
      root.ts,
      allEvents,
    );

    appendFeedEvent(cwd, reply);

    const finalEvents = readFeedEvents(cwd, 20);
    expect(finalEvents).toHaveLength(2);

    const thread = getThread(root.ts, finalEvents);
    expect(thread).toHaveLength(2);
    expect(thread[0].agent).toBe("Alice");
    expect(thread[1].agent).toBe("Bob");
    expect(thread[1].threadId).toBe(root.ts);

    expect(getReplyCount(root.ts, finalEvents)).toBe(1);
  });

  it("groups events from JSONL into correct ThreadGroups", () => {
    const root: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Alice",
      type: "message",
      preview: "Thread 1",
    };
    const reply1: FeedEvent = {
      ts: "2026-03-15T10:01:00.000Z",
      agent: "Bob",
      type: "message",
      preview: "Reply to thread 1",
      threadId: root.ts,
      parentEventTs: root.ts,
    };
    const standalone: FeedEvent = {
      ts: "2026-03-15T10:02:00.000Z",
      agent: "Charlie",
      type: "task.done",
      target: "task-1",
      preview: "Done!",
    };

    appendFeedEvent(cwd, root);
    appendFeedEvent(cwd, reply1);
    appendFeedEvent(cwd, standalone);

    const events = readFeedEvents(cwd, 20);
    const groups = groupByThread(events);

    expect(groups).toHaveLength(2);
    expect(groups[0].rootEvent.preview).toBe("Thread 1");
    expect(groups[0].replyCount).toBe(1);
    expect(groups[1].rootEvent.preview).toBe("Done!");
    expect(groups[1].replyCount).toBe(0);
  });
});

// =============================================================================
// DEFAULT_THREAD_RENDER_OPTIONS
// =============================================================================

describe("DEFAULT_THREAD_RENDER_OPTIONS", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_THREAD_RENDER_OPTIONS.maxInlineReplies).toBe(3);
    expect(DEFAULT_THREAD_RENDER_OPTIONS.showReplyIndicators).toBe(true);
  });
});
