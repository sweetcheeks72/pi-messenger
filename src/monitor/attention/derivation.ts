import type { SessionState } from "../types/session.js";
import type { HealthStatus } from "../health/types.js";
import type { ComputedMetrics } from "../metrics/aggregator.js";
import type { AttentionItem } from "../types/attention.js";

const STALE_RUNNING_AFTER_MS = 30_000;
const REPEAT_RETRY_COUNT = 2;

function getLatestPayloadText(
  session: SessionState,
  predicate: (type: string) => boolean,
  keys: string[] = ["reason", "message"],
): string | null {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i] as { type: string; data?: unknown; payload?: unknown };
    if (!predicate(event.type)) continue;

    const payload = event.data ?? event.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }

    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return null;
}

function countRetryActions(session: SessionState): number {
  let count = 0;

  for (const event of session.events) {
    const payload = (event as { data?: unknown; payload?: unknown }).data
      ?? (event as { data?: unknown; payload?: unknown }).payload;

    if (!payload || typeof payload !== "object") {
      continue;
    }

    const action = (payload as Record<string, unknown>).action;
    if (typeof action === "string" && action.toLowerCase() === "retry") {
      count += 1;
    }
  }

  return count;
}

function lastActivityAt(session: SessionState): number {
  let latest = Date.parse(session.metadata.startedAt);

  for (const event of session.events) {
    const timestamp = Date.parse(event.timestamp);
    if (Number.isFinite(timestamp)) {
      latest = Math.max(latest, timestamp);
    }
  }

  return latest;
}

function isStaleRunning(nowMs: number, session: SessionState): boolean {
  if (session.status !== "active") return false;

  const latest = lastActivityAt(session);
  return Number.isFinite(latest) && nowMs - latest >= STALE_RUNNING_AFTER_MS;
}

function buildItem(
  sessionId: string,
  reason: AttentionItem["reason"],
  message: string,
  recommendedAction: string,
  timestamp: string,
): AttentionItem {
  return {
    id: `att-${sessionId}-${reason}`,
    sessionId,
    reason,
    message,
    recommendedAction,
    timestamp,
  };
}

export function deriveAttentionItems(
  sessions: SessionState[],
  healthMap: Map<string, HealthStatus>,
  _metricsMap: Map<string, ComputedMetrics>,
  nowMs?: number,
): AttentionItem[] {
  const now = nowMs ?? Date.now();
  const timestamp = new Date(now).toISOString();
  const items: AttentionItem[] = [];

  for (const session of sessions) {
    const health = healthMap.get(session.metadata.id);
    const retryCount = countRetryActions(session);

    if (session.status === "paused" || session.status === "idle") {
      const reason = getLatestPayloadText(
        session,
        (type) => type.includes("pause") || type.includes("waiting"),
      );
      const message = reason && reason.length > 0
        ? reason
        : "Session is waiting for human input.";

      items.push(
        buildItem(
          session.metadata.id,
          "waiting_on_human",
          message,
          "Resume after operator input.",
          timestamp,
        ),
      );
      continue;
    }

    if (session.status === "error") {
      if (retryCount >= REPEAT_RETRY_COUNT) {
        items.push(
          buildItem(
            session.metadata.id,
            "repeated_retries",
            `Session has retried ${retryCount} times and is still failing.`,
            "Inspect logs, retry manually, or escalate for intervention.",
            timestamp,
          ),
        );
      } else {
        items.push(
          buildItem(
            session.metadata.id,
            "failed_recoverable",
            "Session failed with a recoverable error.",
            "Review logs and retry after applying a fix.",
            timestamp,
          ),
        );
      }
      continue;
    }

    if (health === "critical" && session.status === "active") {
      items.push(
        buildItem(
          session.metadata.id,
          "stuck",
          "Session appears stuck with no recent progress.",
          "Investigate and inspect whether the session is blocked.",
          timestamp,
        ),
      );
      continue;
    }

    if (health === "degraded" && session.status === "active") {
      const degradeReason = getLatestPayloadText(
        session,
        (type) => type.includes("health") || type.includes("error"),
      );

      if (isStaleRunning(now, session)) {
        items.push(
          buildItem(
            session.metadata.id,
            "stale_running",
            "Session is degraded with no recent activity.",
            "Check the session logs and restart the run if needed.",
            timestamp,
          ),
        );
      } else {
        items.push(
          buildItem(
            session.metadata.id,
            "degraded",
            degradeReason
              ? `Session is degraded: ${degradeReason}`
              : "Session is degraded.",
            "Monitor and intervene only if progress does not resume.",
            timestamp,
          ),
        );
      }
    }
  }

  return items;
}
