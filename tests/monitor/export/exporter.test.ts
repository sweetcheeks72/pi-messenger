import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { SessionExporter, createSessionExporter } from "../../../src/monitor/export/exporter.js";
import type { SessionState } from "../../../src/monitor/types/session.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const NOW = 1700000000000;

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "active",
    metadata: {
      id,
      name: `session-${id}`,
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date(NOW).toISOString(),
      agent: "test-agent",
    },
    metrics: {
      duration: 5000,
      eventCount: 3,
      errorCount: 1,
      toolCalls: 1,
      tokensUsed: 100,
    },
    events: [],
    ...overrides,
  };
}

function makeEvent(
  type: SessionEvent["type"],
  sessionId: string,
  seq: number,
  payload: Record<string, unknown> = {}
): SessionEvent {
  return {
    id: `evt-${seq}`,
    type,
    sessionId,
    timestamp: NOW + seq * 1000,
    sequence: seq,
    payload: { type, ...payload } as any,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionExporter", () => {
  let sessions: Map<string, SessionState>;
  let events: Map<string, SessionEvent[]>;
  let exporter: SessionExporter;

  beforeEach(() => {
    sessions = new Map();
    events = new Map();
    exporter = createSessionExporter(
      (id) => sessions.get(id),
      (id) => events.get(id) ?? []
    );
  });

  // ── toJSON ──────────────────────────────────────────────────────────────────

  describe("toJSON", () => {
    it("returns valid JSON parseable back", () => {
      const session = makeSession("s1");
      sessions.set("s1", session);
      const json = exporter.toJSON("s1");
      const parsed = JSON.parse(json);
      expect(parsed).toBeDefined();
      expect(parsed.session.metadata.id).toBe("s1");
    });

    it("includes events in JSON output", () => {
      const session = makeSession("s2");
      sessions.set("s2", session);
      const evts = [makeEvent("session.start", "s2", 0, { agentName: "bot" })];
      events.set("s2", evts);
      const parsed = JSON.parse(exporter.toJSON("s2"));
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].type).toBe("session.start");
    });

    it("throws for unknown sessionId", () => {
      expect(() => exporter.toJSON("does-not-exist")).toThrow("Session not found");
    });
  });

  // ── toCSV ───────────────────────────────────────────────────────────────────

  describe("toCSV", () => {
    it("returns CSV with correct headers", () => {
      const session = makeSession("s3");
      sessions.set("s3", session);
      const csv = exporter.toCSV("s3");
      const firstLine = csv.split("\n")[0];
      expect(firstLine).toBe("id,type,sessionId,timestamp,sequence,payload");
    });

    it("returns only header row for session with no events", () => {
      const session = makeSession("s4");
      sessions.set("s4", session);
      const csv = exporter.toCSV("s4");
      const lines = csv.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });

    it("returns parseable rows for session with events", () => {
      const session = makeSession("s5");
      sessions.set("s5", session);
      const evts = [
        makeEvent("tool.call", "s5", 1, { toolName: "bash", args: {} }),
        makeEvent("session.error", "s5", 2, { message: "oh no", fatal: true }),
      ];
      events.set("s5", evts);
      const csv = exporter.toCSV("s5");
      const lines = csv.split("\n").filter(Boolean);
      // header + 2 events
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("tool.call");
      expect(lines[2]).toContain("session.error");
    });

    it("throws for unknown sessionId", () => {
      expect(() => exporter.toCSV("no-such-session")).toThrow("Session not found");
    });
  });

  // ── generateReport ──────────────────────────────────────────────────────────

  describe("generateReport", () => {
    it("report stats match manual calculation", () => {
      const session = makeSession("s6", { metrics: { duration: 9000, eventCount: 5, errorCount: 2, toolCalls: 2, tokensUsed: 200 } });
      sessions.set("s6", session);
      const evts = [
        makeEvent("session.start", "s6", 0, { agentName: "bot" }),
        makeEvent("tool.call", "s6", 1, { toolName: "bash" }),
        makeEvent("session.error", "s6", 2, { message: "err1", fatal: false }),
        makeEvent("session.error", "s6", 3, { message: "err2", fatal: true }),
        makeEvent("operator.action", "s6", 4, { action: "pause", target: "s6" }),
      ];
      events.set("s6", evts);

      const report = exporter.generateReport("s6");
      expect(report.sessionId).toBe("s6");
      expect(report.totalDuration).toBe(9000);
      expect(report.eventBreakdown["session.start"]).toBe(1);
      expect(report.eventBreakdown["tool.call"]).toBe(1);
      expect(report.eventBreakdown["session.error"]).toBe(2);
      expect(report.eventBreakdown["operator.action"]).toBe(1);
      // Error summary
      expect(report.errorSummary.total).toBe(2);
      expect(report.errorSummary.rate).toBeCloseTo(2 / 5);
      expect(report.errorSummary.fatalCount).toBe(1);
      expect(report.errorSummary.messages).toEqual(["err1", "err2"]);
      // Operator actions
      expect(report.operatorActions).toHaveLength(1);
      expect(report.operatorActions[0].action).toBe("pause");
      // generatedAt is a valid ISO string
      expect(() => new Date(report.generatedAt).toISOString()).not.toThrow();
    });

    it("empty session edge case — no events produces zero counts", () => {
      const session = makeSession("s7", { metrics: { duration: 0, eventCount: 0, errorCount: 0, toolCalls: 0, tokensUsed: 0 } });
      sessions.set("s7", session);

      const report = exporter.generateReport("s7");
      expect(report.totalDuration).toBe(0);
      expect(Object.keys(report.eventBreakdown)).toHaveLength(0);
      expect(report.errorSummary.total).toBe(0);
      expect(report.errorSummary.rate).toBe(0);
      expect(report.operatorActions).toHaveLength(0);
      expect(report.healthAlerts).toHaveLength(0);
    });

    it("health alerts are captured in report", () => {
      const session = makeSession("s8");
      sessions.set("s8", session);
      const evts = [
        makeEvent("health.alert", "s8", 0, { severity: "critical", message: "stuck", component: "executor" }),
        makeEvent("health.alert", "s8", 1, { severity: "warning", message: "slow" }),
      ];
      events.set("s8", evts);

      const report = exporter.generateReport("s8");
      expect(report.healthAlerts).toHaveLength(2);
      expect(report.healthAlerts[0].severity).toBe("critical");
      expect(report.healthAlerts[0].component).toBe("executor");
      expect(report.healthAlerts[1].severity).toBe("warning");
    });
  });

  // ── exportAll ───────────────────────────────────────────────────────────────

  describe("exportAll", () => {
    it("writes JSON files to directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"));
      try {
        sessions.set("a1", makeSession("a1"));
        sessions.set("a2", makeSession("a2"));
        exporter.exportAll(tmpDir, "json", ["a1", "a2"]);
        expect(fs.existsSync(path.join(tmpDir, "a1.json"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "a2.json"))).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, "a1.json"), "utf-8"));
        expect(parsed.session.metadata.id).toBe("a1");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("writes CSV files to directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"));
      try {
        sessions.set("b1", makeSession("b1"));
        events.set("b1", [makeEvent("tool.call", "b1", 1, { toolName: "read" })]);
        exporter.exportAll(tmpDir, "csv", ["b1"]);
        expect(fs.existsSync(path.join(tmpDir, "b1.csv"))).toBe(true);
        const content = fs.readFileSync(path.join(tmpDir, "b1.csv"), "utf-8");
        expect(content.split("\n")[0]).toBe("id,type,sessionId,timestamp,sequence,payload");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("creates directory if it does not exist", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"));
      const newDir = path.join(tmpDir, "nested", "output");
      try {
        sessions.set("c1", makeSession("c1"));
        exporter.exportAll(newDir, "json", ["c1"]);
        expect(fs.existsSync(path.join(newDir, "c1.json"))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });
});
