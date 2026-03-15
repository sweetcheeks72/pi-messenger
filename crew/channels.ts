/**
 * Virtual Channels — Topic Filtering (TASK-15)
 *
 * Filtered views of the same feed — not separate data stores.
 * Think Slack channels implemented as smart filters.
 *
 * 5 default channels: #all, #impl, #review, #blocked, #chat
 * getChannelEvents() applies filter, getUnreadCounts() tracks per-channel unreads.
 */

import type { FeedEvent, FeedEventType } from "../feed.js";

// =============================================================================
// Types
// =============================================================================

export interface VirtualChannel {
  /** Channel identifier, e.g. "#all", "#impl" */
  id: string;
  /** Human-readable label */
  label: string;
  /** Filter predicate — returns true if event belongs in this channel */
  filter: (event: FeedEvent) => boolean;
}

// =============================================================================
// Channel Definitions
// =============================================================================

/** Event types that belong in the #impl (Implementation) channel */
const IMPL_TYPES = new Set<FeedEventType>([
  "edit",
  "commit",
  "test",
  "task.start",
  "task.progress",
]);

/** Event types that belong in the #review channel */
const REVIEW_TYPES = new Set<FeedEventType>([
  "task.done",
  "plan.review.start",
  "plan.review.done",
  "smoke.start",
  "smoke.pass",
  "smoke.fail",
  "smoke.error",
]);

/** Event types that belong in the #blocked channel */
const BLOCKED_TYPES = new Set<FeedEventType>([
  "task.block",
  "task.escalate",
  "stuck",
  "heartbeat.stale",
]);

/** Event types that belong in the #chat channel */
const CHAT_TYPES = new Set<FeedEventType>([
  "message",
  "question.ask",
  "question.answer",
]);

/**
 * Default virtual channels.
 * #all shows everything; the rest are topic-filtered views.
 */
export const DEFAULT_CHANNELS: VirtualChannel[] = [
  { id: "#all",     label: "All Activity",    filter: () => true },
  { id: "#impl",    label: "Implementation",  filter: (e) => IMPL_TYPES.has(e.type) },
  { id: "#review",  label: "Review",          filter: (e) => REVIEW_TYPES.has(e.type) },
  { id: "#blocked", label: "Blocked",         filter: (e) => BLOCKED_TYPES.has(e.type) },
  { id: "#chat",    label: "Chat",            filter: (e) => CHAT_TYPES.has(e.type) },
];

// =============================================================================
// Core API
// =============================================================================

/**
 * Get all feed events that match a channel's filter.
 * Preserves original event order.
 */
export function getChannelEvents(
  channel: VirtualChannel,
  events: FeedEvent[],
): FeedEvent[] {
  return events.filter(channel.filter);
}

/**
 * Compute unread counts per channel.
 *
 * An event is "unread" if its timestamp is strictly after `lastSeenTs`.
 * Returns a Record mapping channel.id → unread count.
 *
 * @param channels  - Array of VirtualChannels to compute counts for
 * @param events    - Full event list
 * @param lastSeenTs - ISO timestamp; events after this are unread
 */
export function getUnreadCounts(
  channels: VirtualChannel[],
  events: FeedEvent[],
  lastSeenTs: string,
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const channel of channels) {
    let count = 0;
    for (const event of events) {
      if (event.ts > lastSeenTs && channel.filter(event)) {
        count++;
      }
    }
    counts[channel.id] = count;
  }

  return counts;
}

/**
 * Get a channel by its ID from the given list.
 * Returns undefined if not found.
 */
export function getChannelById(
  channels: VirtualChannel[],
  id: string,
): VirtualChannel | undefined {
  return channels.find((ch) => ch.id === id);
}

/**
 * Format channel tabs for status bar display.
 * Example output: "#all(12) #impl(5) #blocked(2) #chat(1)"
 *
 * @param channels    - Channel list
 * @param unreadCounts - Pre-computed unread counts from getUnreadCounts()
 * @param activeId    - Currently active channel ID (rendered with marker)
 */
export function formatChannelTabs(
  channels: VirtualChannel[],
  unreadCounts: Record<string, number>,
  activeId: string,
): string {
  return channels
    .map((ch) => {
      const count = unreadCounts[ch.id] ?? 0;
      const badge = count > 0 ? `(${count})` : "";
      const marker = ch.id === activeId ? ">" : " ";
      return `${marker}${ch.id}${badge}`;
    })
    .join(" ");
}
