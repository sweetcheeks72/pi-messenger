import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("checked-in crew agent prompts", () => {
  it("keeps interview guidance in the worker and planner prompts", () => {
    const workerPrompt = fs.readFileSync(path.join(process.cwd(), "crew", "agents", "crew-worker.md"), "utf8");
    const plannerPrompt = fs.readFileSync(path.join(process.cwd(), "crew", "agents", "crew-planner.md"), "utf8");

    expect(workerPrompt).toContain("tools: read, write, edit, bash, pi_messenger, interview");
    expect(workerPrompt).toContain("## User Clarification");
    expect(workerPrompt).toContain("task.progress");
    expect(workerPrompt).toContain("task.block");

    expect(plannerPrompt).toContain("tools: read, bash, web_search, pi_messenger, interview");
    expect(plannerPrompt).toContain("## User Clarification (Scope Gaps)");
    expect(plannerPrompt).toContain("Use the `interview` tool");
  });
});
