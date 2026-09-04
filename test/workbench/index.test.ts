import { describe, expect, test } from "bun:test";
import {
  OwnershipRegistry,
  terminalOutcome,
} from "../../extensions/workbench/index.ts";

describe("workbench ownership", () => {
  test("replays additions and removals from session entries", () => {
    const ownership = new OwnershipRegistry();
    ownership.apply({
      version: 1,
      operation: "add",
      resource: "job",
      id: "job-1",
      workspaceId: "workspace-1",
    });
    ownership.apply({
      version: 1,
      operation: "add",
      resource: "known-pane",
      id: "pane-1",
    });
    ownership.apply({
      version: 1,
      operation: "add",
      resource: "terminal-job",
      id: "job-1",
    });

    expect(ownership.jobs.get("job-1")?.workspaceId).toBe("workspace-1");
    expect(ownership.knownPanes.has("pane-1")).toBeTrue();
    expect(ownership.terminalJobs.has("job-1")).toBeTrue();

    ownership.apply({
      version: 1,
      operation: "remove",
      resource: "job",
      id: "job-1",
    });
    expect(ownership.jobs.has("job-1")).toBeFalse();
  });
});

describe("workbench completion normalization", () => {
  test("treats a nonzero completed process as failed", () => {
    expect(terminalOutcome({ status: "completed", exitCode: 7 })).toBe("failed");
    expect(terminalOutcome({ status: "completed", exitCode: 0 })).toBe("succeeded");
  });

  test("preserves cancellation and running states", () => {
    expect(terminalOutcome({ status: "cancelled", exitCode: 130 })).toBe("cancelled");
    expect(terminalOutcome({ status: "running" })).toBeUndefined();
  });
});
