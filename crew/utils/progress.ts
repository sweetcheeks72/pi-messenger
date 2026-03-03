/**
 * Crew - Progress Tracking
 * 
 * Real-time visibility into agent execution via --mode json event parsing.
 */

export interface ToolEntry {
  tool: string;
  args: string;
  startMs: number;
  endMs: number;
  /** For edit/write tools: captured diff or content preview */
  diffPreview?: string;
  /** Whether the tool succeeded */
  success?: boolean;
}

export interface AgentProgress {
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  recentTools: ToolEntry[];
  toolCallCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
  /** Files modified by this agent (paths from edit/write tool calls) */
  filesModified: string[];
  /** Model used by this agent */
  model?: string;
  /** Tool call timestamps for sparkline (calls per 10s bucket) */
  toolCallBuckets: number[];
  /** Start time for bucket calculation */
  bucketStartMs?: number;
  /** Timestamp when thinking started (no active tool) */
  thinkingStartMs?: number;
}

// Event types from pi's --mode json output
export interface PiEvent {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    details?: { diff?: string; firstChangedLine?: number };
  };
  isError?: boolean;
  message?: {
    role: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    errorMessage?: string;
  };
}

export function createProgress(agent: string): AgentProgress {
  return {
    agent,
    status: "pending",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
    filesModified: [],
    toolCallBuckets: [],
  };
}

export function parseJsonlLine(line: string): PiEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const BUCKET_INTERVAL_MS = 10_000; // 10s per sparkline bucket

function updateToolBucket(progress: AgentProgress): void {
  const now = Date.now();
  if (!progress.bucketStartMs) {
    progress.bucketStartMs = now;
    progress.toolCallBuckets = [1];
    return;
  }
  const elapsed = now - progress.bucketStartMs;
  const bucketIdx = Math.floor(elapsed / BUCKET_INTERVAL_MS);
  // Pad with zeros for empty buckets
  while (progress.toolCallBuckets.length <= bucketIdx) {
    progress.toolCallBuckets.push(0);
  }
  progress.toolCallBuckets[bucketIdx]++;
  // Keep max 30 buckets (5 min)
  if (progress.toolCallBuckets.length > 30) {
    progress.toolCallBuckets = progress.toolCallBuckets.slice(-30);
    progress.bucketStartMs = now - (30 * BUCKET_INTERVAL_MS);
  }
}

function trackFileModified(progress: AgentProgress, toolName: string, args?: Record<string, unknown>): void {
  if (toolName !== "edit" && toolName !== "write") return;
  const filePath = args?.path ?? args?.file_path;
  if (typeof filePath !== "string") return;
  if (!progress.filesModified.includes(filePath)) {
    progress.filesModified.push(filePath);
  }
}

export function updateProgress(progress: AgentProgress, event: PiEvent, startTime: number): void {
  progress.durationMs = Date.now() - startTime;

  switch (event.type) {
    case "tool_execution_start":
      progress.status = "running";
      progress.currentTool = event.toolName;
      progress.currentToolArgs = extractArgsPreview(event.args);
      progress.currentToolStartMs = Date.now();
      progress.thinkingStartMs = undefined;
      // Track file modifications
      if (event.toolName) {
        trackFileModified(progress, event.toolName, event.args);
      }
      break;

    case "tool_execution_end":
      progress.toolCallCount++;
      updateToolBucket(progress);
      if (progress.currentTool) {
        const entry: ToolEntry = {
          tool: progress.currentTool,
          args: progress.currentToolArgs ?? "",
          startMs: progress.currentToolStartMs ?? Date.now(),
          endMs: Date.now(),
          success: !event.isError,
        };
        // Capture diff preview for edit tools
        if (progress.currentTool === "edit" && event.result?.details?.diff) {
          entry.diffPreview = event.result.details.diff;
        }
        progress.recentTools.push(entry);
      }
      progress.currentTool = undefined;
      progress.currentToolArgs = undefined;
      progress.currentToolStartMs = undefined;
      // Start thinking timer when no tool is active
      progress.thinkingStartMs = Date.now();
      break;

    case "message_end":
      if (event.message?.usage) {
        progress.tokens += (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0);
      }
      if (event.message?.model) {
        progress.model = event.message.model;
      }
      if (event.message?.errorMessage) {
        progress.error = event.message.errorMessage;
      }
      // Thinking starts after message processing
      progress.thinkingStartMs = Date.now();
      break;
  }
}

function extractArgsPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const previewKeys = ["command", "path", "file_path", "pattern", "query"];
  for (const key of previewKeys) {
    if (args[key] && typeof args[key] === "string") {
      const value = (args[key] as string).replaceAll("\n", " ").replaceAll("\r", "");
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }
  return "";
}

export function getFinalOutput(messages: PiEvent[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "message_end" && msg.message?.role === "assistant") {
      for (const part of msg.message.content ?? []) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}
