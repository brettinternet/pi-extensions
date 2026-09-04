import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  CONFIRMATION_ACKNOWLEDGED_PREFIX,
  CONFIRMATION_REQUESTED_EVENT,
  CONFIRMATION_RESOLVED_PREFIX,
  type ConfirmationRequest,
} from "../../extensions/workbench/confirmation.ts";
import workbenchExtension from "../../extensions/workbench/index.ts";

async function createHarness(options: {
  command: string[];
  voiceDecision?: "approved" | "denied";
  tuiDecision?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-risk-"));
  await writeFile(join(root, "workbench.py"), "# test\n");
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
  let tool: ToolDefinition | undefined;
  let executions = 0;
  const events = {
    on(name: string, handler: (value: unknown) => void) {
      const values = handlers.get(name) ?? new Set();
      values.add(handler);
      handlers.set(name, values);
      return () => values.delete(handler);
    },
    emit(name: string, value: unknown) {
      for (const handler of handlers.get(name) ?? []) handler(value);
    },
  };
  const pi = {
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    on: (name: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(name, handler),
    appendEntry: () => {},
    events,
    exec: async (executable: string) => {
      if (executable === "herdr") return {
        code: 0, killed: false, stderr: "",
        stdout: JSON.stringify({ result: { plugins: [{ enabled: true, plugin_root: root }] } }),
      };
      executions += 1;
      return {
        code: 0, killed: false, stderr: "",
        stdout: JSON.stringify({
          ok: true,
          action: "job.start",
          job: { jobId: "job-risk", paneId: "pane-risk", workspaceId: "workspace-risk", status: "running" },
        }),
      };
    },
  } as unknown as ExtensionAPI;
  const mode = options.tuiDecision === undefined ? "print" : "tui";
  const ctx = {
    cwd: "/repo",
    mode,
    hasUI: mode === "tui",
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "session-risk",
      getSessionFile: () => "/session-risk.jsonl",
      getBranch: () => [],
    },
    ui: { confirm: async () => options.tuiDecision ?? false, notify: () => {} },
  } as unknown as ExtensionContext;
  if (options.voiceDecision) {
    events.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      const reply = {
        version: 1,
        requestId: request.requestId,
        sessionId: request.sessionId,
        sessionFile: request.sessionFile,
        provider: request.provider,
        operationId: request.operationId,
      };
      events.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply);
      setImmediate(() => events.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, {
        ...reply,
        decision: options.voiceDecision,
      }));
    });
  }
  workbenchExtension(pi);
  lifecycle.get("session_start")!({}, ctx);
  const execute = () => tool!.execute(
    "tool-risk",
    { action: "job.start", command: options.command, focus: false } as never,
    new AbortController().signal,
    undefined,
    ctx,
  );
  return { execute, executions: () => executions, shutdown: () => lifecycle.get("session_shutdown")!() };
}

describe("workbench execution boundary", () => {
  test("starts visible tests and read-only Git without confirmation", async () => {
    for (const command of [["bun", "test"], ["git", "status"]]) {
      const harness = await createHarness({ command });
      await harness.execute();
      expect(harness.executions()).toBe(1);
      harness.shutdown();
    }
  });

  test("voice approval executes exactly once", async () => {
    const harness = await createHarness({ command: ["git", "push"], voiceDecision: "approved" });
    await harness.execute();
    expect(harness.executions()).toBe(1);
    harness.shutdown();
  });

  test("voice rejection never crosses the execution boundary", async () => {
    const harness = await createHarness({ command: ["git", "push"], voiceDecision: "denied" });
    await expect(harness.execute()).rejects.toThrow("denied");
    expect(harness.executions()).toBe(0);
    harness.shutdown();
  });

  test("TUI approval executes a risky command when live is inactive", async () => {
    const harness = await createHarness({ command: ["rm", "-rf", "dist"], tuiDecision: true });
    await harness.execute();
    expect(harness.executions()).toBe(1);
    harness.shutdown();
  });
});
