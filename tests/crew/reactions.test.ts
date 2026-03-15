/**
 * Reactions/Emoji on Feed Events — Full TDD Test Suite (TASK-14)
 *
 * Tests the sidecar-based reaction system:
 *   - addReaction() persists to feed-reactions.json
 *   - removeReaction() removes and cleans up
 *   - getReactions() returns reaction map
 *   - formatReactionBadges() renders [✅2 👀1] strings
 *   - ALLOWED_EMOJI whitelist enforcement
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import {
  addReaction,
  removeReaction,
  getReactions,
  getReactionsForEvent,
  formatReactionBadges,
  ALLOWED_EMOJI,
  type ReactionMap,
} from "../../crew/reactions.js";

describe("reactions", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  // ===========================================================================
  // ALLOWED_EMOJI whitelist
  // ===========================================================================

  describe("ALLOWED_EMOJI", () => {
    it("contains exactly the 5 specified emoji", () => {
      expect(ALLOWED_EMOJI).toEqual(["✅", "👀", "❌", "🔥", "⏸️"]);
    });
  });

  // ===========================================================================
  // addReaction
  // ===========================================================================

  describe("addReaction", () => {
    it("persists a reaction to the sidecar file", () => {
      addReaction(cwd, "2026-03-15T10:00:00.000Z", "✅", "AgentOne");

      const reactions = getReactions(cwd);
      expect(reactions["2026-03-15T10:00:00.000Z"]).toBeDefined();
      expect(reactions["2026-03-15T10:00:00.000Z"]["✅"]).toContain("AgentOne");
    });

    it("creates the sidecar file if it does not exist", () => {
      const sidecarPath = path.join(cwd, ".pi", "messenger", "feed-reactions.json");
      expect(fs.existsSync(sidecarPath)).toBe(false);

      addReaction(cwd, "ts1", "👀", "Agent");

      expect(fs.existsSync(sidecarPath)).toBe(true);
    });

    it("appends multiple agents to the same emoji on the same event", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      addReaction(cwd, "ts1", "✅", "AgentTwo");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(eventReactions["✅"]).toEqual(["AgentOne", "AgentTwo"]);
    });

    it("supports multiple different emoji on the same event", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      addReaction(cwd, "ts1", "👀", "AgentTwo");
      addReaction(cwd, "ts1", "🔥", "AgentOne");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(Object.keys(eventReactions)).toHaveLength(3);
      expect(eventReactions["✅"]).toEqual(["AgentOne"]);
      expect(eventReactions["👀"]).toEqual(["AgentTwo"]);
      expect(eventReactions["🔥"]).toEqual(["AgentOne"]);
    });

    it("does not duplicate if the same agent reacts with the same emoji twice", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      addReaction(cwd, "ts1", "✅", "AgentOne");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(eventReactions["✅"]).toEqual(["AgentOne"]);
    });

    it("rejects emoji not in the ALLOWED_EMOJI whitelist", () => {
      expect(() => addReaction(cwd, "ts1", "💀", "Agent")).toThrow(/not allowed/i);

      // Ensure nothing was persisted
      const reactions = getReactions(cwd);
      expect(Object.keys(reactions)).toHaveLength(0);
    });

    it("supports reactions on multiple different events", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      addReaction(cwd, "ts2", "👀", "AgentTwo");

      const reactions = getReactions(cwd);
      expect(Object.keys(reactions)).toHaveLength(2);
      expect(reactions["ts1"]["✅"]).toEqual(["AgentOne"]);
      expect(reactions["ts2"]["👀"]).toEqual(["AgentTwo"]);
    });
  });

  // ===========================================================================
  // removeReaction
  // ===========================================================================

  describe("removeReaction", () => {
    it("removes a specific agent's reaction", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      addReaction(cwd, "ts1", "✅", "AgentTwo");

      removeReaction(cwd, "ts1", "✅", "AgentOne");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(eventReactions["✅"]).toEqual(["AgentTwo"]);
    });

    it("cleans up the emoji key when the last agent is removed", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      removeReaction(cwd, "ts1", "✅", "AgentOne");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(eventReactions["✅"]).toBeUndefined();
    });

    it("cleans up the event key when all reactions are removed", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");
      removeReaction(cwd, "ts1", "✅", "AgentOne");

      const reactions = getReactions(cwd);
      expect(reactions["ts1"]).toBeUndefined();
    });

    it("is a no-op if the agent has not reacted", () => {
      addReaction(cwd, "ts1", "✅", "AgentOne");

      // Removing a reaction that doesn't exist should not throw
      removeReaction(cwd, "ts1", "✅", "AgentTwo");
      removeReaction(cwd, "ts1", "👀", "AgentOne");
      removeReaction(cwd, "ts-nonexistent", "✅", "AgentOne");

      const eventReactions = getReactionsForEvent(cwd, "ts1");
      expect(eventReactions["✅"]).toEqual(["AgentOne"]);
    });

    it("is a no-op when sidecar file does not exist", () => {
      // Should not throw
      removeReaction(cwd, "ts1", "✅", "AgentOne");
      const reactions = getReactions(cwd);
      expect(Object.keys(reactions)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // getReactions / getReactionsForEvent
  // ===========================================================================

  describe("getReactions", () => {
    it("returns empty object when sidecar does not exist", () => {
      expect(getReactions(cwd)).toEqual({});
    });

    it("returns empty object when sidecar is empty/invalid JSON", () => {
      const sidecarPath = path.join(cwd, ".pi", "messenger", "feed-reactions.json");
      fs.writeFileSync(sidecarPath, "not json");
      expect(getReactions(cwd)).toEqual({});
    });

    it("returns the full reaction map", () => {
      addReaction(cwd, "ts1", "✅", "A");
      addReaction(cwd, "ts1", "👀", "B");
      addReaction(cwd, "ts2", "🔥", "C");

      const reactions = getReactions(cwd);
      expect(reactions["ts1"]["✅"]).toEqual(["A"]);
      expect(reactions["ts1"]["👀"]).toEqual(["B"]);
      expect(reactions["ts2"]["🔥"]).toEqual(["C"]);
    });
  });

  describe("getReactionsForEvent", () => {
    it("returns empty object for an event with no reactions", () => {
      expect(getReactionsForEvent(cwd, "ts-none")).toEqual({});
    });

    it("returns only the reactions for the specified event", () => {
      addReaction(cwd, "ts1", "✅", "A");
      addReaction(cwd, "ts2", "👀", "B");

      const r1 = getReactionsForEvent(cwd, "ts1");
      expect(r1["✅"]).toEqual(["A"]);
      expect(r1["👀"]).toBeUndefined();
    });
  });

  // ===========================================================================
  // formatReactionBadges
  // ===========================================================================

  describe("formatReactionBadges", () => {
    it("returns empty string when there are no reactions", () => {
      expect(formatReactionBadges({})).toBe("");
    });

    it("renders a single reaction with count", () => {
      const badge = formatReactionBadges({ "✅": ["AgentOne"] });
      expect(badge).toBe("[✅1]");
    });

    it("renders multiple reactions sorted by ALLOWED_EMOJI order", () => {
      const badge = formatReactionBadges({
        "🔥": ["A", "B"],
        "✅": ["C"],
        "👀": ["A"],
      });
      // ALLOWED_EMOJI order: ✅ 👀 ❌ 🔥 ⏸️
      expect(badge).toBe("[✅1 👀1 🔥2]");
    });

    it("handles all five emoji types", () => {
      const badge = formatReactionBadges({
        "✅": ["A"],
        "👀": ["A", "B"],
        "❌": ["C"],
        "🔥": ["A"],
        "⏸️": ["A", "B", "C"],
      });
      expect(badge).toBe("[✅1 👀2 ❌1 🔥1 ⏸️3]");
    });

    it("omits emoji with empty agent arrays", () => {
      const badge = formatReactionBadges({
        "✅": ["A"],
        "👀": [],
      });
      expect(badge).toBe("[✅1]");
    });
  });
});
