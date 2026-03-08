import { z } from "zod";

// ─── Event Type Enum ────────────────────────────────────────────────────────

export const EventCategorySchema = z.enum([
  "thinking",
  "execution",
  "tool",
  "progress",
  "waiting",
  "lifecycle",
]);

export type EventCategory = z.infer<typeof EventCategorySchema>;

export const EventTypeSchema = z.enum([
  "session.start",
  "session.pause",
  "session.resume",
  "session.end",
  "session.error",
  "tool.call",
  "tool.result",
  "operator.action",
  "health.check",
  "health.alert",
  "metrics.snapshot",
  "agent.thinking",
  "agent.waiting",
  "agent.progress",
  "execution.start",
  "execution.output",
  "execution.end",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// ─── Per-Type Payload Schemas ────────────────────────────────────────────────

export const SessionStartPayloadSchema = z.object({
  type: z.literal("session.start"),
  agentName: z.string(),
  model: z.string().optional(),
  workingDir: z.string().optional(),
});

export const SessionPausePayloadSchema = z.object({
  type: z.literal("session.pause"),
  reason: z.string().optional(),
});

export const SessionResumePayloadSchema = z.object({
  type: z.literal("session.resume"),
  resumedBy: z.string().optional(),
});

export const SessionEndPayloadSchema = z.object({
  type: z.literal("session.end"),
  exitCode: z.number().optional(),
  summary: z.string().optional(),
});

export const SessionErrorPayloadSchema = z.object({
  type: z.literal("session.error"),
  message: z.string(),
  stack: z.string().optional(),
  fatal: z.boolean().optional(),
});

export const ToolCallPayloadSchema = z.object({
  type: z.literal("tool.call"),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const ToolResultPayloadSchema = z.object({
  type: z.literal("tool.result"),
  toolName: z.string(),
  success: z.boolean(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

export const OperatorActionPayloadSchema = z.object({
  type: z.literal("operator.action"),
  action: z.string(),
  target: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const HealthCheckPayloadSchema = z.object({
  type: z.literal("health.check"),
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  checks: z.record(z.string(), z.boolean()).optional(),
});

export const HealthAlertPayloadSchema = z.object({
  type: z.literal("health.alert"),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  component: z.string().optional(),
});

export const MetricsSnapshotPayloadSchema = z.object({
  type: z.literal("metrics.snapshot"),
  toolCallCount: z.number(),
  errorCount: z.number(),
  uptimeMs: z.number(),
  memoryMb: z.number().optional(),
});

export const AgentThinkingPayloadSchema = z.object({
  type: z.literal("agent.thinking"),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AgentWaitingPayloadSchema = z.object({
  type: z.literal("agent.waiting"),
  reason: z.string().optional(),
  etaMs: z.number().int().nonnegative().optional(),
});

export const AgentProgressPayloadSchema = z.object({
  type: z.literal("agent.progress"),
  message: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  step: z.string().optional(),
});

export const ExecutionStartPayloadSchema = z.object({
  type: z.literal("execution.start"),
  command: z.string(),
  cwd: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionOutputPayloadSchema = z.object({
  type: z.literal("execution.output"),
  text: z.string(),
  stream: z.enum(["stdout", "stderr"]).optional(),
});

export const ExecutionEndPayloadSchema = z.object({
  type: z.literal("execution.end"),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  success: z.boolean().optional(),
});

// ─── Discriminated Union Payload ────────────────────────────────────────────

export const SessionEventPayloadSchema = z.discriminatedUnion("type", [
  SessionStartPayloadSchema,
  SessionPausePayloadSchema,
  SessionResumePayloadSchema,
  SessionEndPayloadSchema,
  SessionErrorPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  OperatorActionPayloadSchema,
  HealthCheckPayloadSchema,
  HealthAlertPayloadSchema,
  MetricsSnapshotPayloadSchema,
  AgentThinkingPayloadSchema,
  AgentWaitingPayloadSchema,
  AgentProgressPayloadSchema,
  ExecutionStartPayloadSchema,
  ExecutionOutputPayloadSchema,
  ExecutionEndPayloadSchema,
]);

export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

const inferEventCategory = (type: EventType): EventCategory => {
  switch (type) {
    case "agent.thinking":
      return "thinking";
    case "agent.waiting":
      return "waiting";
    case "agent.progress":
      return "progress";
    case "execution.start":
    case "execution.output":
    case "execution.end":
      return "execution";
    case "tool.call":
    case "tool.result":
      return "tool";
    default:
      return "lifecycle";
  }
};

// ─── Base Session Event Schema ──────────────────────────────────────────────

export const SessionEventSchema = z
  .object({
    id: z.string(),
    type: EventTypeSchema,
    category: EventCategorySchema.optional(),
    sessionId: z.string(),
    timestamp: z.number(),
    payload: SessionEventPayloadSchema,
    sequence: z.number().int().nonnegative(),
  })
  .transform((event) => ({
    ...event,
    category: event.category ?? inferEventCategory(event.type),
  }));

export type SessionEvent = z.input<typeof SessionEventSchema>;

export const GroupedEventSchema = z
  .object({
    category: EventCategorySchema,
    events: z.array(SessionEventSchema),
    count: z.number().int().nonnegative().optional(),
  })
  .transform((group) => ({
    ...group,
    count: group.count ?? group.events.length,
  }));

export type GroupedEvent = z.infer<typeof GroupedEventSchema>;

// ─── Pi-Native Stream/Event Schemas ─────────────────────────────────────────

export const SessionStreamSourceSchema = z.enum([
  "pi-runtime",
  "messenger-runtime",
  "health-monitor",
  "operator",
  "derived",
]);

export type SessionStreamSource = z.infer<typeof SessionStreamSourceSchema>;

export const SessionStreamLaneSchema = z.enum([
  "thinking",
  "execution",
  "tool",
  "progress",
  "waiting",
  "lifecycle",
  "outcome",
  "diagnostic",
]);

export type SessionStreamLane = z.infer<typeof SessionStreamLaneSchema>;

export const SessionStreamSeveritySchema = z.enum(["info", "warning", "error", "critical"]);
export type SessionStreamSeverity = z.infer<typeof SessionStreamSeveritySchema>;

export const SessionDiagnosticCodeSchema = z.enum([
  "stuck",
  "stale",
  "high_error_rate",
  "tool_error",
  "session_error",
  "waiting_on_human",
  "unknown",
]);

export type SessionDiagnosticCode = z.infer<typeof SessionDiagnosticCodeSchema>;

export const SessionWarningGroupingSchema = z.object({
  key: z.string(),
  kind: z.enum(["single", "repeat"]).default("single"),
  count: z.number().int().positive().default(1),
  firstEventId: z.string().optional(),
  lastEventId: z.string().optional(),
  firstTimestamp: z.number().int().nonnegative().optional(),
  lastTimestamp: z.number().int().nonnegative().optional(),
});

export type SessionWarningGrouping = z.infer<typeof SessionWarningGroupingSchema>;

export const SessionDiagnosticSchema = z.object({
  code: SessionDiagnosticCodeSchema,
  severity: SessionStreamSeveritySchema,
  fingerprint: z.string(),
  dedupeKey: z.string(),
  repeatCount: z.number().int().positive().default(1),
});

export type SessionDiagnostic = z.infer<typeof SessionDiagnosticSchema>;

const inferStreamLane = (type: EventType): SessionStreamLane => {
  switch (type) {
    case "agent.thinking":
      return "thinking";
    case "tool.call":
    case "tool.result":
      return "tool";
    case "agent.progress":
    case "metrics.snapshot":
    case "operator.action":
      return "progress";
    case "agent.waiting":
      return "waiting";
    case "execution.start":
    case "execution.output":
    case "execution.end":
      return "execution";
    case "session.end":
    case "session.error":
      return "outcome";
    case "health.check":
    case "health.alert":
      return "diagnostic";
    default:
      return "lifecycle";
  }
};

const inferStreamSeverity = (
  type: EventType,
  payload: SessionEventPayload,
): SessionStreamSeverity => {
  if (type === "session.error" && payload.type === "session.error") {
    return payload.fatal ? "critical" : "error";
  }
  if (type === "health.alert" && payload.type === "health.alert") {
    return payload.severity === "critical" ? "critical" : "warning";
  }
  if (type === "tool.result" && payload.type === "tool.result" && !payload.success) {
    return "warning";
  }
  if (type === "execution.output" && payload.type === "execution.output" && payload.stream === "stderr") {
    return "warning";
  }
  return "info";
};

export const SessionStreamEventSchema = z
  .object({
    id: z.string(),
    type: EventTypeSchema,
    category: EventCategorySchema.optional(),
    lane: SessionStreamLaneSchema.optional(),
    source: SessionStreamSourceSchema,
    sessionId: z.string(),
    timestamp: z.number(),
    payload: SessionEventPayloadSchema,
    sequence: z.number().int().nonnegative(),
    summary: z.string(),
    severity: SessionStreamSeveritySchema.optional(),
    diagnostic: SessionDiagnosticSchema.optional(),
    grouping: SessionWarningGroupingSchema.optional(),
    rawType: z.string().optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((event) => ({
    ...event,
    category: event.category ?? inferEventCategory(event.type),
    lane: event.lane ?? inferStreamLane(event.type),
    severity: event.severity ?? inferStreamSeverity(event.type, event.payload),
    grouping: event.grouping
      ? {
          ...event.grouping,
          count: event.grouping.count ?? 1,
        }
      : undefined,
    diagnostic: event.diagnostic
      ? {
          ...event.diagnostic,
          repeatCount: event.diagnostic.repeatCount ?? 1,
        }
      : undefined,
  }));

export type SessionStreamEvent = z.input<typeof SessionStreamEventSchema>;

// ─── Stream Config Schema ─────────────────────────────────────────────────────

export const StreamConfigSchema = z.object({
  bufferSize: z.number().int().positive().default(100),
  replayFromOffset: z.number().int().nonnegative().default(0),
  filterTypes: z.array(EventTypeSchema).default([]),
  maxAge: z.number().int().positive().optional(),
  filterCategories: z.array(EventCategorySchema).default([]),
  dedupeWarnings: z.boolean().default(false),
});

export type StreamConfig = z.infer<typeof StreamConfigSchema>;
