import { describe, expect, test, beforeEach } from "vitest";
import { detectConvergence, detectBottlenecks, AmbientWatchLoop } from "../../crew/ambient-watch.js";
import type { ReservationEntry, TaskDep, HealthBusLike, CrewStoreLike } from "../../crew/ambient-watch.js";

// Deploy: cp /tmp/agent-channel-staged/ambient-watch.test.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/tests/crew/ambient-watch.test.ts

describe("detectConvergence", () => {
  test("detects overlapping file reservations between 2 agents", () => {
    const reservations: ReservationEntry[] = [
      { agent: "Dyson", paths: ["src/auth.ts", "src/db.ts"] },
      { agent: "Murray", paths: ["src/auth.ts"] },
    ];
    const signals = detectConvergence(reservations);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("convergence");
    expect(signals[0].file).toBe("src/auth.ts");
    expect(signals[0].agents).toContain("Dyson");
    expect(signals[0].agents).toContain("Murray");
  });

  test("no signal when agents have disjoint files", () => {
    const reservations: ReservationEntry[] = [
      { agent: "Dyson", paths: ["src/a.ts"] },
      { agent: "Murray", paths: ["src/b.ts"] },
    ];
    expect(detectConvergence(reservations)).toHaveLength(0);
  });

  test("detects multiple convergence points", () => {
    const reservations: ReservationEntry[] = [
      { agent: "A", paths: ["x.ts", "y.ts"] },
      { agent: "B", paths: ["x.ts", "y.ts"] },
    ];
    expect(detectConvergence(reservations)).toHaveLength(2);
  });

  test("handles empty reservations", () => {
    expect(detectConvergence([])).toHaveLength(0);
  });

  test("no duplicate agents in signal", () => {
    const reservations: ReservationEntry[] = [
      { agent: "A", paths: ["x.ts"] },
      { agent: "A", paths: ["x.ts"] },
    ];
    const signals = detectConvergence(reservations);
    expect(signals).toHaveLength(0); // same agent, not a convergence
  });
});

describe("detectBottlenecks", () => {
  test("detects task blocking 3+ downstream", () => {
    const tasks: TaskDep[] = [
      { id: "task-1", status: "todo", depends_on: [] },
      { id: "task-2", status: "todo", depends_on: ["task-1"] },
      { id: "task-3", status: "todo", depends_on: ["task-1"] },
      { id: "task-4", status: "todo", depends_on: ["task-1"] },
    ];
    const signals = detectBottlenecks(tasks, 3);
    expect(signals).toHaveLength(1);
    expect(signals[0].taskId).toBe("task-1");
    expect(signals[0].blockedCount).toBe(3);
  });

  test("no signal below threshold", () => {
    const tasks: TaskDep[] = [
      { id: "task-1", status: "todo", depends_on: [] },
      { id: "task-2", status: "todo", depends_on: ["task-1"] },
      { id: "task-3", status: "todo", depends_on: ["task-1"] },
    ];
    expect(detectBottlenecks(tasks, 3)).toHaveLength(0);
  });

  test("done deps are not bottlenecks", () => {
    const tasks: TaskDep[] = [
      { id: "task-1", status: "done", depends_on: [] },
      { id: "task-2", status: "todo", depends_on: ["task-1"] },
      { id: "task-3", status: "todo", depends_on: ["task-1"] },
      { id: "task-4", status: "todo", depends_on: ["task-1"] },
    ];
    expect(detectBottlenecks(tasks, 3)).toHaveLength(0);
  });

  test("handles empty task list", () => {
    expect(detectBottlenecks([], 3)).toHaveLength(0);
  });
});

describe("AmbientWatchLoop", () => {
  function mockHealthBus(snapshots: any[] = []): HealthBusLike {
    return { getAllSnapshots: () => snapshots };
  }

  function mockCrewStore(reservations: ReservationEntry[] = [], tasks: TaskDep[] = []): CrewStoreLike {
    return { getReservations: () => reservations, getTaskDeps: () => tasks };
  }

  test("evaluate returns convergence signals", () => {
    const store = mockCrewStore([
      { agent: "A", paths: ["f.ts"] },
      { agent: "B", paths: ["f.ts"] },
    ]);
    const loop = new AmbientWatchLoop(mockHealthBus(), store);
    const signals = loop.evaluate();
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("convergence");
  });

  test("evaluate returns bottleneck signals", () => {
    const tasks: TaskDep[] = [
      { id: "t1", status: "todo", depends_on: [] },
      { id: "t2", status: "todo", depends_on: ["t1"] },
      { id: "t3", status: "todo", depends_on: ["t1"] },
      { id: "t4", status: "todo", depends_on: ["t1"] },
    ];
    const loop = new AmbientWatchLoop(mockHealthBus(), mockCrewStore([], tasks));
    const signals = loop.evaluate();
    expect(signals.some(s => s.type === "bottleneck")).toBe(true);
  });

  test("getSignals accumulates across evaluate calls", () => {
    const store = mockCrewStore([
      { agent: "A", paths: ["f.ts"] },
      { agent: "B", paths: ["f.ts"] },
    ]);
    const loop = new AmbientWatchLoop(mockHealthBus(), store);
    loop.evaluate();
    loop.evaluate();
    expect(loop.getSignals().length).toBe(2);
  });

  test("clearSignals resets accumulator", () => {
    const store = mockCrewStore([
      { agent: "A", paths: ["f.ts"] },
      { agent: "B", paths: ["f.ts"] },
    ]);
    const loop = new AmbientWatchLoop(mockHealthBus(), store);
    loop.evaluate();
    loop.clearSignals();
    expect(loop.getSignals()).toHaveLength(0);
  });

  test("subscribe notifies on new signals", () => {
    const received: any[] = [];
    const store = mockCrewStore([
      { agent: "A", paths: ["f.ts"] },
      { agent: "B", paths: ["f.ts"] },
    ]);
    const loop = new AmbientWatchLoop(mockHealthBus(), store);
    loop.subscribe(sig => received.push(sig));
    loop.evaluate();
    expect(received).toHaveLength(1);
  });

  test("unsubscribe stops notifications", () => {
    const received: any[] = [];
    const store = mockCrewStore([
      { agent: "A", paths: ["f.ts"] },
      { agent: "B", paths: ["f.ts"] },
    ]);
    const loop = new AmbientWatchLoop(mockHealthBus(), store);
    const unsub = loop.subscribe(sig => received.push(sig));
    unsub();
    loop.evaluate();
    expect(received).toHaveLength(0);
  });

  test("start/stop controls interval", () => {
    const loop = new AmbientWatchLoop(mockHealthBus(), mockCrewStore());
    loop.start(100);
    loop.stop();
    // No assertion needed — just verify no crash
  });

  test("handles errors in health bus gracefully", () => {
    const badBus: HealthBusLike = { getAllSnapshots: () => { throw new Error("down"); } };
    const loop = new AmbientWatchLoop(badBus, mockCrewStore());
    expect(() => loop.evaluate()).not.toThrow();
  });

  test("handles errors in crew store gracefully", () => {
    const badStore: CrewStoreLike = {
      getReservations: () => { throw new Error("down"); },
      getTaskDeps: () => { throw new Error("down"); },
    };
    const loop = new AmbientWatchLoop(mockHealthBus(), badStore);
    expect(() => loop.evaluate()).not.toThrow();
  });
});
