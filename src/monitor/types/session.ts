import { z } from "zod";

interface WorkerLike {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  startedAt: number;
  progress: {
    model?: string;
  };
}

export const SessionStatusSchema = z.enum(["idle", "active", "paused", "ended", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  model: z.string(),
  startedAt: z.string().datetime(),
  agent: z.string(),
  taskId: z.string().optional(),
  workerPid: z.number().int().optional(),
  agentRole: z.string().optional(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export const SessionMetricsSchema = z.object({
  duration: z.number().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
});
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

/**
 * SessionHistoryEntry — a lightweight session-history record (type + timestamp + optional data).
 * This is the simple event format stored on SessionState.events.
 *
 * Note: For the rich stream-event type used by SessionEventEmitter, see
 * src/monitor/events/types.ts which exports its own SessionEvent / SessionEventSchema.
 * Prefer importing from the correct module to avoid name collisions.
 */
export const SessionHistoryEntrySchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime(),
  data: z.unknown().optional(),
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;

// Backward-compat aliases (use SessionHistoryEntry / SessionHistoryEntrySchema for new code)
export const SessionEventSchema = SessionHistoryEntrySchema;
export type SessionEvent = SessionHistoryEntry;

export const SessionStateSchema = z.object({
  status: SessionStatusSchema,
  metadata: SessionMetadataSchema,
  metrics: SessionMetricsSchema,
  events: z.array(SessionHistoryEntrySchema),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export function buildWorkerSessionMetadata(worker: WorkerLike): SessionMetadata {
  return SessionMetadataSchema.parse({
    id: worker.taskId,
    name: worker.name,
    cwd: worker.cwd,
    model: worker.progress.model ?? "unknown",
    startedAt: new Date(worker.startedAt).toISOString(),
    agent: worker.agent,
    taskId: worker.taskId,
    agentRole: worker.agent,
  });
}

import type { LiveWorkerInfo, WorkerRuntimeSession } from "../../../crew/live-progress.js";

export function buildWorkerSessionState(
  worker: LiveWorkerInfo,
  runtime?: WorkerRuntimeSession,
): SessionState {
  const metadata = buildWorkerSessionMetadata(worker);

  const statusMap: Record<string, SessionStatus> = {
    running: "active",
    completed: "ended",
    failed: "error",
    pending: "idle",
  };
  const status: SessionStatus = statusMap[worker.progress.status] ?? "idle";

  const metrics: SessionMetrics = {
    duration: worker.progress.durationMs,
    eventCount: runtime?.events.length ?? 0,
    errorCount: 0,
    toolCalls: worker.progress.toolCallCount,
    tokensUsed: worker.progress.tokens,
  };

  const events: SessionHistoryEntry[] = [];

  // session.start
  events.push({ type: "session.start", timestamp: new Date(worker.startedAt).toISOString() });

  // runtime events
  if (runtime) {
    for (const { event, timestamp } of runtime.events) {
      const ts = new Date(timestamp).toISOString();
      if (event.type === "tool_execution_start") {
        events.push({ type: "tool.call", timestamp: ts, data: { toolName: event.toolName, args: event.args } });
      } else if (event.type === "tool_execution_end") {
        const textItem = event.result?.content?.find((c) => c.type === "text");
        if (textItem?.text != null) {
          events.push({ type: "execution.output", timestamp: ts, data: { text: textItem.text, stream: "stdout" } });
        }
      } else if (event.type === "message_end") {
        const textItem = event.message?.content?.find((c) => c.type === "text");
        if (event.message?.role === "assistant" && textItem?.text != null) {
          events.push({ type: "agent.progress", timestamp: ts, data: { message: textItem.text, step: "assistant-response" } });
        }
      }
    }

    // terminal event
    if (status === "ended") {
      events.push({
        type: "session.end",
        timestamp: new Date(runtime.endedAt ?? worker.startedAt).toISOString(),
        data: { summary: runtime.finalOutput, exitCode: runtime.exitCode },
      });
    } else if (status === "error") {
      events.push({
        type: "session.error",
        timestamp: new Date(runtime.endedAt ?? worker.startedAt).toISOString(),
        data: { error: runtime.finalError },
      });
    }
  }

  return { status, metadata, metrics, events };
}
