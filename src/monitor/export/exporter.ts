/**
 * SessionExporter
 *
 * Export session data to JSON/CSV formats and generate summary reports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionState } from "../types/session.js";
import type { SessionEvent } from "../events/types.js";
import type { SessionReport, ExportFormat, ErrorSummary, OperatorActionRecord, HealthAlertRecord } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function csvEscape(value: string): string {
  // Wrap in quotes if contains comma, newline, or quote
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCSV(values: (string | number | boolean | undefined | null)[]): string {
  return values.map((v) => csvEscape(String(v ?? ""))).join(",");
}

// ─── SessionExporter ──────────────────────────────────────────────────────────

/**
 * Exports session data to JSON or CSV and generates summary reports.
 *
 * Uses a store callback to retrieve session state by ID, allowing the
 * exporter to work with any session store implementation.
 */
export class SessionExporter {
  private getSession: (sessionId: string) => SessionState | undefined;
  private getEvents: (sessionId: string) => SessionEvent[];

  constructor(
    getSession: (sessionId: string) => SessionState | undefined,
    getEvents?: (sessionId: string) => SessionEvent[]
  ) {
    this.getSession = getSession;
    this.getEvents = getEvents ?? (() => []);
  }

  /**
   * Export a session as a JSON string.
   * Throws if the session is not found.
   */
  toJSON(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const events = this.getEvents(sessionId);
    return JSON.stringify({ session, events }, null, 2);
  }

  /**
   * Export session events as CSV.
   * Returns a CSV string with headers: id,type,sessionId,timestamp,sequence,payload
   * If the session has no events, returns only the header row.
   */
  toCSV(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const events = this.getEvents(sessionId);

    const headers = ["id", "type", "sessionId", "timestamp", "sequence", "payload"];
    const rows = [headers.join(",")];

    for (const evt of events) {
      rows.push(
        rowToCSV([
          (evt as any).id ?? "",
          evt.type,
          evt.sessionId,
          evt.timestamp,
          (evt as any).sequence ?? "",
          JSON.stringify((evt as any).payload ?? {}),
        ])
      );
    }

    return rows.join("\n");
  }

  /**
   * Generate a summary report for a session.
   * Throws if the session is not found.
   */
  generateReport(sessionId: string): SessionReport {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const events = this.getEvents(sessionId);

    // Event breakdown
    const eventBreakdown: Record<string, number> = {};
    for (const evt of events) {
      eventBreakdown[evt.type] = (eventBreakdown[evt.type] ?? 0) + 1;
    }

    // Error summary
    const errorEvents = events.filter((e) => e.type === "session.error");
    const errorMessages: string[] = [];
    let fatalCount = 0;
    for (const e of errorEvents) {
      const payload = (e as any).payload;
      if (payload?.message) {
        errorMessages.push(payload.message);
      }
      if (payload?.fatal === true) {
        fatalCount += 1;
      }
    }
    const totalEvents = events.length;
    const errorSummary: ErrorSummary = {
      total: errorEvents.length,
      rate: totalEvents > 0 ? errorEvents.length / totalEvents : 0,
      fatalCount,
      messages: errorMessages,
    };

    // Operator actions
    const operatorActionEvents = events.filter((e) => e.type === "operator.action");
    const operatorActions: OperatorActionRecord[] = operatorActionEvents.map((e) => {
      const payload = (e as any).payload ?? {};
      return {
        action: payload.action ?? "",
        target: payload.target,
        timestamp: e.timestamp,
      };
    });

    // Health alerts
    const healthAlertEvents = events.filter((e) => e.type === "health.alert");
    const healthAlerts: HealthAlertRecord[] = healthAlertEvents.map((e) => {
      const payload = (e as any).payload ?? {};
      return {
        severity: payload.severity ?? "warning",
        message: payload.message ?? "",
        component: payload.component,
        timestamp: e.timestamp,
      };
    });

    // Total duration from session metrics
    const totalDuration = session.metrics?.duration ?? 0;

    return {
      sessionId,
      totalDuration,
      eventBreakdown,
      errorSummary,
      operatorActions,
      healthAlerts,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Export all sessions to a directory.
   * Each session is written as <sessionId>.json or <sessionId>.csv.
   * @param dir Directory to write exports to
   * @param format "json" (default) or "csv"
   * @param sessionIds Optional list of session IDs; if omitted, exports nothing (caller must provide IDs)
   */
  exportAll(dir: string, format: ExportFormat = "json", sessionIds: string[]): void {
    ensureDir(dir);
    for (const sessionId of sessionIds) {
      const filename = `${sessionId}.${format}`;
      const filePath = path.join(dir, filename);
      const content = format === "csv" ? this.toCSV(sessionId) : this.toJSON(sessionId);
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a SessionExporter with the provided session and event lookup functions.
 */
export function createSessionExporter(
  getSession: (sessionId: string) => SessionState | undefined,
  getEvents?: (sessionId: string) => SessionEvent[]
): SessionExporter {
  return new SessionExporter(getSession, getEvents);
}
