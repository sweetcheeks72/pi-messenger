/**
 * Feed Full-Text Search + Timeline Navigation (TASK-16)
 *
 * Provides searchFeed() for full-text search across feed events
 * (preview, agent, target, richContent fields) with match highlight
 * ranges. jumpToTimestamp() for timeline navigation — returns a
 * window of events around a given ISO timestamp.
 *
 * Designed for Vim-like `/` search mode and `g` timestamp jump in
 * the TUI overlay.
 */

import * as fs from "node:fs";
import type { FeedEvent, FeedEventType } from "../feed.js";

// =============================================================================
// Types
// =============================================================================

/**
 * A single search result with the matched event, which field matched,
 * and the character range of the match within that field's text.
 */
export interface SearchResult {
  /** The feed event that matched */
  event: FeedEvent;
  /** Which field the match was found in */
  matchField: "preview" | "agent" | "target" | "content";
  /** Character range of the match within the field value */
  matchHighlight: { start: number; end: number };
}

/**
 * Options for filtering and limiting search results.
 */
export interface SearchOptions {
  /** Maximum number of results to return (default: 50) */
  limit?: number;
  /** Only include events after this ISO timestamp */
  after?: string;
  /** Only include events before this ISO timestamp */
  before?: string;
  /** Only include events of this type */
  type?: FeedEventType;
}

/**
 * Result of a timeline jump — a window of events around the target timestamp.
 */
export interface JumpResult {
  /** Events in the window around the target timestamp */
  events: FeedEvent[];
  /** Index offset of the first returned event within the full feed */
  offset: number;
  /** Total number of events in the feed */
  total: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_JUMP_WINDOW = 20;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Read all events from a feed.jsonl file.
 * Returns empty array if file doesn't exist or is unreadable.
 */
function readAllEvents(feedPath: string): FeedEvent[] {
  if (!fs.existsSync(feedPath)) return [];
  try {
    const content = fs.readFileSync(feedPath, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const events: FeedEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Extract searchable text from RichContent blocks.
 */
function extractRichContentText(event: FeedEvent): string {
  if (!event.richContent || event.richContent.length === 0) return "";
  return event.richContent.map((block) => block.content).join(" ");
}

/**
 * Apply time-range and type filters to an event.
 */
function matchesFilters(event: FeedEvent, options: SearchOptions): boolean {
  if (options.after && event.ts <= options.after) return false;
  if (options.before && event.ts >= options.before) return false;
  if (options.type && event.type !== options.type) return false;
  return true;
}

/**
 * Parse a relative time string like "1h ago", "30m ago", "2d ago"
 * into an ISO timestamp. Returns null if not a valid relative time.
 */
export function parseRelativeTime(input: string, now?: Date): string | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(
    /^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)\s*(ago)?$/,
  );
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const reference = now ?? new Date();
  const ms = reference.getTime();

  let offsetMs: number;
  if (unit.startsWith("s")) {
    offsetMs = amount * 1000;
  } else if (unit.startsWith("m")) {
    offsetMs = amount * 60 * 1000;
  } else if (unit.startsWith("h")) {
    offsetMs = amount * 60 * 60 * 1000;
  } else if (unit.startsWith("d")) {
    offsetMs = amount * 24 * 60 * 60 * 1000;
  } else {
    return null;
  }

  return new Date(ms - offsetMs).toISOString();
}

// =============================================================================
// Core API
// =============================================================================

/**
 * Search feed events by a case-insensitive text query.
 *
 * Searches across four fields in priority order:
 *   1. agent — agent name
 *   2. preview — event preview text
 *   3. target — event target (task ID, file path, etc.)
 *   4. content — rich content text (concatenated from richContent blocks)
 *
 * Each matching event appears at most once (first matching field wins).
 * Results are returned in chronological order (oldest first).
 *
 * @param feedPath - Path to the feed.jsonl file
 * @param query    - Search string (case-insensitive substring match)
 * @param options  - Optional filters: limit, after, before, type
 * @returns Array of SearchResult with highlighted match ranges
 */
export function searchFeed(
  feedPath: string,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  if (!query || query.trim() === "") return [];

  const events = readAllEvents(feedPath);
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const event of events) {
    if (results.length >= limit) break;
    if (!matchesFilters(event, options)) continue;

    const match = findMatchInEvent(event, queryLower);
    if (match) {
      results.push(match);
    }
  }

  return results;
}

/**
 * Find the first matching field in a FeedEvent for a given query.
 */
function findMatchInEvent(
  event: FeedEvent,
  queryLower: string,
): SearchResult | null {
  const fields: Array<{
    field: SearchResult["matchField"];
    value: string | undefined;
  }> = [
    { field: "agent", value: event.agent },
    { field: "preview", value: event.preview },
    { field: "target", value: event.target },
    { field: "content", value: extractRichContentText(event) },
  ];

  for (const { field, value } of fields) {
    if (!value) continue;
    const idx = value.toLowerCase().indexOf(queryLower);
    if (idx !== -1) {
      return {
        event,
        matchField: field,
        matchHighlight: { start: idx, end: idx + queryLower.length },
      };
    }
  }

  return null;
}

/**
 * Jump to a position in the feed near a target timestamp.
 *
 * Uses binary search to find the closest event to `targetTs`, then returns
 * a window of events centered around that position.
 *
 * The `targetTs` can be:
 *   - An ISO timestamp (e.g., "2026-03-15T10:30:00.000Z")
 *   - A relative time string (e.g., "1h ago", "30m ago")
 *
 * @param feedPath   - Path to the feed.jsonl file
 * @param targetTs   - ISO timestamp or relative time to jump to
 * @param windowSize - Number of events to return (default: 20)
 * @returns JumpResult with events, offset, and total count
 */
export function jumpToTimestamp(
  feedPath: string,
  targetTs: string,
  windowSize: number = DEFAULT_JUMP_WINDOW,
): JumpResult {
  const events = readAllEvents(feedPath);
  const total = events.length;

  if (total === 0) {
    return { events: [], offset: 0, total: 0 };
  }

  // Resolve relative time first
  const resolved = parseRelativeTime(targetTs) ?? targetTs;

  // Binary search for closest event
  const targetIdx = binarySearchClosest(events, resolved);

  // Center the window around the found index
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, targetIdx - halfWindow);
  const end = Math.min(total, start + windowSize);

  // Adjust start if we hit the end of the feed
  if (end === total) {
    start = Math.max(0, end - windowSize);
  }

  return {
    events: events.slice(start, end),
    offset: start,
    total,
  };
}

/**
 * Binary search for the index of the event closest to `targetTs`.
 * Events are assumed to be in chronological order (ascending ts).
 */
function binarySearchClosest(events: FeedEvent[], targetTs: string): number {
  let lo = 0;
  let hi = events.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (events[mid].ts < targetTs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first event >= targetTs. Check if lo-1 is closer.
  if (lo > 0) {
    const diffBefore = Math.abs(
      new Date(targetTs).getTime() - new Date(events[lo - 1].ts).getTime(),
    );
    const diffAt = Math.abs(
      new Date(targetTs).getTime() - new Date(events[lo].ts).getTime(),
    );
    if (diffBefore < diffAt) {
      return lo - 1;
    }
  }

  return lo;
}

/**
 * Highlight a match within a string by wrapping it with markers.
 *
 * @param text      - The original text
 * @param highlight - The match range { start, end }
 * @param markers   - [open, close] markers (default: ANSI bold yellow)
 */
export function highlightMatch(
  text: string,
  highlight: { start: number; end: number },
  markers: [string, string] = ["\x1b[1;33m", "\x1b[0m"],
): string {
  const { start, end } = highlight;
  if (start < 0 || end > text.length || start >= end) return text;
  return (
    text.slice(0, start) +
    markers[0] +
    text.slice(start, end) +
    markers[1] +
    text.slice(end)
  );
}

/**
 * Format a search result for TUI display using a line formatter.
 */
export function formatSearchResult(
  result: SearchResult,
  formatLine: (event: FeedEvent) => string,
): string {
  const line = formatLine(result.event);
  const fieldValue = getFieldValue(result.event, result.matchField);
  if (!fieldValue) return line;

  // Find where the field value appears in the formatted line
  const fieldIdx = line.toLowerCase().indexOf(fieldValue.toLowerCase());
  if (fieldIdx === -1) return line;

  // Remap highlight range to the formatted line position
  const adjustedStart = fieldIdx + result.matchHighlight.start;
  const adjustedEnd = fieldIdx + result.matchHighlight.end;

  return highlightMatch(line, { start: adjustedStart, end: adjustedEnd });
}

/**
 * Get the raw string value of a matched field from a FeedEvent.
 */
function getFieldValue(
  event: FeedEvent,
  field: SearchResult["matchField"],
): string | undefined {
  switch (field) {
    case "agent":
      return event.agent;
    case "preview":
      return event.preview;
    case "target":
      return event.target;
    case "content":
      return extractRichContentText(event);
    default:
      return undefined;
  }
}
