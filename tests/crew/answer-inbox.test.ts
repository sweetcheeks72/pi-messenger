/**
 * FIX 2: question.answer delivers to asking worker's inbox
 *
 * Tests:
 *   - after questionAnswer(), asking worker's inbox contains one .json file with type=question.answer
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessengerState } from "../../lib.js";
import * as store from "../../crew/store.js";
import { createMockContext } from "../helpers/mock-context.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

function createState(agentName: string = "AgentA"): MessengerState {
  return { agentName } as MessengerState;
}

describe("question.answer inbox delivery to asking worker", () => {
  let dirs: TempCrewDirs;
  let cwd: string;
  let questionHandler: typeof import("../../crew/handlers/question.js");

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
    questionHandler = await import("../../crew/handlers/question.js");
  });

  it("delivers answer to the asking worker's inbox", async () => {
    // Step 1: AgentA asks AgentB a question
    const askResponse = await questionHandler.execute(
      "ask",
      { to: "AgentB", question: "Which library should I use?" },
      createState("AgentA"),
      createMockContext(cwd),
    );
    const questionId = askResponse.details.questionId as string;

    // Step 2: AgentB answers
    await questionHandler.execute(
      "answer",
      { questionId, answer: "Use express" },
      createState("AgentB"),
      createMockContext(cwd),
    );

    // Step 3: AgentA's inbox should have the answer
    const agentAInboxDir = path.join(cwd, ".pi", "messenger", "inbox", "AgentA");
    expect(fs.existsSync(agentAInboxDir)).toBe(true);

    const files = fs.readdirSync(agentAInboxDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(agentAInboxDir, files[0]!), "utf-8"));
    expect(msg.type).toBe("question.answer");
    expect(msg.questionId).toBe(questionId);
    expect(msg.question).toBe("Which library should I use?");
    expect(msg.answer).toBe("Use express");
  });

  it("does not deliver to a different worker's inbox", async () => {
    // AgentA asks AgentB
    const askResponse = await questionHandler.execute(
      "ask",
      { to: "AgentB", question: "Which library?" },
      createState("AgentA"),
      createMockContext(cwd),
    );
    const questionId = askResponse.details.questionId as string;

    // AgentB answers
    await questionHandler.execute(
      "answer",
      { questionId, answer: "Use express" },
      createState("AgentB"),
      createMockContext(cwd),
    );

    // AgentC's inbox should NOT exist or be empty
    const agentCInboxDir = path.join(cwd, ".pi", "messenger", "inbox", "AgentC");
    if (fs.existsSync(agentCInboxDir)) {
      const files = fs.readdirSync(agentCInboxDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBe(0);
    } else {
      expect(fs.existsSync(agentCInboxDir)).toBe(false);
    }
  });
});
