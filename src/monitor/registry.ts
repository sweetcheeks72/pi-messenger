import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionStore } from "./store/session-store.js";
import { SessionEventEmitter } from "./events/emitter.js";
import type { SessionEvent } from "./events/types.js";
import { SessionLifecycleManager } from "./lifecycle/manager.js";
import { SessionMetricsAggregator } from "./metrics/aggregator.js";
import { OperatorCommandHandler } from "./commands/handler.js";
import { SessionHealthMonitor } from "./health/monitor.js";
import { SessionReplayer } from "./replay/replayer.js";
import { SessionExporter } from "./export/exporter.js";
import { SessionFeedSubscriber } from "./feed/subscriber.js";
import type { HealthThresholds } from "./health/types.js";
import type { SessionHistoryEntry } from "./types/session.js";

// ─── Health config defaults ───────────────────────────────────────────────────

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_STUCK_AFTER_MS = 120_000;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.5;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Shape of the `health` key in `.pi/messenger/crew/config.json`.
 */
export interface CrewHealthConfig {
  staleAfterMs?: number;
  stuckAfterMs?: number;
  errorRateThreshold?: number;
  pollIntervalMs?: number;
}

/**
 * Options for createMonitorRegistry.
 */
export interface MonitorRegistryOptions {
  /**
   * Explicit health config. When provided, the file system is not read.
   * Values that are not positive finite numbers fall back to defaults.
   */
  healthConfig?: CrewHealthConfig;
  /**
   * Path to the crew config JSON file.
   * Defaults to `.pi/messenger/crew/config.json` relative to process.cwd().
   */
  crewConfigPath?: string;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidErrorRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Read and validate health config from a crew config JSON file.
 * Returns validated values; invalid entries fall back to defaults.
 */
function readCrewHealthConfig(configPath: string): CrewHealthConfig {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const health = (parsed as Record<string, unknown>)["health"];
    if (typeof health !== "object" || health === null) {
      return {};
    }
    const h = health as Record<string, unknown>;
    const result: CrewHealthConfig = {};
    if (isPositiveFinite(h["staleAfterMs"])) result.staleAfterMs = h["staleAfterMs"] as number;
    if (isPositiveFinite(h["stuckAfterMs"])) result.stuckAfterMs = h["stuckAfterMs"] as number;
    if (isValidErrorRate(h["errorRateThreshold"])) result.errorRateThreshold = h["errorRateThreshold"] as number;
    if (isPositiveFinite(h["pollIntervalMs"])) result.pollIntervalMs = h["pollIntervalMs"] as number;
    return result;
  } catch {
    return {};
  }
}

/**
 * Merge raw health config with defaults, returning validated HealthThresholds
 * and pollIntervalMs.
 */
function resolveHealthConfig(raw: CrewHealthConfig): {
  thresholds: HealthThresholds;
  pollIntervalMs: number;
} {
  return {
    thresholds: {
      staleAfterMs: isPositiveFinite(raw.staleAfterMs) ? raw.staleAfterMs : DEFAULT_STALE_AFTER_MS,
      stuckAfterMs: isPositiveFinite(raw.stuckAfterMs) ? raw.stuckAfterMs : DEFAULT_STUCK_AFTER_MS,
      errorRateThreshold: isValidErrorRate(raw.errorRateThreshold)
        ? raw.errorRateThreshold
        : DEFAULT_ERROR_RATE_THRESHOLD,
    },
    pollIntervalMs: isPositiveFinite(raw.pollIntervalMs) ? raw.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
  };
}

function projectHistoryEntry(event: SessionEvent): SessionHistoryEntry {
  return {
    type: event.type,
    timestamp: new Date(event.timestamp).toISOString(),
    data: event.payload,
  };
}

function projectStoreMetrics(event: SessionEvent, aggregator: SessionMetricsAggregator) {
  const metrics = aggregator.computeMetrics(event.sessionId);
  return {
    duration: metrics.activeDurationMs,
    eventCount: metrics.totalEvents,
    errorCount: metrics.errorCount,
    toolCalls: metrics.toolCalls,
  };
}

function exportPayload(entry: SessionHistoryEntry): SessionEvent["payload"] {
  const data = entry.data;
  if (data && typeof data === "object" && (data as { type?: unknown }).type === entry.type) {
    return data as SessionEvent["payload"];
  }
  return { type: entry.type } as SessionEvent["payload"];
}

function toStoreBackedSessionEvents(sessionId: string, history: SessionHistoryEntry[]): SessionEvent[] {
  return history.map((entry, index) => ({
    id: `${sessionId}:${index}`,
    type: entry.type as SessionEvent["type"],
    sessionId,
    timestamp: Date.parse(entry.timestamp),
    sequence: index,
    payload: exportPayload(entry),
  }));
}

// ─── MonitorRegistry ─────────────────────────────────────────────────────────

export class MonitorRegistry {
  readonly store: SessionStore;
  readonly emitter: SessionEventEmitter;
  readonly lifecycle: SessionLifecycleManager;
  readonly aggregator: SessionMetricsAggregator;
  readonly commandHandler: OperatorCommandHandler;
  readonly healthMonitor: SessionHealthMonitor;
  readonly replayer: SessionReplayer;
  readonly exporter: SessionExporter;
  readonly feedSubscriber: SessionFeedSubscriber;

  /** Configured poll interval for the health monitor (milliseconds). */
  readonly pollIntervalMs: number;

  private disposed = false;
  private emitterProjectionUnsubscribe: (() => void) | null = null;

  constructor(options?: MonitorRegistryOptions) {
    this.store = new SessionStore();
    this.emitter = new SessionEventEmitter();
    this.lifecycle = new SessionLifecycleManager(this.store, this.emitter);
    this.aggregator = new SessionMetricsAggregator(this.emitter, this.store);
    this.commandHandler = new OperatorCommandHandler(this.lifecycle);
    this.healthMonitor = new SessionHealthMonitor(this.store, this.emitter, this.aggregator);
    this.replayer = new SessionReplayer(this.emitter, this.aggregator);
    this.exporter = new SessionExporter(
      (id) => this.store.get(id),
      (id) => toStoreBackedSessionEvents(id, this.store.get(id)?.events ?? []),
    );
    this.feedSubscriber = new SessionFeedSubscriber(this.emitter);
    this.feedSubscriber.subscribe();
    this.emitterProjectionUnsubscribe = this.emitter.subscribe((event) => {
      if (!this.store.get(event.sessionId)) {
        return;
      }

      this.store.appendHistoryEvent(event.sessionId, projectHistoryEntry(event));
      this.store.refreshMetrics(event.sessionId, projectStoreMetrics(event, this.aggregator));
    });

    // Apply health thresholds from config
    const rawHealthConfig =
      options?.healthConfig !== undefined
        ? options.healthConfig
        : readCrewHealthConfig(
            options?.crewConfigPath ??
              resolve(process.cwd(), ".pi/messenger/crew/config.json"),
          );

    const { thresholds, pollIntervalMs } = resolveHealthConfig(rawHealthConfig);
    this.healthMonitor.setThresholds(thresholds);
    this.pollIntervalMs = pollIntervalMs;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.healthMonitor.stop();
    this.feedSubscriber.unsubscribe();
    this.emitterProjectionUnsubscribe?.();
    this.emitterProjectionUnsubscribe = null;
    this.aggregator.destroy();
  }
}

export function createMonitorRegistry(options?: MonitorRegistryOptions): MonitorRegistry {
  return new MonitorRegistry(options);
}
