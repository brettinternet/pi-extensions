import { describe, expect, test } from "bun:test";
import {
  checkCommandLabel,
  describeTool,
  ProgressState,
} from "../../extensions/progress/state.ts";

describe("progress state", () => {
  test("tracks parallel tools by call ID", () => {
    const state = new ProgressState();
    state.beginRun();
    state.startTool("read-1", "read", { path: "/repo/src/a.ts" }, "/repo");
    state.startTool("read-2", "read", { path: "/repo/src/b.ts" }, "/repo");

    expect(
      state.snapshot().tools.map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: "read-1", label: "read src/a.ts" },
      { id: "read-2", label: "read src/b.ts" },
    ]);

    state.finishTool(
      "read-2",
      "read",
      { path: "/repo/src/b.ts" },
      "/repo",
      false,
    );
    expect(state.snapshot().tools.map(({ id }) => id)).toEqual(["read-1"]);
  });

  test("records only successful edit and write targets as touched", () => {
    const state = new ProgressState();
    state.beginRun();
    state.startTool("edit", "edit", { path: "/repo/src/a.ts" }, "/repo");
    state.finishTool(
      "edit",
      "edit",
      { path: "/repo/src/a.ts" },
      "/repo",
      false,
    );
    state.startTool("write", "write", { path: "/repo/src/b.ts" }, "/repo");
    state.finishTool(
      "write",
      "write",
      { path: "/repo/src/b.ts" },
      "/repo",
      true,
    );
    state.startTool("read", "read", { path: "/repo/src/c.ts" }, "/repo");
    state.finishTool(
      "read",
      "read",
      { path: "/repo/src/c.ts" },
      "/repo",
      false,
    );

    expect(state.snapshot().touchedPaths).toEqual(["src/a.ts"]);
  });

  test("retains two recent observed check outcomes", () => {
    const state = new ProgressState();
    state.beginRun();
    for (const [id, command, failed] of [
      ["one", "bun test", false],
      ["two", "task check", true],
      ["three", "git diff --check", false],
    ] as const) {
      state.startTool(id, "bash", { command }, "/repo");
      state.finishTool(id, "bash", { command }, "/repo", failed);
    }

    expect(state.snapshot().checks).toEqual([
      { id: "two", label: "task check", outcome: "failed" },
      { id: "three", label: "git diff --check", outcome: "passed" },
    ]);
  });

  test("keeps completed facts after settling and clears them for the next run", () => {
    const state = new ProgressState();
    state.beginRun();
    state.startTool("check", "bash", { command: "bun test" }, "/repo");
    state.finishTool("check", "bash", { command: "bun test" }, "/repo", false);
    state.settleRun();

    expect(state.snapshot()).toMatchObject({
      runStarted: true,
      agentActive: false,
      checks: [{ outcome: "passed" }],
    });

    state.beginRun();
    expect(state.snapshot()).toEqual({
      runStarted: true,
      agentActive: true,
      tools: [],
      checks: [],
      touchedPaths: [],
    });
  });
});

describe("tool descriptions", () => {
  test("recognizes wrapped check commands without treating ordinary commands as checks", () => {
    expect(checkCommandLabel("cd /repo && rtk mise exec -- task check")).toBe(
      "task check",
    );
    expect(checkCommandLabel("mise exec bun -- bun test src/a.test.ts")).toBe(
      "bun test src/a.test.ts",
    );
    expect(checkCommandLabel("rg test src")).toBeUndefined();
  });

  test("uses relative paths inside the workspace", () => {
    expect(describeTool("edit", { path: "/repo/src/a.ts" }, "/repo")).toEqual({
      label: "edit src/a.ts",
      path: "src/a.ts",
    });
  });
});
