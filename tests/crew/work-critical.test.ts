import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

vi.mock("../../crew/agents.js", () => ({
  resolveModel: vi.fn((taskModel?: string, paramModel?: string, configModel?: string, agentModel?: string) => (
    taskModel ?? paramModel ?? configModel ?? agentModel
  )),
  resolveModelForTaskRole: vi.fn((_: string, taskModel?: string, paramModel?: string, models?: any, agentModel?: string) => (
    taskModel ?? paramModel ?? models?.worker ?? agentModel
  )),
  selectCrewAgentForRole: vi.fn((agents: Array<{ name: string; crewRole?: string }>, role: string) => (
    agents.find(a => a.crewRole === role) ?? agents.find(a => a.name === "crew-worker")
  )),
  spawnAgents: vi.fn(),
}));

vi.mock("../../crew/specialization.js", () => ({
  classifyTask: vi.fn(() => "implementation"),
  recordTaskOutcome: vi.fn(),
}));

vi.mock("../../crew/conflict-detector.js", () => ({
  checkWaveConflicts: vi.fn(() => []),
}));

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`);
}

function writeConfig(cwd: string): void {
  const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    review: {
      autoAdversarial: false,
      autoIntegrationTest: false,
    },
  }, null, 2));
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function makeResult(taskId: string, output = "", exitCode = 0) {
  return {
    agent: "crew-worker",
    exitCode,
    output,
    truncated: false,
    progress: {
      agent: "crew-worker",
      status: "completed" as const,
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
    },
    taskId,
    wasGracefullyShutdown: false,
  };
}

describe("crew/work critical dual-worker accounting", () => {
  let workHandler: typeof import("../../crew/handlers/work.js");
  let store: typeof import("../../crew/store.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let recordTaskOutcome: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    writeWorkerAgent(cwd);
    writeConfig(cwd);

    store = await import("../../crew/store.js");
    store.createPlan(cwd, "docs/PRD.md");

    workHandler = await import("../../crew/handlers/work.js");
    const agents = await import("../../crew/agents.js");
    const specialization = await import("../../crew/specialization.js");

    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;
    recordTaskOutcome = specialization.recordTaskOutcome as ReturnType<typeof vi.fn>;
  });

  it("counts convergent critical tasks as succeeded and records specialization", async () => {
    const task = store.createTask(cwd, "Critical wave accounting", "Fix result accounting", undefined, "shared", { critical: true });

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      const firstTaskId = tasks[0]?.taskId ?? "";
      if (firstTaskId.endsWith("-A")) {
        store.updateTask(cwd, task.id, { status: "done", assigned_to: "critical-worker" });
        return [
          makeResult(`${task.id}-A`, "Updated crew/handlers/work.ts and tests/crew/work-critical.test.ts ✅ DONE"),
          makeResult(`${task.id}-B`, "Updated crew/handlers/work.ts and tests/crew/work-critical.test.ts ✅ DONE"),
        ] as any;
      }
      return [] as any;
    });

    const response = await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toEqual([task.id]);
    expect(response.details.failed).toEqual([]);
    expect(response.details.blocked).toEqual([]);
    expect(recordTaskOutcome).toHaveBeenCalledWith("critical-worker", "implementation", true, expect.any(Number));
  });

  it("counts judge-rejected divergent critical tasks as failed and resets task state", async () => {
    const task = store.createTask(cwd, "Critical divergent path", "Dual worker verification", undefined, "shared", { critical: true });

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      const firstTaskId = tasks[0]?.taskId ?? "";

      if (firstTaskId.endsWith("-A")) {
        store.updateTask(cwd, task.id, { status: "done", assigned_to: "critical-worker" });
        return [
          makeResult(`${task.id}-A`, "Changed crew/handlers/task.ts and tests/a.ts ✅ DONE"),
          makeResult(`${task.id}-B`, "Changed crew/utils/config.ts and tests/b.ts ✅ DONE"),
        ] as any;
      }

      if (firstTaskId.startsWith("judge-")) {
        return [makeResult(firstTaskId, "## Verdict: REJECT_BOTH\nBoth approaches miss acceptance criteria")] as any;
      }

      return [] as any;
    });

    const response = await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    const updatedTask = store.getTask(cwd, task.id);
    expect(updatedTask?.status).toBe("todo");
    expect(response.details.succeeded).toEqual([]);
    expect(response.details.failed).toEqual([task.id]);
  });
});
