/**
 * Lifecycle Phase Detection + Rendering — TASK-12
 *
 * Exposes governance lifecycleState in both TUI and OmO.
 * Reads lifecycle from crew store or governance state.
 *
 * Deploy: cp /tmp/agent-channel-staged/lifecycle-phase.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/crew/lifecycle-phase.ts
 */

// Types
export type LifecyclePhase = "planning" | "executing" | "reviewing" | "done" | "unknown";

export interface LifecycleState {
  phase: LifecyclePhase;
  since: string; // ISO timestamp
}

// Phase colors for TUI rendering (ANSI)
export const PHASE_COLORS: Record<LifecyclePhase, string> = {
  planning: "\x1b[36m",   // cyan
  executing: "\x1b[33m",  // yellow
  reviewing: "\x1b[35m",  // magenta
  done: "\x1b[32m",       // green
  unknown: "\x1b[90m",    // dim gray
};
export const RESET = "\x1b[0m";

/**
 * Infer lifecycle phase from crew task states.
 */
export function inferLifecyclePhase(taskStates: Array<{ status: string }>): LifecyclePhase {
  if (taskStates.length === 0) return "unknown";

  const statuses = taskStates.map(t => t.status);
  const allDone = statuses.every(s => s === "done");
  if (allDone) return "done";

  const hasInProgress = statuses.some(s => s === "in_progress");
  const hasReview = statuses.some(s => s === "pending_review" || s === "pending_integration");

  if (hasReview) return "reviewing";
  if (hasInProgress) return "executing";

  // All todo = still planning
  const allTodo = statuses.every(s => s === "todo" || s === "blocked");
  if (allTodo) return "planning";

  // Mix of done + todo = executing
  return "executing";
}

/**
 * Format lifecycle badge for TUI status bar.
 * Example: [EXECUTING]
 */
export function formatLifecycleBadge(phase: LifecyclePhase): string {
  const color = PHASE_COLORS[phase] ?? PHASE_COLORS.unknown;
  return `${color}[${phase.toUpperCase()}]${RESET}`;
}

/**
 * Format lifecycle badge without ANSI (for OmO/HTML).
 */
export function formatLifecycleBadgePlain(phase: LifecyclePhase): string {
  return `[${phase.toUpperCase()}]`;
}

/**
 * Get emphasis hints for UI layout based on phase.
 * TUI/OmO can use these to highlight relevant panels.
 */
export function getPhaseEmphasis(phase: LifecyclePhase): {
  highlightPlan: boolean;
  highlightWorkers: boolean;
  highlightReview: boolean;
} {
  switch (phase) {
    case "planning":
      return { highlightPlan: true, highlightWorkers: false, highlightReview: false };
    case "executing":
      return { highlightPlan: false, highlightWorkers: true, highlightReview: false };
    case "reviewing":
      return { highlightPlan: false, highlightWorkers: false, highlightReview: true };
    case "done":
      return { highlightPlan: false, highlightWorkers: false, highlightReview: false };
    default:
      return { highlightPlan: false, highlightWorkers: false, highlightReview: false };
  }
}
