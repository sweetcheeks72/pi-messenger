/**
 * FIX 1: task.escalate inbox push to Helios
 *
 * Tests:
 *   - severity=block → inbox file written at .pi/messenger/inbox/helios/
 *   - severity=critical → inbox file written at .pi/messenger/inbox/helios/
 *   - severity=warn → no inbox file written
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../crew/handlers/task.js";
import * as store from "../../crew/store.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function makeState(agentName = "TestWorker") {
  return { agentName, config: {} } as any;
}

function makeCtx(cwd: string) {
  return { cwd, ui: { notify: () => {} } } as any;
}

function heliosInboxDir(cwd: string) {
  return path.join(cwd, ".pi", "messenger", "inbox", "helios");
}

describe("task.escalate inbox push to Helios", () => {
  it("writes inbox file when severity=block", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Risky Task");
    store.startTask(cwd, task.id, "TestWorker");

    await execute(
      "escalate",
      { id: task.id, reason: "DB is down", severity: "block" },
      makeState(),
      makeCtx(cwd),
    );

    const inboxDir = heliosInboxDir(cwd);
    expect(fs.existsSync(inboxDir)).toBe(true);

    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, files[0]!), "utf-8"));
    expect(msg.type).toBe("task.escalate");
    expect(msg.taskId).toBe(task.id);
    expect(msg.severity).toBe("block");
    expect(msg.reason).toBe("DB is down");
    expect(msg.timestamp).toBeDefined();
  });

  it("writes inbox file when severity=critical", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Critical Task");
    store.startTask(cwd, task.id, "TestWorker");

    await execute(
      "escalate",
      { id: task.id, reason: "Data corruption", severity: "critical", suggestion: "rollback" },
      makeState(),
      makeCtx(cwd),
    );

    const inboxDir = heliosInboxDir(cwd);
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, files[0]!), "utf-8"));
    expect(msg.type).toBe("task.escalate");
    expect(msg.severity).toBe("critical");
    expect(msg.suggestion).toBe("rollback");
  });

  it("does NOT write inbox file when severity=warn", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Warn Task");
    store.startTask(cwd, task.id, "TestWorker");

    await execute(
      "escalate",
      { id: task.id, reason: "Minor issue", severity: "warn" },
      makeState(),
      makeCtx(cwd),
    );

    const inboxDir = heliosInboxDir(cwd);
    // Either the directory doesn't exist, or it exists but has no files
    if (fs.existsSync(inboxDir)) {
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBe(0);
    } else {
      expect(fs.existsSync(inboxDir)).toBe(false);
    }
  });
});
