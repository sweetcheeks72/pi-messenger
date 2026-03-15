/**
 * Ambient Watch Loop — Cross-Agent Pattern Detection
 * TASK-11
 *
 * Deploy: cp /tmp/agent-channel-staged/ambient-watch.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/crew/ambient-watch.ts
 */

import type { AgentHealthSnapshot } from "./health-bus.js";

// Types
export interface ConvergenceSignal { type: "convergence"; agents: string[]; file: string; message: string; }
export interface BottleneckSignal { type: "bottleneck"; taskId: string; blockedCount: number; message: string; }
export interface VelocityDropSignal { type: "velocity-drop"; agent: string; before: number; after: number; message: string; }
export interface CostSurgeSignal { type: "cost-surge"; agent: string; rate: number; message: string; }
export interface DriftSignal { type: "drift"; agent: string; expected: string; actual: string; message: string; }

export type AmbientSignal = ConvergenceSignal | BottleneckSignal | VelocityDropSignal | CostSurgeSignal | DriftSignal;
export type SignalListener = (signal: AmbientSignal) => void;

export interface ReservationEntry { agent: string; paths: string[]; }
export interface TaskDep { id: string; status: string; depends_on: string[]; }
export interface HealthBusLike { getAllSnapshots(): AgentHealthSnapshot[]; }
export interface CrewStoreLike { getReservations(): ReservationEntry[]; getTaskDeps(): TaskDep[]; }

export function detectConvergence(reservations: ReservationEntry[]): ConvergenceSignal[] {
  const fileToAgents = new Map<string, string[]>();
  for (const entry of reservations) {
    for (const p of entry.paths) {
      const agents = fileToAgents.get(p) ?? [];
      if (!agents.includes(entry.agent)) agents.push(entry.agent);
      fileToAgents.set(p, agents);
    }
  }
  const signals: ConvergenceSignal[] = [];
  for (const [file, agents] of fileToAgents) {
    if (agents.length >= 2) {
      signals.push({ type: "convergence", agents: [...agents], file, message: `${agents.join(", ")} both working on ${file}` });
    }
  }
  return signals;
}

export function detectBottlenecks(tasks: TaskDep[], threshold = 3): BottleneckSignal[] {
  const blockedBy = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "done") continue;
    for (const dep of task.depends_on) {
      const depTask = tasks.find((t) => t.id === dep);
      if (depTask && depTask.status !== "done") {
        blockedBy.set(dep, (blockedBy.get(dep) ?? 0) + 1);
      }
    }
  }
  const signals: BottleneckSignal[] = [];
  for (const [taskId, count] of blockedBy) {
    if (count >= threshold) {
      signals.push({ type: "bottleneck", taskId, blockedCount: count, message: `Task ${taskId} blocking ${count} downstream tasks` });
    }
  }
  return signals;
}

export function detectVelocityDrop(
  prev: Map<string, { toolCallCount: number; timestamp: number }>,
  current: AgentHealthSnapshot[],
  dropThreshold = 0.5,
): VelocityDropSignal[] {
  const signals: VelocityDropSignal[] = [];
  for (const snap of current) {
    const p = prev.get(snap.agentName);
    if (!p) continue;
    const elapsed = snap.lastHeartbeatAt - p.timestamp;
    if (elapsed <= 0) continue;
    const prevElapsed = p.timestamp - (snap.createdAt ?? p.timestamp);
    if (prevElapsed <= 0) continue;
    const prevRate = p.toolCallCount / (prevElapsed / 60000);
    const currentRate = (snap.toolCallCount - p.toolCallCount) / (elapsed / 60000);
    if (prevRate > 0 && currentRate / prevRate < dropThreshold) {
      signals.push({
        type: "velocity-drop", agent: snap.agentName,
        before: Math.round(prevRate * 10) / 10, after: Math.round(currentRate * 10) / 10,
        message: `${snap.agentName} velocity dropped from ${prevRate.toFixed(1)} to ${currentRate.toFixed(1)} calls/min`,
      });
    }
  }
  return signals;
}

export class AmbientWatchLoop {
  private healthBus: HealthBusLike;
  private crewStore: CrewStoreLike;
  private listeners = new Set<SignalListener>();
  private signals: AmbientSignal[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousSnapshots = new Map<string, { toolCallCount: number; timestamp: number }>();
  private bottleneckThreshold: number;

  constructor(healthBus: HealthBusLike, crewStore: CrewStoreLike, options?: { bottleneckThreshold?: number }) {
    this.healthBus = healthBus;
    this.crewStore = crewStore;
    this.bottleneckThreshold = options?.bottleneckThreshold ?? 3;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  evaluate(): AmbientSignal[] {
    const newSignals: AmbientSignal[] = [];
    try { newSignals.push(...detectConvergence(this.crewStore.getReservations())); } catch {}
    try { newSignals.push(...detectBottlenecks(this.crewStore.getTaskDeps(), this.bottleneckThreshold)); } catch {}
    try {
      const snaps = this.healthBus.getAllSnapshots();
      newSignals.push(...detectVelocityDrop(this.previousSnapshots, snaps));
      this.previousSnapshots.clear();
      for (const s of snaps) this.previousSnapshots.set(s.agentName, { toolCallCount: s.toolCallCount, timestamp: s.lastHeartbeatAt });
    } catch {}
    this.signals.push(...newSignals);
    for (const sig of newSignals) { for (const fn of this.listeners) { try { fn(sig); } catch {} } }
    return newSignals;
  }

  getSignals(): AmbientSignal[] { return [...this.signals]; }
  clearSignals(): void { this.signals = []; }
  subscribe(fn: SignalListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
