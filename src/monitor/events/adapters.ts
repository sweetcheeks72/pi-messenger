import { createHash, randomUUID } from "node:crypto";
import type { HealthAlert } from "../health/types.js";
import {
  SessionStreamEventSchema,
  type SessionStreamEvent,
  type SessionDiagnosticCode,
  type SessionStreamSeverity,
} from "./types.js";

interface PiEventLike {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  isError?: boolean;
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
    errorMessage?: string;
  };
}

interface WorkerProgressLike {
  status: "pending" | "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  toolCallCount: number;
  tokens: number;
  error?: string;
}

interface LiveWorkerLike {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  startedAt: number;
  progress: WorkerProgressLike;
}

export interface SessionStreamContext {
  sessionId: string;
  sequence?: number;
  timestamp?: number;
  currentToolName?: string;
}

export interface WarningGroupingOptions {
  withinMs?: number;
}

function createFingerprint(parts: Array<string | undefined>): string {
  return createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function buildSummary(event: Pick<SessionStreamEvent, "type" | "payload">): string {
  switch (event.payload.type) {
    case "session.start":
      return `${event.payload.agentName} started`;
    case "session.pause":
      return event.payload.reason ? `Paused: ${event.payload.reason}` : "Session paused";
    case "session.resume":
      return event.payload.resumedBy ? `Resumed by ${event.payload.resumedBy}` : "Session resumed";
    case "session.end":
      return event.payload.summary ?? "Session completed";
    case "session.error":
      return event.payload.message;
    case "tool.call":
      return `Running ${event.payload.toolName}`;
    case "tool.result":
      return event.payload.success ? `${event.payload.toolName} succeeded` : `${event.payload.toolName} failed`;
    case "health.alert":
      return event.payload.message;
    case "health.check":
      return `Health ${event.payload.status}`;
    case "agent.thinking":
      return event.payload.message;
    case "agent.waiting":
      return event.payload.reason ?? "Waiting";
    case "agent.progress":
      return event.payload.message ?? event.payload.step ?? "Progress update";
    case "execution.start":
      return `Executing ${event.payload.command}`;
    case "execution.output":
      return event.payload.text;
    case "execution.end":
      return event.payload.success === false ? "Execution failed" : "Execution finished";
    case "metrics.snapshot":
      return `Metrics snapshot (${event.payload.toolCallCount} tools)`;
    case "operator.action":
      return `Operator ${event.payload.action}`;
  }
}

function inferDiagnosticCode(message: string): SessionDiagnosticCode {
  const lower = message.toLowerCase();
  if (lower.includes("stuck")) return "stuck";
  if (lower.includes("stale")) return "stale";
  if (lower.includes("error rate")) return "high_error_rate";
  if (lower.includes("waiting") || lower.includes("approval") || lower.includes("human")) {
    return "waiting_on_human";
  }
  return "unknown";
}

function buildDiagnostic(
  code: SessionDiagnosticCode,
  severity: SessionStreamSeverity,
  message: string,
  component?: string,
) {
  const fingerprint = createFingerprint([code, severity, component, message]);
  return {
    code,
    severity,
    fingerprint,
    dedupeKey: `${code}:${component ?? "global"}`,
    repeatCount: 1,
  };
}

function parseStreamEvent(event: Omit<SessionStreamEvent, "summary"> & { summary?: string }): SessionStreamEvent {
  return SessionStreamEventSchema.parse({
    ...event,
    summary: event.summary ?? buildSummary(event),
  });
}

export function mapPiEventToSessionStreamEvent(
  event: PiEventLike,
  context: SessionStreamContext,
): SessionStreamEvent | null {
  const sequence = context.sequence ?? 0;
  const timestamp = context.timestamp ?? Date.now();

  switch (event.type) {
    case "tool_execution_start":
      return parseStreamEvent({
        id: randomUUID(),
        type: "tool.call",
        source: "pi-runtime",
        sessionId: context.sessionId,
        timestamp,
        sequence,
        payload: {
          type: "tool.call",
          toolName: event.toolName ?? "unknown",
          args: event.args,
        },
        rawType: event.type,
        raw: event as unknown as Record<string, unknown>,
      });

    case "tool_execution_end": {
      const toolName = event.toolName ?? context.currentToolName ?? "unknown";
      const error =
        event.message?.errorMessage ??
        (event.result?.isError ? event.result.content?.map((part) => part.text ?? "").join(" ").trim() : undefined);

      return parseStreamEvent({
        id: randomUUID(),
        type: "tool.result",
        source: "pi-runtime",
        sessionId: context.sessionId,
        timestamp,
        sequence,
        payload: {
          type: "tool.result",
          toolName,
          success: !(event.isError || event.result?.isError),
          error: error || undefined,
        },
        rawType: event.type,
        raw: event as unknown as Record<string, unknown>,
      });
    }

    case "message_end": {
      const text = event.message?.content?.find((part) => part.type === "text")?.text?.trim();
      if (event.message?.errorMessage) {
        return parseStreamEvent({
          id: randomUUID(),
          type: "session.error",
          source: "pi-runtime",
          sessionId: context.sessionId,
          timestamp,
          sequence,
          payload: {
            type: "session.error",
            message: event.message.errorMessage,
            fatal: true,
          },
          diagnostic: buildDiagnostic("session_error", "critical", event.message.errorMessage),
          rawType: event.type,
          raw: event as unknown as Record<string, unknown>,
        });
      }

      if (event.message?.role === "assistant" && text) {
        return parseStreamEvent({
          id: randomUUID(),
          type: "agent.progress",
          source: "pi-runtime",
          sessionId: context.sessionId,
          timestamp,
          sequence,
          payload: {
            type: "agent.progress",
            message: text,
            step: "assistant-response",
          },
          rawType: event.type,
          raw: event as unknown as Record<string, unknown>,
        });
      }

      return null;
    }

    default:
      return null;
  }
}

export function mapWorkerSnapshotToSessionStreamEvent(
  worker: LiveWorkerLike,
  context?: Partial<SessionStreamContext>,
): SessionStreamEvent {
  const sessionId = context?.sessionId ?? worker.taskId;
  const sequence = context?.sequence ?? 0;
  const timestamp = context?.timestamp ?? Date.now();

  if (worker.progress.error) {
    return parseStreamEvent({
      id: randomUUID(),
      type: "session.error",
      source: "messenger-runtime",
      sessionId,
      timestamp,
      sequence,
      payload: {
        type: "session.error",
        message: worker.progress.error,
        fatal: worker.progress.status === "failed",
      },
      diagnostic: buildDiagnostic(
        "session_error",
        worker.progress.status === "failed" ? "critical" : "error",
        worker.progress.error,
      ),
      rawType: "worker.snapshot",
      raw: { taskId: worker.taskId, name: worker.name, agent: worker.agent, progress: worker.progress },
    });
  }

  if (worker.progress.currentTool) {
    return parseStreamEvent({
      id: randomUUID(),
      type: "tool.call",
      source: "messenger-runtime",
      sessionId,
      timestamp,
      sequence,
      payload: {
        type: "tool.call",
        toolName: worker.progress.currentTool,
        args: worker.progress.currentToolArgs
          ? { preview: worker.progress.currentToolArgs }
          : undefined,
      },
      rawType: "worker.snapshot",
      raw: { taskId: worker.taskId, name: worker.name, agent: worker.agent, progress: worker.progress },
    });
  }

  if (worker.progress.status === "pending") {
    return parseStreamEvent({
      id: randomUUID(),
      type: "agent.waiting",
      source: "messenger-runtime",
      sessionId,
      timestamp,
      sequence,
      payload: {
        type: "agent.waiting",
        reason: "Queued for execution",
      },
      rawType: "worker.snapshot",
      raw: { taskId: worker.taskId, name: worker.name, agent: worker.agent, progress: worker.progress },
    });
  }

  return parseStreamEvent({
    id: randomUUID(),
    type: "agent.thinking",
    source: "messenger-runtime",
    sessionId,
    timestamp,
    sequence,
    payload: {
      type: "agent.thinking",
      message: worker.progress.status === "completed" ? "Completed work" : `Thinking as ${worker.name}`,
      metadata: {
        taskId: worker.taskId,
        toolCallCount: worker.progress.toolCallCount,
        tokens: worker.progress.tokens,
      },
    },
    rawType: "worker.snapshot",
    raw: { taskId: worker.taskId, name: worker.name, agent: worker.agent, progress: worker.progress },
  });
}

export function mapHealthAlertToSessionStreamEvent(
  alert: HealthAlert,
  context?: Partial<SessionStreamContext>,
): SessionStreamEvent {
  const severity: SessionStreamSeverity = alert.status === "critical" ? "critical" : "warning";
  const code = inferDiagnosticCode(alert.reason);

  return parseStreamEvent({
    id: randomUUID(),
    type: "health.alert",
    source: "health-monitor",
    sessionId: context?.sessionId ?? alert.sessionId,
    timestamp: context?.timestamp ?? alert.detectedAt,
    sequence: context?.sequence ?? 0,
    payload: {
      type: "health.alert",
      severity: alert.status === "critical" ? "critical" : "warning",
      message: alert.reason,
      component: "SessionHealthMonitor",
    },
    diagnostic: buildDiagnostic(code, severity, alert.reason, "SessionHealthMonitor"),
    rawType: "health.alert",
    raw: { ...alert } as Record<string, unknown>,
  });
}

function isRepeatableWarning(event: SessionStreamEvent): boolean {
  return (event.severity === "warning" || event.severity === "critical") && Boolean(
    event.diagnostic?.dedupeKey ?? event.diagnostic?.fingerprint,
  );
}

function warningKey(event: SessionStreamEvent): string {
  return event.diagnostic?.dedupeKey ?? event.diagnostic?.fingerprint ?? `${event.type}:${event.summary}`;
}

export function groupRepeatedWarnings(
  events: SessionStreamEvent[],
  options: WarningGroupingOptions = {},
): SessionStreamEvent[] {
  const withinMs = options.withinMs ?? Number.POSITIVE_INFINITY;
  const grouped: SessionStreamEvent[] = [];

  for (const event of events) {
    const parsed = SessionStreamEventSchema.parse(event);
    const previous = grouped[grouped.length - 1];

    if (
      previous &&
      isRepeatableWarning(previous) &&
      isRepeatableWarning(parsed) &&
      previous.sessionId === parsed.sessionId &&
      warningKey(previous) === warningKey(parsed) &&
      parsed.timestamp - (previous.grouping?.lastTimestamp ?? previous.timestamp) <= withinMs
    ) {
      const nextCount = (previous.grouping?.count ?? previous.diagnostic?.repeatCount ?? 1) + 1;
      grouped[grouped.length - 1] = parseStreamEvent({
        ...previous,
        grouping: {
          key: warningKey(previous),
          kind: "repeat",
          count: nextCount,
          firstEventId: previous.grouping?.firstEventId ?? previous.id,
          lastEventId: parsed.id,
          firstTimestamp: previous.grouping?.firstTimestamp ?? previous.timestamp,
          lastTimestamp: parsed.timestamp,
        },
        diagnostic: previous.diagnostic
          ? {
              ...previous.diagnostic,
              repeatCount: nextCount,
            }
          : undefined,
      });
      continue;
    }

    grouped.push(
      parseStreamEvent({
        ...parsed,
        grouping: parsed.grouping ?? (isRepeatableWarning(parsed)
          ? {
              key: warningKey(parsed),
              kind: "single",
              count: 1,
              firstEventId: parsed.id,
              lastEventId: parsed.id,
              firstTimestamp: parsed.timestamp,
              lastTimestamp: parsed.timestamp,
            }
          : undefined),
      }),
    );
  }

  return grouped;
}

export function createSessionStreamEvent(event: SessionStreamEvent): SessionStreamEvent {
  return parseStreamEvent(event);
}
