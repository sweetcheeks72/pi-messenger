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

function writeAgent(cwd: string, name: string, crewRole: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: ${name}
description: ${name}
crewRole: ${crewRole}
---
You are ${name}.
`);
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function makeResult(taskId: string, agent = "crew-worker") {
  return {
    agent,
    exitCode: 0,
    output: "",
    truncated: false,
    progress: {
      agent,
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

describe("crew/work role routing", () => {
  let workHandler: typeof import("../../crew/handlers/work.js");
  let store: typeof import("../../crew/store.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store = await import("../../crew/store.js");
    store.createPlan(cwd, "docs/PRD.md");

    workHandler = await import("../../crew/handlers/work.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;
  });

  it("classifies task text into Feynman roles", () => {
    expect(workHandler.classifyTaskToFeynmanRole("Run recon and impact analysis")).toBe("scout");
    expect(workHandler.classifyTaskToFeynmanRole("Plan architecture and decomposition")).toBe("planner");
    expect(workHandler.classifyTaskToFeynmanRole("Implement feature and edit handlers")).toBe("worker");
    expect(workHandler.classifyTaskToFeynmanRole("Adversarial review of task output")).toBe("reviewer");
    expect(workHandler.classifyTaskToFeynmanRole("Verify invariants and trace data flow")).toBe("verifier");
    expect(workHandler.classifyTaskToFeynmanRole("Audit claims and compliance evidence")).toBe("auditor");
    expect(workHandler.classifyTaskToFeynmanRole("Research external library tradeoffs")).toBe("researcher");
  });

  it("routes planning tasks to planner agent when available", async () => {
    writeAgent(cwd, "crew-worker", "worker");
    writeAgent(cwd, "crew-planner", "planner");

    const task = store.createTask(cwd, "Plan architecture for task router", "Decompose execution strategy");
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string; agent?: string }>) => {
      expect(tasks[0]?.agent).toBe("crew-planner");
      store.updateTask(cwd, task.id, { status: "done" });
      return [makeResult(tasks[0]?.taskId ?? task.id, tasks[0]?.agent)] as any;
    });

    const response = await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toEqual([task.id]);
  });

  it("falls back to crew-worker when specialized role agent is unavailable", async () => {
    writeAgent(cwd, "crew-worker", "worker");

    const task = store.createTask(cwd, "Verify invariant coverage", "Trace critical paths");
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string; agent?: string }>) => {
      expect(tasks[0]?.agent).toBe("crew-worker");
      store.updateTask(cwd, task.id, { status: "done" });
      return [makeResult(tasks[0]?.taskId ?? task.id, tasks[0]?.agent)] as any;
    });

    const response = await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toEqual([task.id]);
  });
});
