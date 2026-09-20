import { describe, expect, it } from "bun:test";

import { planCompletion } from "../../extensions/until/completion.ts";

describe("completion routing", () => {
  it("keeps notify-only actor failures out of the agent wake path", () => {
    expect(planCompletion("failed", "notify")).toEqual({
      kind: "notify",
      level: "warning",
      summary: "failed",
    });
  });

  it("wakes the agent for agent-mode failures", () => {
    expect(planCompletion("failed", "agent")).toMatchObject({
      kind: "agent",
    });
  });
});
