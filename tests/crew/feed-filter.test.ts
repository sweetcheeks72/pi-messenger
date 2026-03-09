/**
 * FIX 4: Feed filter tests
 *
 * Tests:
 *   - filter returns only matching event types
 *   - no filter returns all events
 *   - filter with no matching events returns empty array
 */

import { describe, expect, it, beforeEach } from "vitest";
import { executeFeed } from "../../handlers.js";
import { logFeedEvent, appendFeedEvent } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

describe("executeFeed filter", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("no filter returns all events", () => {
    logFeedEvent(cwd, "AgentA", "join");
    logFeedEvent(cwd, "AgentA", "task.progress", "task-1");
    logFeedEvent(cwd, "AgentB", "task.escalate", "task-2");

    const result = executeFeed(cwd, 20, true);
    expect(result.details.events).toHaveLength(3);
  });

  it("filter returns only matching event types", () => {
    logFeedEvent(cwd, "AgentA", "join");
    logFeedEvent(cwd, "AgentA", "task.progress", "task-1");
    logFeedEvent(cwd, "AgentB", "task.escalate", "task-2");
    logFeedEvent(cwd, "AgentA", "task.progress", "task-1");

    const result = executeFeed(cwd, 20, true, "task.progress");
    const events = result.details.events as Array<{ type: string }>;
    expect(events.length).toBe(2);
    expect(events.every(e => e.type === "task.progress")).toBe(true);
  });

  it("filter with no matching events returns empty events array", () => {
    logFeedEvent(cwd, "AgentA", "join");
    logFeedEvent(cwd, "AgentA", "task.progress", "task-1");

    const result = executeFeed(cwd, 20, true, "task.escalate");
    const events = result.details.events as Array<unknown>;
    expect(events).toHaveLength(0);
  });

  it("filter on empty feed returns empty events array", () => {
    const result = executeFeed(cwd, 20, true, "task.heartbeat");
    const events = result.details.events as Array<unknown>;
    expect(events).toHaveLength(0);
  });

  it("crewEventsInFeed=false excludes crew events when no filter", () => {
    logFeedEvent(cwd, "AgentA", "join");
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "Planner",
      type: "task.done",
      target: "task-1",
      preview: "done",
    });

    // task.done is a crew event, join is not — crewEventsInFeed=false should exclude task.done
    const resultWithCrew = executeFeed(cwd, 20, true);
    const resultWithoutCrew = executeFeed(cwd, 20, false);

    const withCrewTypes = (resultWithCrew.details.events as Array<{ type: string }>).map(e => e.type);
    const withoutCrewTypes = (resultWithoutCrew.details.events as Array<{ type: string }>).map(e => e.type);

    expect(withCrewTypes).toContain("task.done");
    expect(withoutCrewTypes).not.toContain("task.done");
  });
});
