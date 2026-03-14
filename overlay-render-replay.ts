/**
 * overlay-render-replay.ts
 *
 * Replay timeline view for the session monitor.
 * Task-13: Add session export and replay commands.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { MonitorRegistry } from "./src/monitor/registry.js";

/**
 * Render a replay timeline view for a session.
 * Calls registry.replayer.replay(sessionId) and shows reconstructed state timeline.
 */
export function renderReplayView(
  registry: MonitorRegistry,
  sessionId: string,
  width: number,
  height: number,
  scrollOffset: number,
): string[] {
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  let replayedState: import("./src/monitor/types/session.js").SessionState;
  try {
    replayedState = registry.replayer.replay(sessionId);
  } catch (e) {
    const lines: string[] = [
      `  ${YELLOW}Replay failed:${RESET} ${e instanceof Error ? e.message : String(e)}`,
    ];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const { metadata, status, metrics, events } = replayedState;
  const durationSec = (metrics.duration / 1000).toFixed(1);
  const divider = "─".repeat(Math.max(4, width - 4));
  const lines: string[] = [];

  lines.push(
    truncateToWidth(
      `  ${BOLD}── Replay: ${metadata.name}${RESET}  ${DIM}(${sessionId})${RESET}`,
      width,
    ),
  );
  lines.push(
    truncateToWidth(
      `  Status: ${CYAN}${status}${RESET}  Duration: ${durationSec}s  Events: ${metrics.eventCount}  Errors: ${metrics.errorCount}  Tools: ${metrics.toolCalls}`,
      width,
    ),
  );
  lines.push(
    truncateToWidth(
      `  Agent: ${DIM}${metadata.agent}${RESET}  Model: ${DIM}${metadata.model}${RESET}`,
      width,
    ),
  );
  lines.push(`  ${divider}`);
  lines.push(`  ${BOLD}State Timeline${RESET}`);
  lines.push(`  ${divider}`);

  if (events.length === 0) {
    lines.push(`  ${DIM}(no events recorded)${RESET}`);
  } else {
    for (const event of events) {
      let tsStr: string;
      try {
        const iso =
          typeof event.timestamp === "string"
            ? event.timestamp
            : new Date(event.timestamp as number).toISOString();
        tsStr = iso.slice(11, 19);
      } catch {
        tsStr = "--:--:--";
      }
      lines.push(truncateToWidth(`  ${DIM}[${tsStr}]${RESET} ${event.type}`, width));
    }
  }

  lines.push("");
  lines.push(`  ${DIM}esc:Back to detail${RESET}`);

  const scrolled = lines.slice(scrollOffset);
  const visible = scrolled.slice(0, height);
  while (visible.length < height) visible.push("");
  return visible;
}
