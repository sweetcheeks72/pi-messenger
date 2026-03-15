/**
 * Virtual Channels — Full TDD Test Suite (TASK-15)
 *
 * Tests the topic-filtering channel system:
 *   - DEFAULT_CHANNELS has exactly 5 channels (#all, #impl, #review, #blocked, #chat)
 *   - getChannelEvents() filters events by channel predicate
 *   - getUnreadCounts() computes per-channel unreads from lastSeenTs
 *   - getChannelById() retrieves a channel by ID
 *   - formatChannelTabs() renders status bar with badges
 *   - #blocked only shows block/escalate/stuck/stale events
 */

import { describe, expect, it } from "vitest";
import type { FeedEvent, FeedEventType } from "../../feed.js";
import {
  DEFAULT_CHANNELS,
  getChannelEvents,
  getUnreadCounts,
  getChannelById,
  formatChannelTabs,
  type VirtualChannel,
} from "../../crew/channels.js";

// =============================================================================
// Helpers
// =============================================================================

function makeEvent(type: FeedEventType, ts?: string, agent?: string): FeedEvent {
  return {
    ts: ts ?? "2026-03-15T10:00:00.000Z",
    agent: agent ?? "TestAgent",
    type,
  };
}

function makeEvents(types: FeedEventType[]): FeedEvent[] {
  return types.map((type, i) =>
    makeEvent(type, `2026-03-15T10:${String(i).padStart(2, "0")}:00.000Z`),
  );
}

// =============================================================================
// DEFAULT_CHANNELS
// =============================================================================

describe("DEFAULT_CHANNELS", () => {
  it("contains exactly 5 channels", () => {
    expect(DEFAULT_CHANNELS).toHaveLength(5);
  });

  it("has the correct channel IDs in order", () => {
    const ids = DEFAULT_CHANNELS.map((ch) => ch.id);
    expect(ids).toEqual(["#all", "#impl", "#review", "#blocked", "#chat"]);
  });

  it("has human-readable labels", () => {
    const labels = DEFAULT_CHANNELS.map((ch) => ch.label);
    expect(labels).toEqual([
      "All Activity",
      "Implementation",
      "Review",
      "Blocked",
      "Chat",
    ]);
  });

  it("each channel has a filter function", () => {
    for (const ch of DEFAULT_CHANNELS) {
      expect(typeof ch.filter).toBe("function");
    }
  });
});

// =============================================================================
// Channel Filter Correctness
// =============================================================================

describe("channel filters", () => {
  describe("#all", () => {
    const allCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#all")!;

    it("passes every event type", () => {
      const types: FeedEventType[] = [
        "join", "leave", "message", "commit", "edit", "test",
        "task.start", "task.done", "task.block", "task.escalate",
        "task.progress", "plan.review.start", "plan.review.done",
        "stuck", "heartbeat.stale", "question.ask", "question.answer",
      ];

      for (const type of types) {
        expect(allCh.filter(makeEvent(type))).toBe(true);
      }
    });
  });

  describe("#impl", () => {
    const implCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#impl")!;

    it("includes implementation-related events", () => {
      const included: FeedEventType[] = ["edit", "commit", "test", "task.start", "task.progress"];
      for (const type of included) {
        expect(implCh.filter(makeEvent(type))).toBe(true);
      }
    });

    it("excludes non-implementation events", () => {
      const excluded: FeedEventType[] = [
        "join", "leave", "message", "task.done",
        "task.block", "plan.review.start", "stuck",
      ];
      for (const type of excluded) {
        expect(implCh.filter(makeEvent(type))).toBe(false);
      }
    });
  });

  describe("#review", () => {
    const reviewCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#review")!;

    it("includes review-related events", () => {
      const included: FeedEventType[] = [
        "task.done", "plan.review.start", "plan.review.done",
        "smoke.start", "smoke.pass", "smoke.fail", "smoke.error",
      ];
      for (const type of included) {
        expect(reviewCh.filter(makeEvent(type))).toBe(true);
      }
    });

    it("excludes non-review events", () => {
      const excluded: FeedEventType[] = [
        "edit", "commit", "message", "task.block", "join",
      ];
      for (const type of excluded) {
        expect(reviewCh.filter(makeEvent(type))).toBe(false);
      }
    });
  });

  describe("#blocked", () => {
    const blockedCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#blocked")!;

    it("includes block/escalate/stuck/stale events", () => {
      const included: FeedEventType[] = [
        "task.block", "task.escalate", "stuck", "heartbeat.stale",
      ];
      for (const type of included) {
        expect(blockedCh.filter(makeEvent(type))).toBe(true);
      }
    });

    it("excludes everything else", () => {
      const excluded: FeedEventType[] = [
        "join", "leave", "message", "commit", "edit", "test",
        "task.start", "task.done", "task.progress", "task.unblock",
        "plan.review.start", "question.ask",
      ];
      for (const type of excluded) {
        expect(blockedCh.filter(makeEvent(type))).toBe(false);
      }
    });

    it("does NOT include task.unblock (acceptance criteria)", () => {
      expect(blockedCh.filter(makeEvent("task.unblock"))).toBe(false);
    });
  });

  describe("#chat", () => {
    const chatCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#chat")!;

    it("includes message and question events", () => {
      const included: FeedEventType[] = [
        "message", "question.ask", "question.answer",
      ];
      for (const type of included) {
        expect(chatCh.filter(makeEvent(type))).toBe(true);
      }
    });

    it("excludes non-chat events", () => {
      const excluded: FeedEventType[] = [
        "commit", "edit", "task.block", "plan.done", "stuck",
      ];
      for (const type of excluded) {
        expect(chatCh.filter(makeEvent(type))).toBe(false);
      }
    });
  });
});

// =============================================================================
// getChannelEvents
// =============================================================================

describe("getChannelEvents", () => {
  it("returns all events for #all channel", () => {
    const events = makeEvents(["join", "message", "commit", "task.block"]);
    const allCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#all")!;
    const result = getChannelEvents(allCh, events);
    expect(result).toHaveLength(4);
  });

  it("returns only matching events for a filtered channel", () => {
    const events = makeEvents(["edit", "commit", "message", "task.block", "test"]);
    const implCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#impl")!;
    const result = getChannelEvents(implCh, events);
    expect(result).toHaveLength(3); // edit, commit, test
    expect(result.map((e) => e.type)).toEqual(["edit", "commit", "test"]);
  });

  it("returns empty array when no events match", () => {
    const events = makeEvents(["join", "leave"]);
    const blockedCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#blocked")!;
    const result = getChannelEvents(blockedCh, events);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty event list", () => {
    const allCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#all")!;
    const result = getChannelEvents(allCh, []);
    expect(result).toHaveLength(0);
  });

  it("preserves original event order", () => {
    const events = makeEvents(["task.block", "task.escalate", "stuck"]);
    const blockedCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#blocked")!;
    const result = getChannelEvents(blockedCh, events);
    expect(result.map((e) => e.type)).toEqual(["task.block", "task.escalate", "stuck"]);
  });

  it("works with a custom channel filter", () => {
    const customChannel: VirtualChannel = {
      id: "#custom",
      label: "Custom",
      filter: (e) => e.agent === "SpecialAgent",
    };
    const events: FeedEvent[] = [
      makeEvent("message", undefined, "SpecialAgent"),
      makeEvent("message", undefined, "OtherAgent"),
      makeEvent("commit", undefined, "SpecialAgent"),
    ];
    const result = getChannelEvents(customChannel, events);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.agent === "SpecialAgent")).toBe(true);
  });
});

// =============================================================================
// getUnreadCounts
// =============================================================================

describe("getUnreadCounts", () => {
  const baseTs = "2026-03-15T10:00:00.000Z";

  it("counts events after lastSeenTs as unread", () => {
    const events: FeedEvent[] = [
      makeEvent("message", "2026-03-15T09:59:00.000Z"), // before → read
      makeEvent("message", "2026-03-15T10:01:00.000Z"), // after → unread
      makeEvent("commit",  "2026-03-15T10:02:00.000Z"), // after → unread
    ];
    const counts = getUnreadCounts(DEFAULT_CHANNELS, events, baseTs);
    expect(counts["#all"]).toBe(2);
    expect(counts["#chat"]).toBe(1);   // only message
    expect(counts["#impl"]).toBe(1);   // only commit
  });

  it("treats events at exactly lastSeenTs as read (strictly after)", () => {
    const events: FeedEvent[] = [
      makeEvent("message", baseTs),
    ];
    const counts = getUnreadCounts(DEFAULT_CHANNELS, events, baseTs);
    expect(counts["#all"]).toBe(0);
    expect(counts["#chat"]).toBe(0);
  });

  it("returns zero counts when no events exist", () => {
    const counts = getUnreadCounts(DEFAULT_CHANNELS, [], baseTs);
    for (const ch of DEFAULT_CHANNELS) {
      expect(counts[ch.id]).toBe(0);
    }
  });

  it("returns zero counts when all events are before lastSeenTs", () => {
    const events: FeedEvent[] = [
      makeEvent("message", "2026-03-15T09:00:00.000Z"),
      makeEvent("commit",  "2026-03-15T09:30:00.000Z"),
    ];
    const counts = getUnreadCounts(DEFAULT_CHANNELS, events, baseTs);
    for (const ch of DEFAULT_CHANNELS) {
      expect(counts[ch.id]).toBe(0);
    }
  });

  it("correctly splits unreads across channels", () => {
    const events: FeedEvent[] = [
      makeEvent("task.block",    "2026-03-15T10:01:00.000Z"),
      makeEvent("task.escalate", "2026-03-15T10:02:00.000Z"),
      makeEvent("message",       "2026-03-15T10:03:00.000Z"),
      makeEvent("edit",          "2026-03-15T10:04:00.000Z"),
      makeEvent("task.done",     "2026-03-15T10:05:00.000Z"),
    ];
    const counts = getUnreadCounts(DEFAULT_CHANNELS, events, baseTs);
    expect(counts["#all"]).toBe(5);
    expect(counts["#blocked"]).toBe(2); // task.block + task.escalate
    expect(counts["#chat"]).toBe(1);    // message
    expect(counts["#impl"]).toBe(1);    // edit
    expect(counts["#review"]).toBe(1);  // task.done
  });

  it("an event can appear in only one filtered channel", () => {
    // Verify channel filters are mutually exclusive (except #all)
    const event = makeEvent("task.block", "2026-03-15T10:01:00.000Z");
    const counts = getUnreadCounts(DEFAULT_CHANNELS, [event], baseTs);
    const filteredChannels = DEFAULT_CHANNELS.filter((ch) => ch.id !== "#all");
    const matchingChannels = filteredChannels.filter((ch) => counts[ch.id] > 0);
    expect(matchingChannels).toHaveLength(1);
    expect(matchingChannels[0].id).toBe("#blocked");
  });

  it("handles custom channel list", () => {
    const customChannels: VirtualChannel[] = [
      { id: "#everything", label: "Everything", filter: () => true },
    ];
    const events = [makeEvent("join", "2026-03-15T10:01:00.000Z")];
    const counts = getUnreadCounts(customChannels, events, baseTs);
    expect(counts["#everything"]).toBe(1);
  });
});

// =============================================================================
// getChannelById
// =============================================================================

describe("getChannelById", () => {
  it("finds a channel by its ID", () => {
    const ch = getChannelById(DEFAULT_CHANNELS, "#blocked");
    expect(ch).toBeDefined();
    expect(ch!.id).toBe("#blocked");
    expect(ch!.label).toBe("Blocked");
  });

  it("returns undefined for unknown ID", () => {
    const ch = getChannelById(DEFAULT_CHANNELS, "#nonexistent");
    expect(ch).toBeUndefined();
  });

  it("returns the first channel when searching for #all", () => {
    const ch = getChannelById(DEFAULT_CHANNELS, "#all");
    expect(ch).toBeDefined();
    expect(ch!.label).toBe("All Activity");
  });
});

// =============================================================================
// formatChannelTabs
// =============================================================================

describe("formatChannelTabs", () => {
  it("renders channel tabs with unread badges", () => {
    const counts: Record<string, number> = {
      "#all": 12, "#impl": 5, "#review": 0, "#blocked": 2, "#chat": 1,
    };
    const result = formatChannelTabs(DEFAULT_CHANNELS, counts, "#all");
    expect(result).toContain(">#all(12)");
    expect(result).toContain(" #impl(5)");
    expect(result).toContain(" #review");
    expect(result).not.toContain("#review(0)"); // 0 unreads → no badge
    expect(result).toContain(" #blocked(2)");
    expect(result).toContain(" #chat(1)");
  });

  it("marks the active channel with >", () => {
    const counts: Record<string, number> = {
      "#all": 0, "#impl": 0, "#review": 0, "#blocked": 0, "#chat": 0,
    };
    const result = formatChannelTabs(DEFAULT_CHANNELS, counts, "#impl");
    expect(result).toContain(">#impl");
    expect(result).toContain(" #all");
    expect(result).not.toContain(">#all");
  });

  it("omits badge for zero unreads", () => {
    const counts: Record<string, number> = {
      "#all": 0, "#impl": 0, "#review": 0, "#blocked": 0, "#chat": 0,
    };
    const result = formatChannelTabs(DEFAULT_CHANNELS, counts, "#all");
    expect(result).not.toContain("(0)");
  });

  it("handles missing counts gracefully (defaults to 0)", () => {
    const result = formatChannelTabs(DEFAULT_CHANNELS, {}, "#all");
    expect(result).not.toContain("(");
    expect(result).toContain(">#all");
  });
});

// =============================================================================
// Integration: end-to-end channel filtering workflow
// =============================================================================

describe("integration", () => {
  it("full workflow: filter → count → format", () => {
    const lastSeen = "2026-03-15T10:00:00.000Z";
    const events: FeedEvent[] = [
      makeEvent("edit",          "2026-03-15T09:55:00.000Z"), // before → read
      makeEvent("commit",        "2026-03-15T10:01:00.000Z"), // impl, unread
      makeEvent("task.block",    "2026-03-15T10:02:00.000Z"), // blocked, unread
      makeEvent("message",       "2026-03-15T10:03:00.000Z"), // chat, unread
      makeEvent("task.done",     "2026-03-15T10:04:00.000Z"), // review, unread
      makeEvent("task.escalate", "2026-03-15T10:05:00.000Z"), // blocked, unread
    ];

    // Step 1: Get blocked channel events
    const blockedCh = DEFAULT_CHANNELS.find((ch) => ch.id === "#blocked")!;
    const blockedEvents = getChannelEvents(blockedCh, events);
    expect(blockedEvents).toHaveLength(2);
    expect(blockedEvents.map((e) => e.type)).toEqual(["task.block", "task.escalate"]);

    // Step 2: Compute unread counts
    const counts = getUnreadCounts(DEFAULT_CHANNELS, events, lastSeen);
    expect(counts["#all"]).toBe(5);     // 5 after lastSeen
    expect(counts["#impl"]).toBe(1);    // commit
    expect(counts["#blocked"]).toBe(2); // task.block + task.escalate
    expect(counts["#chat"]).toBe(1);    // message
    expect(counts["#review"]).toBe(1);  // task.done

    // Step 3: Format tabs
    const tabs = formatChannelTabs(DEFAULT_CHANNELS, counts, "#blocked");
    expect(tabs).toContain(" #all(5)");
    expect(tabs).toContain(">#blocked(2)");
    expect(tabs).toContain(" #chat(1)");
  });

  it("switching channels shows different event sets", () => {
    const events: FeedEvent[] = [
      makeEvent("edit",       "2026-03-15T10:01:00.000Z"),
      makeEvent("test",       "2026-03-15T10:02:00.000Z"),
      makeEvent("message",    "2026-03-15T10:03:00.000Z"),
      makeEvent("task.block", "2026-03-15T10:04:00.000Z"),
    ];

    const implEvents = getChannelEvents(
      DEFAULT_CHANNELS.find((ch) => ch.id === "#impl")!,
      events,
    );
    expect(implEvents.map((e) => e.type)).toEqual(["edit", "test"]);

    const chatEvents = getChannelEvents(
      DEFAULT_CHANNELS.find((ch) => ch.id === "#chat")!,
      events,
    );
    expect(chatEvents.map((e) => e.type)).toEqual(["message"]);

    const blockedEvents = getChannelEvents(
      DEFAULT_CHANNELS.find((ch) => ch.id === "#blocked")!,
      events,
    );
    expect(blockedEvents.map((e) => e.type)).toEqual(["task.block"]);
  });
});
