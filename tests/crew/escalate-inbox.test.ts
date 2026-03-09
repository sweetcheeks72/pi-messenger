/**
 * FIX 1: task.escalate inbox push to Helios
 *
 * Tests:
 *   - severity=block → inbox file written at .pi/messenger/inbox/<orchestrator>/
 *   - severity=critical → inbox file written at .pi/messenger/inbox/<orchestrator>/
 *   - severity=warn → no inbox file written
 *   - config.orchestrator overrides hardcoded 'helios'
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

function orchestratorInboxDir(cwd: string, orchestrator = "helios") {
  return path.join(cwd, ".pi", "messenger", "inbox", orchestrator);
}

/** Write a minimal crew config.json that sets orchestrator to the given name */
function setOrchestratorConfig(cwd: string, orchestratorName: string): void {
  const crewDir = path.join(cwd, ".pi", "messenger", "crew");
  fs.mkdirSync(crewDir, { recursive: true });
  fs.writeFileSync(
    path.join(crewDir, "config.json"),
    JSON.stringify({ orchestrator: orchestratorName }),
  );
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

    const inboxDir = orchestratorInboxDir(cwd, "helios");
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

    const inboxDir = orchestratorInboxDir(cwd, "helios");
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

    const inboxDir = orchestratorInboxDir(cwd, "helios");
    // Either the directory doesn't exist, or it exists but has no files
    if (fs.existsSync(inboxDir)) {
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBe(0);
    } else {
      expect(fs.existsSync(inboxDir)).toBe(false);
    }
  });

  it("routes escalation to config.orchestrator inbox (not hardcoded helios)", async () => {
    const { cwd } = createTempCrewDirs();
    setOrchestratorConfig(cwd, "test-orchestrator");
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Config Test Task");
    store.startTask(cwd, task.id, "TestWorker");

    await execute(
      "escalate",
      { id: task.id, reason: "Custom orchestrator test", severity: "block" },
      makeState(),
      makeCtx(cwd),
    );

    // Should land in test-orchestrator inbox, NOT helios inbox
    const customInboxDir = orchestratorInboxDir(cwd, "test-orchestrator");
    expect(fs.existsSync(customInboxDir)).toBe(true);

    const files = fs.readdirSync(customInboxDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(customInboxDir, files[0]!), "utf-8"));
    expect(msg.type).toBe("task.escalate");
    expect(msg.taskId).toBe(task.id);

    // Confirm the helios inbox was NOT written
    const heliosDir = orchestratorInboxDir(cwd, "helios");
    if (fs.existsSync(heliosDir)) {
      const heliosFiles = fs.readdirSync(heliosDir).filter(f => f.endsWith(".json"));
      expect(heliosFiles.length).toBe(0);
    } else {
      expect(fs.existsSync(heliosDir)).toBe(false);
    }
  });

  it("FIX 4: inbox write failure is best-effort — escalate succeeds and task is blocked", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Risky Task");
    store.startTask(cwd, task.id, "TestWorker");

    // Cause the inbox write to fail by placing a regular FILE at the
    // directory path the code tries to mkdirSync. On all POSIX systems,
    // mkdirSync({ recursive: true }) on a path that exists as a file
    // throws ENOTDIR, which is exactly the disk-I/O failure we want to simulate.
    const inboxParent = path.join(cwd, ".pi", "messenger", "inbox");
    fs.mkdirSync(inboxParent, { recursive: true });
    // "helios" is the default orchestrator — put a file here so mkdir fails
    fs.writeFileSync(path.join(inboxParent, "helios"), "blocker-not-a-dir");

    let thrownError: unknown = null;
    try {
      await execute(
        "escalate",
        { id: task.id, reason: "Simulated disk failure", severity: "block" },
        makeState(),
        makeCtx(cwd),
      );
    } catch (e) {
      thrownError = e;
    }

    // The function must NOT throw — inbox failure is best-effort
    expect(thrownError).toBeNull();

    // The task MUST still be blocked — store.blockTask was called before the inbox write
    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blocked_reason).toBe("Simulated disk failure");
  });
});
