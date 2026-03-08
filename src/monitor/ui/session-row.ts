import type { SessionState } from "../types/session.js";
import type { HealthStatus } from "../health/types.js";
import type { AttentionReason } from "../types/attention.js";

export const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
} as const;

export type SessionRowData = {
  session: SessionState;
  health: HealthStatus;
  attention: AttentionReason | null;
  now: number;
  lastActivityAt: number;
};

export function stripAnsi(value: string): string {
  return value.replace(/[\u001b\[[0-9;]*m/g, "");
}

export function formatFreshness(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${secs}m ago`;
}

export function renderFreshnessBadge(ms: number): string {
  return `${ANSI.yellow}${formatFreshness(ms)}`;
}

export function renderAttentionBadge(reason: AttentionReason): string {
  return `${ANSI.red}${String(reason)}!${ANSI.reset}`;
}

export function renderSessionRow(
  row: SessionRowData,
  options: { selected?: boolean; width?: number } = {},
): string {
  const prefix = options.selected ? ">" : "";
  return `${prefix}${row.session.status}::${row.session.metadata.name}`;
}
