/**
 * Reactions/Emoji on Feed Events (TASK-14)
 *
 * Lightweight reaction system using a sidecar JSON file
 * (feed-reactions.json) to avoid JSONL rewrite of the main feed.
 *
 * Provides addReaction(), removeReaction(), and rendering helpers.
 * Limited emoji set: ✅ 👀 ❌ 🔥 ⏸️
 */

import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

/** Map: emoji → agent names who reacted */
export type EmojiReactions = Record<string, string[]>;

/** Map: eventTs → EmojiReactions */
export type ReactionMap = Record<string, EmojiReactions>;

// =============================================================================
// Constants
// =============================================================================

/** Whitelisted emoji for reactions — limited picker set */
export const ALLOWED_EMOJI: readonly string[] = ["✅", "👀", "❌", "🔥", "⏸️"];

const ALLOWED_SET = new Set(ALLOWED_EMOJI);

// =============================================================================
// Sidecar I/O
// =============================================================================

function sidecarPath(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "feed-reactions.json");
}

function readSidecar(cwd: string): ReactionMap {
  const p = sidecarPath(cwd);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ReactionMap;
    }
    return {};
  } catch {
    return {};
  }
}

function writeSidecar(cwd: string, data: ReactionMap): void {
  const p = sidecarPath(cwd);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

// =============================================================================
// Core API
// =============================================================================

/**
 * Add a reaction to a feed event.
 *
 * @param cwd - Project working directory
 * @param eventTs - Timestamp key of the target FeedEvent
 * @param emoji - One of ALLOWED_EMOJI
 * @param agentName - Name of the agent adding the reaction
 * @throws Error if emoji is not in ALLOWED_EMOJI
 */
export function addReaction(
  cwd: string,
  eventTs: string,
  emoji: string,
  agentName: string,
): void {
  if (!ALLOWED_SET.has(emoji)) {
    throw new Error(`Emoji "${emoji}" is not allowed. Allowed: ${ALLOWED_EMOJI.join(" ")}`);
  }

  const data = readSidecar(cwd);

  if (!data[eventTs]) {
    data[eventTs] = {};
  }

  if (!data[eventTs][emoji]) {
    data[eventTs][emoji] = [];
  }

  // Deduplicate: don't add the same agent twice for the same emoji
  if (!data[eventTs][emoji].includes(agentName)) {
    data[eventTs][emoji].push(agentName);
  }

  writeSidecar(cwd, data);
}

/**
 * Remove a reaction from a feed event.
 *
 * No-op if the reaction doesn't exist, the event has no reactions,
 * or the sidecar file doesn't exist.
 *
 * @param cwd - Project working directory
 * @param eventTs - Timestamp key of the target FeedEvent
 * @param emoji - One of ALLOWED_EMOJI
 * @param agentName - Name of the agent removing the reaction
 */
export function removeReaction(
  cwd: string,
  eventTs: string,
  emoji: string,
  agentName: string,
): void {
  const data = readSidecar(cwd);

  const eventReactions = data[eventTs];
  if (!eventReactions) return;

  const agents = eventReactions[emoji];
  if (!agents) return;

  const idx = agents.indexOf(agentName);
  if (idx === -1) return;

  agents.splice(idx, 1);

  // Clean up empty arrays/objects
  if (agents.length === 0) {
    delete eventReactions[emoji];
  }

  if (Object.keys(eventReactions).length === 0) {
    delete data[eventTs];
  }

  writeSidecar(cwd, data);
}

// =============================================================================
// Query API
// =============================================================================

/**
 * Get the full reaction map for all events.
 */
export function getReactions(cwd: string): ReactionMap {
  return readSidecar(cwd);
}

/**
 * Get reactions for a specific event.
 * Returns an empty object if no reactions exist.
 */
export function getReactionsForEvent(cwd: string, eventTs: string): EmojiReactions {
  const data = readSidecar(cwd);
  return data[eventTs] ?? {};
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Format reaction badges for inline display.
 *
 * Input:  { "✅": ["A", "B"], "🔥": ["C"] }
 * Output: "[✅2 🔥1]"
 *
 * Emoji are sorted in ALLOWED_EMOJI order. Empty arrays are omitted.
 * Returns empty string if no reactions.
 */
export function formatReactionBadges(emojiReactions: EmojiReactions): string {
  const parts: string[] = [];

  for (const emoji of ALLOWED_EMOJI) {
    const agents = emojiReactions[emoji];
    if (agents && agents.length > 0) {
      parts.push(`${emoji}${agents.length}`);
    }
  }

  if (parts.length === 0) return "";
  return `[${parts.join(" ")}]`;
}
