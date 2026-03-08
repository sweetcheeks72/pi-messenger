import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Track existsSync calls via a controllable mock
let mockExistsSync: (p: fs.PathLike) => boolean = () => true;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: (p: fs.PathLike) => mockExistsSync(p),
  };
});

const mockSpawn = vi.fn(() => {
  const handlers: Record<string, Function> = {};
  const proc: any = {
    pid: 99999,
    killed: false,
    exitCode: null,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    kill: vi.fn(() => { proc.exitCode = 0; }),
    _handlers: handlers,
  };
  return proc;
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "/usr/bin/which-pi\n"),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const mockGetTasks = vi.fn(() => []);

vi.mock("../../crew/store.js", () => ({
  getPlan: vi.fn(() => ({ prd: "docs/PRD.md" })),
  getCrewDir: vi.fn((cwd: string) => `${cwd}/.pi/messenger/crew`),
  getTask: vi.fn(() => null),
  getTasks: (...args: any[]) => mockGetTasks(...args),
  getBaseCommit: vi.fn(() => "abc1234"),
  updateTask: vi.fn(),
  appendTaskProgress: vi.fn(),
  incrementSpawnFailureCount: vi.fn(),
}));

vi.mock("../../feed.js", () => ({
  logFeedEvent: vi.fn(),
}));

vi.mock("../../crew/utils/config.js", () => ({
  loadCrewConfig: vi.fn(() => ({
    concurrency: { workers: 4 },
    models: {},
    artifacts: { enabled: false },
    work: {},
    coordination: "chatty",
    smokeTest: { enabled: true, intervalMs: 120_000, minActiveTasks: 3 },
  })),
}));

vi.mock("../../crew/utils/discover.js", () => ({
  discoverCrewAgents: vi.fn(() => [{
    name: "crew-worker",
    description: "worker",
    systemPrompt: "# Crew Worker\nYou implement tasks.",
    tools: ["read", "write", "edit", "bash", "pi_messenger"],
    source: "extension",
    filePath: "/ext/crew-worker.md",
    crewRole: "worker",
    model: "claude-opus-4-5",
  }]),
}));

vi.mock("../../crew/live-progress.js", () => ({
  updateLiveWorker: vi.fn(),
  removeLiveWorker: vi.fn(),
}));

vi.mock("../../lib.js", async () => {
  let counter = 0;
  return {
    generateMemorableName: () => `SmokeTestWorker${++counter}`,
  };
});

describe("smoke test functions", () => {
  let lobby: typeof import("../../crew/lobby.js");
  let feedMod: typeof import("../../feed.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawn.mockClear();
    vi.resetModules();
    lobby = await import("../../crew/lobby.js");
    feedMod = await import("../../feed.js");
  });

  describe("shouldRunSmokeTest", () => {
    it("returns false when fewer than 3 tasks are in_progress", () => {
      mockGetTasks.mockReturnValue([
        { id: "task-1", status: "in_progress" },
        { id: "task-2", status: "todo" },
      ]);
      expect(lobby.shouldRunSmokeTest("/tmp/test")).toBe(false);
    });

    it("returns true when 3+ tasks are in_progress", () => {
      mockGetTasks.mockReturnValue([
        { id: "task-1", status: "in_progress" },
        { id: "task-2", status: "in_progress" },
        { id: "task-3", status: "in_progress" },
      ]);
      expect(lobby.shouldRunSmokeTest("/tmp/test")).toBe(true);
    });

    it("counts 'starting' tasks toward active threshold", () => {
      mockGetTasks.mockReturnValue([
        { id: "task-1", status: "in_progress" },
        { id: "task-2", status: "starting" },
        { id: "task-3", status: "in_progress" },
      ]);
      expect(lobby.shouldRunSmokeTest("/tmp/test")).toBe(true);
    });

    it("returns false when smokeTest is disabled", async () => {
      const configMod = await import("../../crew/utils/config.js");
      vi.mocked(configMod.loadCrewConfig).mockReturnValue({
        concurrency: { workers: 4, max: 10 },
        models: {},
        artifacts: { enabled: false, cleanupDays: 7 },
        work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false },
        coordination: "chatty",
        messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
        dependencies: "advisory",
        memory: { enabled: false },
        planSync: { enabled: false },
        review: { enabled: true, maxIterations: 3 },
        planning: { maxPasses: 1 },
        truncation: {
          planners: { bytes: 204800, lines: 5000 },
          workers: { bytes: 204800, lines: 5000 },
          reviewers: { bytes: 102400, lines: 2000 },
          analysts: { bytes: 102400, lines: 2000 },
        },
        smokeTest: { enabled: false, intervalMs: 120_000, minActiveTasks: 3 },
      });
      mockGetTasks.mockReturnValue([
        { id: "task-1", status: "in_progress" },
        { id: "task-2", status: "in_progress" },
        { id: "task-3", status: "in_progress" },
      ]);
      expect(lobby.shouldRunSmokeTest("/tmp/test")).toBe(false);
    });
  });

  describe("startSmokeTest", () => {
    it("spawns a smoke-tester process when agent file exists", () => {
      mockExistsSync = () => true;
      lobby.startSmokeTest("/tmp/test-repo");

      expect(mockSpawn).toHaveBeenCalled();
      const callArgs = mockSpawn.mock.calls[0];
      // The args should contain smoke-tester.md reference
      expect(callArgs[1]).toEqual(
        expect.arrayContaining(["--append-system-prompt", expect.stringContaining("smoke-tester.md")]),
      );
      expect(feedMod.logFeedEvent).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "smoke-tester",
        "smoke.start",
        undefined,
        expect.any(String),
      );
    });

    it("does not spawn if agent file is missing", () => {
      mockExistsSync = () => false;
      lobby.startSmokeTest("/tmp/test-repo");

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(feedMod.logFeedEvent).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "smoke-tester",
        "smoke.skip",
        undefined,
        expect.any(String),
      );
    });
  });

  describe("stopSmokeTest", () => {
    it("kills running smoke test process", () => {
      mockExistsSync = () => true;
      lobby.startSmokeTest("/tmp/test-repo");

      const proc = mockSpawn.mock.results[0]?.value;
      expect(proc).toBeDefined();
      expect(proc.exitCode).toBeNull();

      lobby.stopSmokeTest();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
