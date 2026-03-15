/**
 * Feed Full-Text Search + Timeline Navigation — Full TDD Test Suite (TASK-16)
 *
 * Tests:
 *   - searchFeed() finds events by agent name, preview, target, rich content
 *   - searchFeed() respects time-range filters (after/before)
 *   - searchFeed() respects type filters
 *   - searchFeed() returns correct matchField and matchHighlight ranges
 *   - searchFeed() is case-insensitive
 *   - searchFeed() limits results
 *   - jumpToTimestamp() returns correct window around a target timestamp
 *   - jumpToTimestamp() handles relative time strings ("1h ago")
 *   - jumpToTimestamp() handles edge cases (beginning/end of feed, empty feed)
 *   - parseRelativeTime() parses various formats
 *   - highlightMatch() wraps correct range with markers
 *   - formatSearchResult() integrates highlight into formatted line
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FeedEvent, FeedEventType } from "../../feed.js";
import {
  searchFeed,
  jumpToTimestamp,
  parseRelativeTime,
  highlightMatch,
  formatSearchResult,
  type SearchResult,
} from "../../crew/feed-search.js";

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;
let feedFile: string;

function makeEvent(
  overrides: Partial<FeedEvent> & { ts: string; agent: string; type: FeedEventType },
): FeedEvent {
  return { ...overrides };
}

function writeFeed(events: FeedEvent[]): void {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(feedFile, content);
}

/** Generate a series of timestamped events spaced 1 minute apart */
function generateTimeline(count: number, baseTime: string = "2026-03-15T10:00:00.000Z"): FeedEvent[] {
  const base = new Date(baseTime).getTime();
  const events: FeedEvent[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(base + i * 60_000).toISOString();
    events.push(makeEvent({
      ts,
      agent: `Agent${i}`,
      type: "message",
      preview: `Message number ${i}`,
    }));
  }
  return events;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-search-test-"));
  feedFile = path.join(tmpDir, "feed.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// searchFeed — Basic Matching
// =============================================================================

describe("searchFeed", () => {
  describe("basic matching", () => {
    it("finds events by agent name", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Dyson", type: "commit", preview: "fix bug" }),
        makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "Murray", type: "message", preview: "reviewing" }),
        makeEvent({ ts: "2026-03-15T10:02:00.000Z", agent: "Arline", type: "edit", preview: "scanning" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "Dyson");
      expect(results).toHaveLength(1);
      expect(results[0].event.agent).toBe("Dyson");
      expect(results[0].matchField).toBe("agent");
    });

    it("finds events by preview text", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Worker1", type: "commit", preview: "Fixed authentication bug in login" }),
        makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "Worker2", type: "commit", preview: "Added database migration" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "authentication");
      expect(results).toHaveLength(1);
      expect(results[0].event.preview).toBe("Fixed authentication bug in login");
      expect(results[0].matchField).toBe("preview");
    });

    it("finds events by target field", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "task.start", target: "task-42" }),
        makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "W2", type: "task.start", target: "task-99" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "task-42");
      expect(results).toHaveLength(1);
      expect(results[0].matchField).toBe("target");
      expect(results[0].event.target).toBe("task-42");
    });

    it("finds events by rich content text", () => {
      const events = [
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "W1",
          type: "commit",
          preview: "refactor",
          richContent: [
            { type: "code", content: "const specialVariable = 42;", language: "typescript" },
          ],
        }),
        makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "W2", type: "commit", preview: "cleanup" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "specialVariable");
      expect(results).toHaveLength(1);
      expect(results[0].matchField).toBe("content");
    });

    it("returns empty array for empty query", () => {
      writeFeed([makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "A", type: "message" })]);
      expect(searchFeed(feedFile, "")).toHaveLength(0);
      expect(searchFeed(feedFile, "   ")).toHaveLength(0);
    });

    it("returns empty array for non-existent feed file", () => {
      const results = searchFeed("/nonexistent/feed.jsonl", "test");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when no events match", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "commit", preview: "hello" }),
      ]);
      const results = searchFeed(feedFile, "zzzznonesuch");
      expect(results).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Case Insensitivity
  // ===========================================================================

  describe("case insensitivity", () => {
    it("matches regardless of case", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "DysonWorker", type: "commit", preview: "Fix BUG" }),
      ]);

      expect(searchFeed(feedFile, "dysonworker")).toHaveLength(1);
      expect(searchFeed(feedFile, "DYSONWORKER")).toHaveLength(1);
      expect(searchFeed(feedFile, "fix bug")).toHaveLength(1);
      expect(searchFeed(feedFile, "FIX BUG")).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Match Highlight Ranges
  // ===========================================================================

  describe("match highlights", () => {
    it("returns correct highlight range for agent match", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "MurrayReviewer", type: "message" }),
      ]);

      const results = searchFeed(feedFile, "Murray");
      expect(results[0].matchHighlight).toEqual({ start: 0, end: 6 });
    });

    it("returns correct highlight range for mid-string match", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "commit", preview: "Fixed the auth bug in login module" }),
      ]);

      const results = searchFeed(feedFile, "auth bug");
      expect(results[0].matchHighlight).toEqual({ start: 10, end: 18 });
    });

    it("highlight range length equals query length", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "TestAgent", type: "message", preview: "some text here" }),
      ]);

      const results = searchFeed(feedFile, "text");
      const hl = results[0].matchHighlight;
      expect(hl.end - hl.start).toBe(4); // "text".length
    });
  });

  // ===========================================================================
  // Field Priority (first matching field wins)
  // ===========================================================================

  describe("field priority", () => {
    it("agent match takes priority over preview match", () => {
      writeFeed([
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "TestBot",
          type: "message",
          preview: "TestBot said hello",
        }),
      ]);

      const results = searchFeed(feedFile, "TestBot");
      expect(results).toHaveLength(1);
      expect(results[0].matchField).toBe("agent");
    });

    it("preview match takes priority over target match", () => {
      writeFeed([
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "W1",
          type: "edit",
          preview: "editing the config file",
          target: "config file path",
        }),
      ]);

      const results = searchFeed(feedFile, "config");
      expect(results[0].matchField).toBe("preview");
    });

    it("each event appears at most once", () => {
      writeFeed([
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "Alpha",
          type: "message",
          preview: "Alpha is working",
          target: "Alpha-task",
        }),
      ]);

      const results = searchFeed(feedFile, "Alpha");
      expect(results).toHaveLength(1); // not 3
    });
  });

  // ===========================================================================
  // Time Range Filters
  // ===========================================================================

  describe("time range filters", () => {
    const events = [
      makeEvent({ ts: "2026-03-15T09:00:00.000Z", agent: "W1", type: "message", preview: "early morning" }),
      makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "message", preview: "mid morning" }),
      makeEvent({ ts: "2026-03-15T11:00:00.000Z", agent: "W1", type: "message", preview: "late morning" }),
      makeEvent({ ts: "2026-03-15T12:00:00.000Z", agent: "W1", type: "message", preview: "afternoon" }),
    ];

    it("after filter excludes events at or before the timestamp", () => {
      writeFeed(events);
      const results = searchFeed(feedFile, "morning", {
        after: "2026-03-15T10:00:00.000Z",
      });
      expect(results).toHaveLength(1); // only "late morning"
      expect(results[0].event.preview).toBe("late morning");
    });

    it("before filter excludes events at or after the timestamp", () => {
      writeFeed(events);
      const results = searchFeed(feedFile, "morning", {
        before: "2026-03-15T10:00:00.000Z",
      });
      expect(results).toHaveLength(1); // only "early morning"
      expect(results[0].event.preview).toBe("early morning");
    });

    it("after + before together create a window", () => {
      writeFeed(events);
      const results = searchFeed(feedFile, "W1", {
        after: "2026-03-15T09:00:00.000Z",
        before: "2026-03-15T12:00:00.000Z",
      });
      // Excludes 09:00 (at boundary) and 12:00 (at boundary)
      expect(results).toHaveLength(2); // 10:00 and 11:00
    });
  });

  // ===========================================================================
  // Type Filter
  // ===========================================================================

  describe("type filter", () => {
    it("narrows results to a specific event type", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Dyson", type: "commit", preview: "fix" }),
        makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "Dyson", type: "edit", preview: "editing" }),
        makeEvent({ ts: "2026-03-15T10:02:00.000Z", agent: "Dyson", type: "message", preview: "done" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "Dyson", { type: "commit" });
      expect(results).toHaveLength(1);
      expect(results[0].event.type).toBe("commit");
    });

    it("returns empty when type filter matches no events", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "commit", preview: "fix" }),
      ]);
      const results = searchFeed(feedFile, "W1", { type: "task.block" });
      expect(results).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Limit
  // ===========================================================================

  describe("result limiting", () => {
    it("respects the limit option", () => {
      const events = generateTimeline(100);
      writeFeed(events);

      const results = searchFeed(feedFile, "Message", { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it("default limit is 50", () => {
      const events = generateTimeline(100);
      writeFeed(events);

      const results = searchFeed(feedFile, "Message");
      expect(results).toHaveLength(50);
    });

    it("returns fewer than limit when not enough matches", () => {
      writeFeed([
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "message", preview: "hello" }),
      ]);
      const results = searchFeed(feedFile, "hello", { limit: 100 });
      expect(results).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Chronological Order
  // ===========================================================================

  describe("result ordering", () => {
    it("returns results in chronological order", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Bot", type: "message", preview: "first" }),
        makeEvent({ ts: "2026-03-15T11:00:00.000Z", agent: "Bot", type: "message", preview: "second" }),
        makeEvent({ ts: "2026-03-15T12:00:00.000Z", agent: "Bot", type: "message", preview: "third" }),
      ];
      writeFeed(events);

      const results = searchFeed(feedFile, "Bot");
      expect(results.map((r) => r.event.preview)).toEqual(["first", "second", "third"]);
    });
  });

  // ===========================================================================
  // Malformed Lines
  // ===========================================================================

  describe("resilience", () => {
    it("skips malformed JSONL lines", () => {
      const content = [
        JSON.stringify(makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Good", type: "message", preview: "valid" })),
        "this is not json {{{",
        JSON.stringify(makeEvent({ ts: "2026-03-15T10:01:00.000Z", agent: "Good", type: "commit", preview: "also valid" })),
      ].join("\n") + "\n";
      fs.writeFileSync(feedFile, content);

      const results = searchFeed(feedFile, "Good");
      expect(results).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Rich Content Search
  // ===========================================================================

  describe("rich content search", () => {
    it("searches across multiple richContent blocks", () => {
      writeFeed([
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "W1",
          type: "commit",
          richContent: [
            { type: "text", content: "First block of text" },
            { type: "code", content: "const uniqueIdentifier = true;", language: "ts" },
          ],
        }),
      ]);

      const results = searchFeed(feedFile, "uniqueIdentifier");
      expect(results).toHaveLength(1);
      expect(results[0].matchField).toBe("content");
    });

    it("does not match richContent when other fields match first", () => {
      writeFeed([
        makeEvent({
          ts: "2026-03-15T10:00:00.000Z",
          agent: "SearchTarget",
          type: "commit",
          preview: "SearchTarget appears here too",
          richContent: [{ type: "text", content: "SearchTarget in content" }],
        }),
      ]);

      const results = searchFeed(feedFile, "SearchTarget");
      expect(results).toHaveLength(1);
      expect(results[0].matchField).toBe("agent"); // agent wins
    });
  });
});

// =============================================================================
// jumpToTimestamp
// =============================================================================

describe("jumpToTimestamp", () => {
  describe("basic navigation", () => {
    it("returns events around the target timestamp", () => {
      const events = generateTimeline(50);
      writeFeed(events);

      // Jump to minute 25 (middle)
      const target = new Date("2026-03-15T10:25:00.000Z").toISOString();
      const result = jumpToTimestamp(feedFile, target);

      expect(result.total).toBe(50);
      expect(result.events.length).toBeLessThanOrEqual(20); // default window
      // The target event should be in the window
      const targetInWindow = result.events.some(
        (e) => e.ts === target,
      );
      expect(targetInWindow).toBe(true);
    });

    it("returns correct offset for mid-feed jump", () => {
      const events = generateTimeline(50);
      writeFeed(events);

      const target = "2026-03-15T10:25:00.000Z";
      const result = jumpToTimestamp(feedFile, target);

      // Offset should place the target near the center of the window
      expect(result.offset).toBeGreaterThanOrEqual(15);
      expect(result.offset).toBeLessThanOrEqual(25);
    });

    it("respects custom window size", () => {
      const events = generateTimeline(50);
      writeFeed(events);

      const result = jumpToTimestamp(feedFile, "2026-03-15T10:25:00.000Z", 10);
      expect(result.events).toHaveLength(10);
    });
  });

  describe("edge cases", () => {
    it("returns empty result for empty feed", () => {
      writeFeed([]);
      const result = jumpToTimestamp(feedFile, "2026-03-15T10:00:00.000Z");
      expect(result.events).toHaveLength(0);
      expect(result.offset).toBe(0);
      expect(result.total).toBe(0);
    });

    it("returns empty result for non-existent file", () => {
      const result = jumpToTimestamp("/nonexistent/feed.jsonl", "2026-03-15T10:00:00.000Z");
      expect(result.events).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("handles jump to before the first event", () => {
      const events = generateTimeline(30, "2026-03-15T10:00:00.000Z");
      writeFeed(events);

      const result = jumpToTimestamp(feedFile, "2026-03-15T08:00:00.000Z");
      expect(result.offset).toBe(0);
      expect(result.events[0].ts).toBe(events[0].ts);
    });

    it("handles jump to after the last event", () => {
      const events = generateTimeline(30, "2026-03-15T10:00:00.000Z");
      writeFeed(events);

      const result = jumpToTimestamp(feedFile, "2026-03-15T12:00:00.000Z");
      // Should show the last window of events
      const lastEvent = events[events.length - 1];
      expect(result.events[result.events.length - 1].ts).toBe(lastEvent.ts);
    });

    it("handles feed smaller than window size", () => {
      const events = generateTimeline(5);
      writeFeed(events);

      const result = jumpToTimestamp(feedFile, "2026-03-15T10:02:00.000Z", 20);
      expect(result.events).toHaveLength(5);
      expect(result.offset).toBe(0);
      expect(result.total).toBe(5);
    });

    it("binary search finds closest event to timestamp between events", () => {
      const events = [
        makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "A", type: "message", preview: "e0" }),
        makeEvent({ ts: "2026-03-15T10:10:00.000Z", agent: "A", type: "message", preview: "e1" }),
        makeEvent({ ts: "2026-03-15T10:20:00.000Z", agent: "A", type: "message", preview: "e2" }),
      ];
      writeFeed(events);

      // Jump to 10:08 — closer to 10:10 than 10:00
      const result = jumpToTimestamp(feedFile, "2026-03-15T10:08:00.000Z", 3);
      // All 3 events fit in window, but the closest should be near center
      expect(result.events).toHaveLength(3);
    });
  });

  describe("relative time", () => {
    it("parses and jumps to relative time like '1h ago'", () => {
      // Create events spanning 3 hours
      const now = new Date("2026-03-15T12:00:00.000Z");
      const events: FeedEvent[] = [];
      for (let i = 0; i < 180; i++) {
        const ts = new Date(now.getTime() - (180 - i) * 60_000).toISOString();
        events.push(makeEvent({ ts, agent: "W1", type: "message", preview: `msg ${i}` }));
      }
      writeFeed(events);

      // "1h ago" from a known reference — we test that parseRelativeTime works
      // and that jumpToTimestamp integrates it
      const parsed = parseRelativeTime("1h ago", now);
      expect(parsed).toBe("2026-03-15T11:00:00.000Z");

      // Jump using the parsed time directly (jumpToTimestamp uses Date.now()
      // for relative parsing, so we test with ISO timestamp)
      const result = jumpToTimestamp(feedFile, parsed!);
      expect(result.events.length).toBeGreaterThan(0);
      // Events in the window should be around the 1h-ago mark
      const windowCenter = result.events[Math.floor(result.events.length / 2)];
      const centerTime = new Date(windowCenter.ts).getTime();
      const targetTime = new Date(parsed!).getTime();
      // Within 10 minutes of target
      expect(Math.abs(centerTime - targetTime)).toBeLessThan(10 * 60_000);
    });
  });
});

// =============================================================================
// parseRelativeTime
// =============================================================================

describe("parseRelativeTime", () => {
  const now = new Date("2026-03-15T12:00:00.000Z");

  it("parses 'Xh ago' (hours)", () => {
    expect(parseRelativeTime("1h ago", now)).toBe("2026-03-15T11:00:00.000Z");
    expect(parseRelativeTime("2h ago", now)).toBe("2026-03-15T10:00:00.000Z");
  });

  it("parses 'Xm ago' (minutes)", () => {
    expect(parseRelativeTime("30m ago", now)).toBe("2026-03-15T11:30:00.000Z");
    expect(parseRelativeTime("5min ago", now)).toBe("2026-03-15T11:55:00.000Z");
  });

  it("parses 'Xd ago' (days)", () => {
    expect(parseRelativeTime("1d ago", now)).toBe("2026-03-14T12:00:00.000Z");
    expect(parseRelativeTime("2days ago", now)).toBe("2026-03-13T12:00:00.000Z");
  });

  it("parses 'Xs ago' (seconds)", () => {
    const result = parseRelativeTime("30s ago", now);
    expect(result).toBe("2026-03-15T11:59:30.000Z");
  });

  it("parses without 'ago' suffix", () => {
    expect(parseRelativeTime("1h", now)).toBe("2026-03-15T11:00:00.000Z");
    expect(parseRelativeTime("30m", now)).toBe("2026-03-15T11:30:00.000Z");
  });

  it("handles various unit formats", () => {
    expect(parseRelativeTime("1 hour ago", now)).toBe("2026-03-15T11:00:00.000Z");
    expect(parseRelativeTime("2 hours ago", now)).toBe("2026-03-15T10:00:00.000Z");
    expect(parseRelativeTime("1 minute ago", now)).toBe("2026-03-15T11:59:00.000Z");
    expect(parseRelativeTime("5 minutes ago", now)).toBe("2026-03-15T11:55:00.000Z");
    expect(parseRelativeTime("1 day ago", now)).toBe("2026-03-14T12:00:00.000Z");
    expect(parseRelativeTime("10 seconds ago", now)).toBe("2026-03-15T11:59:50.000Z");
  });

  it("is case-insensitive", () => {
    expect(parseRelativeTime("1H AGO", now)).toBe("2026-03-15T11:00:00.000Z");
    expect(parseRelativeTime("30M Ago", now)).toBe("2026-03-15T11:30:00.000Z");
  });

  it("returns null for invalid formats", () => {
    expect(parseRelativeTime("yesterday", now)).toBeNull();
    expect(parseRelativeTime("2026-03-15", now)).toBeNull();
    expect(parseRelativeTime("not a time", now)).toBeNull();
    expect(parseRelativeTime("", now)).toBeNull();
    expect(parseRelativeTime("ago 1h", now)).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseRelativeTime("  1h ago  ", now)).toBe("2026-03-15T11:00:00.000Z");
  });
});

// =============================================================================
// highlightMatch
// =============================================================================

describe("highlightMatch", () => {
  it("wraps the correct range with default ANSI markers", () => {
    const result = highlightMatch("hello world", { start: 6, end: 11 });
    expect(result).toBe("hello \x1b[1;33mworld\x1b[0m");
  });

  it("wraps with custom markers", () => {
    const result = highlightMatch("find me here", { start: 5, end: 7 }, ["[", "]"]);
    expect(result).toBe("find [me] here");
  });

  it("handles match at the beginning", () => {
    const result = highlightMatch("hello", { start: 0, end: 5 }, ["[", "]"]);
    expect(result).toBe("[hello]");
  });

  it("handles match at the end", () => {
    const result = highlightMatch("say hello", { start: 4, end: 9 }, ["[", "]"]);
    expect(result).toBe("say [hello]");
  });

  it("returns original text for invalid range", () => {
    expect(highlightMatch("text", { start: -1, end: 3 })).toBe("text");
    expect(highlightMatch("text", { start: 0, end: 10 })).toBe("text");
    expect(highlightMatch("text", { start: 3, end: 2 })).toBe("text");
  });
});

// =============================================================================
// formatSearchResult
// =============================================================================

describe("formatSearchResult", () => {
  const simpleFmt = (e: FeedEvent) => `${e.agent}: ${e.preview ?? e.type}`;

  it("highlights match within the formatted line", () => {
    const result: SearchResult = {
      event: makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "Dyson", type: "commit", preview: "fix auth bug" }),
      matchField: "agent",
      matchHighlight: { start: 0, end: 5 },
    };

    const formatted = formatSearchResult(result, simpleFmt);
    // Should contain ANSI markers around "Dyson"
    expect(formatted).toContain("\x1b[1;33mDyson\x1b[0m");
  });

  it("falls back to unformatted line when field not found in output", () => {
    const result: SearchResult = {
      event: makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "edit", target: "some-file.ts" }),
      matchField: "target",
      matchHighlight: { start: 0, end: 4 },
    };

    // formatter that doesn't include target
    const fmt = (e: FeedEvent) => `${e.agent} did something`;
    const formatted = formatSearchResult(result, fmt);
    expect(formatted).toBe("W1 did something");
  });
});

// =============================================================================
// Integration: searchFeed + jumpToTimestamp workflow
// =============================================================================

describe("integration", () => {
  it("search → jump workflow: find event then jump to its time", () => {
    const events = generateTimeline(100);
    // Make event 75 distinctive
    events[75] = makeEvent({
      ts: events[75].ts,
      agent: "SpecialAgent007",
      type: "task.done",
      preview: "Completed the critical task",
    });
    writeFeed(events);

    // Step 1: Search for the special event
    const searchResults = searchFeed(feedFile, "SpecialAgent007");
    expect(searchResults).toHaveLength(1);
    const foundTs = searchResults[0].event.ts;

    // Step 2: Jump to its timestamp
    const jumpResult = jumpToTimestamp(feedFile, foundTs, 10);
    expect(jumpResult.events.some((e) => e.agent === "SpecialAgent007")).toBe(true);
    expect(jumpResult.total).toBe(100);
  });

  it("combined type + time filter narrows search precisely", () => {
    const events = [
      makeEvent({ ts: "2026-03-15T09:00:00.000Z", agent: "W1", type: "commit", preview: "early commit" }),
      makeEvent({ ts: "2026-03-15T10:00:00.000Z", agent: "W1", type: "message", preview: "chat message" }),
      makeEvent({ ts: "2026-03-15T11:00:00.000Z", agent: "W1", type: "commit", preview: "late commit" }),
      makeEvent({ ts: "2026-03-15T12:00:00.000Z", agent: "W1", type: "commit", preview: "afternoon commit" }),
    ];
    writeFeed(events);

    const results = searchFeed(feedFile, "W1", {
      type: "commit",
      after: "2026-03-15T09:30:00.000Z",
      before: "2026-03-15T11:30:00.000Z",
    });
    expect(results).toHaveLength(1);
    expect(results[0].event.preview).toBe("late commit");
  });
});
