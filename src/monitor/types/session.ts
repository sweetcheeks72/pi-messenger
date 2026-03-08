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

export const SessionEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime(),
  data: z.unknown().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionStateSchema = z.object({
  status: SessionStatusSchema,
  metadata: SessionMetadataSchema,
  metrics: SessionMetricsSchema,
  events: z.array(SessionEventSchema),
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
