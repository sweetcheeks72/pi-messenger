/**
 * Thread Model for Feed Events (TASK-05)
 *
 * Provides thread grouping, filtering, and auto-population of thread fields
 * on FeedEvent. Designed to be consumed by overlay-render.ts for threaded
 * feed display with reply indicators and collapse.
 */

import type { FeedEvent } from "../feed.js";
import type { ThreadGroup, ThreadRenderOptions } from "./types.js";
import { DEFAULT_THREAD_RENDER_OPTIONS } from "./types.js";

// =============================================================================
// Thread Population
// =============================================================================

/**
 * Auto-populate thread fields on a new event when it is a reply.
 *
 * - Finds the parent event by `replyToTs` in `allEvents`
 * - Sets `threadId` to the parent's threadId (or parent's ts if parent is root)
 * - Sets `parentEventTs` to the parent's ts
 *
 * Returns a new event object with thread fields set (does not mutate input).
 */
export function populateThreadFields(
  event: FeedEvent,
  replyToTs: string,
  allEvents: ReadonlyArray<FeedEvent>,
): FeedEvent {
  const parent = allEvents.find((e) => e.ts === replyToTs);
  if (!parent) return event;

  // If parent already belongs to a thread, join that thread.
  // Otherwise, the parent is the root → use parent.ts as threadId.
  const threadId = parent.threadId ?? parent.ts;

  return {
    ...event,
    threadId,
    parentEventTs: parent.ts,
  };
}

// =============================================================================
// Thread Queries
// =============================================================================

/**
 * Get all events belonging to a specific thread (including the root).
 * Returns events sorted by timestamp (ascending).
 */
export function getThread(
  threadId: string,
  events: ReadonlyArray<FeedEvent>,
): FeedEvent[] {
  return events
    .filter((e) => e.threadId === threadId || e.ts === threadId)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Compute the reply count for a thread by counting events that have
 * the given threadId AND a parentEventTs (i.e., they are replies, not roots).
 */
export function getReplyCount(
  threadId: string,
  events: ReadonlyArray<FeedEvent>,
): number {
  return events.filter(
    (e) => e.threadId === threadId && e.parentEventTs != null,
  ).length;
}

// =============================================================================
// Thread Grouping
// =============================================================================

/**
 * Group an array of events into ThreadGroup structures.
 *
 * Root events (no threadId or ts === threadId) anchor each group.
 * Replies (threadId set, parentEventTs set) attach to their root.
 * Events with no thread affiliation become single-event groups.
 *
 * Groups are returned in the order the root event first appears in `events`.
 */
export function groupByThread(
  events: ReadonlyArray<FeedEvent>,
): ThreadGroup[] {
  const replyMap = new Map<string, FeedEvent[]>();
  const rootOrder: FeedEvent[] = [];
  const rootSeen = new Set<string>();

  for (const event of events) {
    if (event.threadId && event.parentEventTs) {
      // This is a reply — bucket under its threadId
      const bucket = replyMap.get(event.threadId);
      if (bucket) {
        bucket.push(event);
      } else {
        replyMap.set(event.threadId, [event]);
      }
    } else if (event.threadId && !event.parentEventTs) {
      // Root event that has been tagged with its own threadId
      // (e.g., after a reply was added and root was updated)
      if (!rootSeen.has(event.ts)) {
        rootOrder.push(event);
        rootSeen.add(event.ts);
      }
    } else {
      // Regular event or thread root (no threadId set)
      if (!rootSeen.has(event.ts)) {
        rootOrder.push(event);
        rootSeen.add(event.ts);
      }
    }
  }

  const groups: ThreadGroup[] = [];

  for (const root of rootOrder) {
    const replies = (replyMap.get(root.ts) ?? []).sort((a, b) =>
      a.ts.localeCompare(b.ts),
    );
    replyMap.delete(root.ts);

    groups.push({
      rootEvent: root,
      replies,
      replyCount: replies.length,
    });
  }

  // Handle orphaned replies whose root is outside the visible window
  for (const [threadId, replies] of replyMap) {
    if (replies.length > 0) {
      const sorted = replies.sort((a, b) => a.ts.localeCompare(b.ts));
      groups.push({
        rootEvent: sorted[0],
        replies: sorted.slice(1),
        replyCount: sorted.length - 1, // exclude the pseudo-root from reply count
      });
    }
  }

  return groups;
}

// =============================================================================
// Thread Rendering Helpers
// =============================================================================

/**
 * Format a thread collapse indicator string.
 * Returns empty string if there are no replies.
 */
export function formatCollapseIndicator(replyCount: number): string {
  if (replyCount <= 0) return "";
  return `[${replyCount} ${replyCount === 1 ? "reply" : "replies"}]`;
}

/**
 * Format a reply line prefix with tree indicators.
 * Uses ├─ for intermediate replies, └─ for the last reply.
 */
export function formatReplyPrefix(isLast: boolean): string {
  return isLast ? "└─" : "├─";
}

/**
 * Determine whether a thread should be collapsed based on render options.
 * A thread is collapsed when its reply count exceeds maxInlineReplies.
 */
export function shouldCollapse(
  replyCount: number,
  options: ThreadRenderOptions = DEFAULT_THREAD_RENDER_OPTIONS,
): boolean {
  return replyCount > options.maxInlineReplies;
}

/**
 * Render a single ThreadGroup into display lines.
 *
 * Format:
 *   <root event line>           [N replies]
 *     ├─ <reply 1 line>
 *     ├─ <reply 2 line>
 *     └─ <reply 3 line>
 *
 * When collapsed (replies > maxInlineReplies):
 *   <root event line>           [N replies]
 *     ├─ <first reply>
 *     └─ ... and N-1 more replies
 *
 * @param formatLine - Callback to format a FeedEvent into a display string
 * @param group - The ThreadGroup to render
 * @param options - Rendering options
 * @returns Array of formatted lines
 */
export function renderThreadGroup(
  group: ThreadGroup,
  formatLine: (event: FeedEvent) => string,
  options: ThreadRenderOptions = DEFAULT_THREAD_RENDER_OPTIONS,
): string[] {
  const lines: string[] = [];

  // Root line with collapse indicator
  const rootLine = formatLine(group.rootEvent);
  const indicator = formatCollapseIndicator(group.replyCount);
  lines.push(indicator ? `${rootLine}  ${indicator}` : rootLine);

  if (group.replies.length === 0) return lines;

  if (!options.showReplyIndicators) {
    // No indicators — just indent replies
    for (const reply of group.replies) {
      lines.push(`  ${formatLine(reply)}`);
    }
    return lines;
  }

  const collapsed = shouldCollapse(group.replyCount, options);

  if (!collapsed) {
    // Show all replies with tree indicators
    for (let i = 0; i < group.replies.length; i++) {
      const isLast = i === group.replies.length - 1;
      const prefix = formatReplyPrefix(isLast);
      lines.push(`  ${prefix} ${formatLine(group.replies[i])}`);
    }
  } else {
    // Collapsed: show first reply + "and N more" indicator
    lines.push(`  ${formatReplyPrefix(false)} ${formatLine(group.replies[0])}`);
    const remaining = group.replyCount - 1;
    lines.push(
      `  ${formatReplyPrefix(true)} ... and ${remaining} more ${remaining === 1 ? "reply" : "replies"}`,
    );
  }

  return lines;
}
