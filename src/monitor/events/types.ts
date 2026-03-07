import { z } from "zod";

// ─── Event Type Enum ────────────────────────────────────────────────────────

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

// ─── Discriminated Union Payload ─────────────────────────────────────────────

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
]);

export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

// ─── Session Event Schema ─────────────────────────────────────────────────────

export const SessionEventSchema = z.object({
  id: z.string(),
  type: EventTypeSchema,
  sessionId: z.string(),
  timestamp: z.number(),
  payload: SessionEventPayloadSchema,
  sequence: z.number().int().nonnegative(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ─── Stream Config Schema ─────────────────────────────────────────────────────

export const StreamConfigSchema = z.object({
  bufferSize: z.number().int().positive().default(100),
  replayFromOffset: z.number().int().nonnegative().default(0),
  filterTypes: z.array(EventTypeSchema).default([]),
  maxAge: z.number().int().positive().optional(),
});

export type StreamConfig = z.infer<typeof StreamConfigSchema>;
