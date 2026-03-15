import { describe, expect, it } from "vitest";
import { execute } from "../../crew/handlers/task.js";
import * as store from "../../crew/store.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

describe("crew/handlers/task - start", () => {
  it("starts a task and returns the explanatory message about actual worker dispatch", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Implement auth", "Desc");

    const state = {
      agentName: "TestAgent",
      config: {}
    };

    const ctx = {
      cwd,
      ui: { notify: () => {} }
    } as any;

    const result = await execute("start", { id: task.id }, state, ctx);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result).toBeDefined();
    expect(text).toContain(`🔄 Started task **${task.id}**`);
    expect(text).toContain("task.start claims/starts the task for the current agent");
    expect(text).toContain("does NOT spawn a background worker by itself");
    expect(text).toContain("pi_messenger({ action: \"work\" })");
    expect(text).toContain("run autonomous work");
    expect(text).toContain("actual worker execution");
  });
});
