import { describe, expect, test, beforeEach } from "vitest";
import {
  formatNotification, createNotification, shouldDismiss, dismiss,
  terminalBell, NotificationManager,
} from "../../crew/notification.js";
import type { EscalationEvent } from "../../crew/notification.js";

// Deploy: cp /tmp/agent-channel-staged/notification.test.txt ~/.pi/agent/git/github.com/sweetcheeks72/pi-messenger/tests/crew/notification.test.ts

describe("formatNotification", () => {
  test("formats block escalation with phi", () => {
    const msg = formatNotification({
      agentName: "Dyson", taskId: "task-3", severity: "block",
      message: "stalled", phi: 4.2,
    });
    expect(msg).toContain("🚨");
    expect(msg).toContain("[BLOCK]");
    expect(msg).toContain("Dyson");
    expect(msg).toContain("task-3");
    expect(msg).toContain("Φ=4.2");
  });

  test("formats warn without phi", () => {
    const msg = formatNotification({
      agentName: "Murray", severity: "warn", message: "slow",
    });
    expect(msg).toContain("⚠️");
    expect(msg).toContain("[WARN]");
    expect(msg).not.toContain("Φ");
  });

  test("formats critical severity", () => {
    const msg = formatNotification({
      agentName: "Hans", severity: "critical", message: "dead",
    });
    expect(msg).toContain("🔴");
    expect(msg).toContain("[CRITICAL]");
  });

  test("omits task when taskId not provided", () => {
    const msg = formatNotification({
      agentName: "Dyson", severity: "warn", message: "cost high",
    });
    expect(msg).not.toContain(" on ");
  });
});

describe("createNotification", () => {
  test("creates notification with correct fields", () => {
    const notif = createNotification({
      agentName: "Dyson", severity: "block", message: "stalled",
    });
    expect(notif.id).toMatch(/^notif-/);
    expect(notif.severity).toBe("block");
    expect(notif.createdAt).toBeGreaterThan(0);
    expect(notif.autoDismissMs).toBe(30_000);
    expect(notif.dismissedAt).toBeUndefined();
  });

  test("respects custom autoDismissMs", () => {
    const notif = createNotification(
      { agentName: "A", severity: "warn", message: "x" },
      60_000,
    );
    expect(notif.autoDismissMs).toBe(60_000);
  });
});

describe("shouldDismiss", () => {
  test("returns false when within TTL", () => {
    const notif = createNotification({ agentName: "A", severity: "warn", message: "x" }, 30_000);
    expect(shouldDismiss(notif, notif.createdAt + 10_000)).toBe(false);
  });

  test("returns true when past TTL", () => {
    const notif = createNotification({ agentName: "A", severity: "warn", message: "x" }, 30_000);
    expect(shouldDismiss(notif, notif.createdAt + 31_000)).toBe(true);
  });

  test("returns true when manually dismissed", () => {
    const notif = dismiss(createNotification({ agentName: "A", severity: "warn", message: "x" }));
    expect(shouldDismiss(notif)).toBe(true);
  });
});

describe("terminalBell", () => {
  test("returns BEL character", () => {
    expect(terminalBell()).toBe("\x07");
  });
});

describe("NotificationManager", () => {
  let mgr: NotificationManager;

  beforeEach(() => { mgr = new NotificationManager(); });

  test("add creates a notification", () => {
    const { notification } = mgr.add({ agentName: "Dyson", severity: "warn", message: "slow" });
    expect(notification.severity).toBe("warn");
    expect(mgr.count).toBe(1);
  });

  test("bell is true for block severity", () => {
    const { bell } = mgr.add({ agentName: "Dyson", severity: "block", message: "stalled" });
    expect(bell).toBe(true);
  });

  test("bell is true for critical severity", () => {
    const { bell } = mgr.add({ agentName: "Dyson", severity: "critical", message: "dead" });
    expect(bell).toBe(true);
  });

  test("bell is false for warn severity", () => {
    const { bell } = mgr.add({ agentName: "Dyson", severity: "warn", message: "slow" });
    expect(bell).toBe(false);
  });

  test("getVisible returns non-dismissed notifications", () => {
    mgr.add({ agentName: "A", severity: "warn", message: "1" });
    mgr.add({ agentName: "B", severity: "block", message: "2" });
    expect(mgr.getVisible()).toHaveLength(2);
  });

  test("getVisible respects maxVisible", () => {
    const mgr2 = new NotificationManager({ maxVisible: 2 });
    mgr2.add({ agentName: "A", severity: "warn", message: "1" });
    mgr2.add({ agentName: "B", severity: "warn", message: "2" });
    mgr2.add({ agentName: "C", severity: "warn", message: "3" });
    expect(mgr2.getVisible()).toHaveLength(2);
  });

  test("getVisible filters expired notifications", () => {
    const { notification } = mgr.add({ agentName: "A", severity: "warn", message: "x" }, 1000);
    expect(mgr.getVisible(notification.createdAt + 2000)).toHaveLength(0);
  });

  test("dismiss removes specific notification", () => {
    const { notification } = mgr.add({ agentName: "A", severity: "warn", message: "x" });
    mgr.dismiss(notification.id);
    expect(mgr.count).toBe(0);
  });

  test("dismissAll clears everything", () => {
    mgr.add({ agentName: "A", severity: "warn", message: "1" });
    mgr.add({ agentName: "B", severity: "block", message: "2" });
    mgr.dismissAll();
    expect(mgr.count).toBe(0);
  });
});
