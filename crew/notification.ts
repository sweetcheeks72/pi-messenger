/**
 * Terminal Notification on Escalation — TASK-13
 *
 * Push escalation notifications via terminal bell + overlay banner.
 * Format: 🚨 [BLOCK] Agent Dyson stalled on task-3 (Φ=4.2) — 2m ago
 *
 * Deploy: cp /tmp/agent-channel-staged/notification.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/crew/notification.ts
 */

// Types
export type NotificationSeverity = "warn" | "block" | "critical";

export interface Notification {
  id: string;
  severity: NotificationSeverity;
  message: string;
  createdAt: number; // epoch ms
  dismissedAt?: number;
  autoDismissMs: number;
}

export interface EscalationEvent {
  agentName: string;
  taskId?: string;
  severity: NotificationSeverity;
  message: string;
  phi?: number;
}

// Severity icons
const SEVERITY_ICONS: Record<NotificationSeverity, string> = {
  warn: "⚠️",
  block: "🚨",
  critical: "🔴",
};

// Format helpers
function timeAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

let idCounter = 0;

/**
 * Format an escalation event into a notification banner string.
 */
export function formatNotification(event: EscalationEvent): string {
  const icon = SEVERITY_ICONS[event.severity] ?? "•";
  const sev = event.severity.toUpperCase();
  const phi = event.phi !== undefined ? ` (Φ=${event.phi.toFixed(1)})` : "";
  const task = event.taskId ? ` on ${event.taskId}` : "";
  return `${icon} [${sev}] Agent ${event.agentName}${task}${phi} — ${event.message}`;
}

/**
 * Create a notification from an escalation event.
 */
export function createNotification(
  event: EscalationEvent,
  autoDismissMs = 30_000,
): Notification {
  return {
    id: `notif-${++idCounter}-${Date.now()}`,
    severity: event.severity,
    message: formatNotification(event),
    createdAt: Date.now(),
    autoDismissMs,
  };
}

/**
 * Terminal bell escape sequence.
 */
export function terminalBell(): string {
  return "\x07";
}

/**
 * Check if a notification should be auto-dismissed.
 */
export function shouldDismiss(notif: Notification, nowMs?: number): boolean {
  if (notif.dismissedAt !== undefined) return true;
  const now = nowMs ?? Date.now();
  return now - notif.createdAt >= notif.autoDismissMs;
}

/**
 * Dismiss a notification manually.
 */
export function dismiss(notif: Notification): Notification {
  return { ...notif, dismissedAt: Date.now() };
}

// NotificationManager — holds active notifications
export class NotificationManager {
  private notifications: Notification[] = [];
  private maxVisible = 3;

  constructor(options?: { maxVisible?: number }) {
    this.maxVisible = options?.maxVisible ?? 3;
  }

  /**
   * Add a notification from an escalation event.
   * Returns the created notification.
   * Plays terminal bell for block/critical severity.
   */
  add(event: EscalationEvent, autoDismissMs = 30_000): { notification: Notification; bell: boolean } {
    const notif = createNotification(event, autoDismissMs);
    this.notifications.push(notif);
    const bell = event.severity === "block" || event.severity === "critical";
    return { notification: notif, bell };
  }

  /**
   * Get currently visible (non-dismissed, non-expired) notifications.
   */
  getVisible(nowMs?: number): Notification[] {
    const now = nowMs ?? Date.now();
    this.notifications = this.notifications.filter(n => !shouldDismiss(n, now));
    return this.notifications.slice(0, this.maxVisible);
  }

  /**
   * Dismiss a notification by ID.
   */
  dismiss(id: string): void {
    const notif = this.notifications.find(n => n.id === id);
    if (notif) notif.dismissedAt = Date.now();
  }

  /**
   * Dismiss all notifications.
   */
  dismissAll(): void {
    const now = Date.now();
    for (const n of this.notifications) n.dismissedAt = now;
  }

  /**
   * Get count of active notifications.
   */
  get count(): number {
    return this.getVisible().length;
  }
}
