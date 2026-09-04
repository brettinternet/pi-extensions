import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import workbenchExtension from "../../extensions/workbench/index.ts";
import {
  BACKGROUND_ACTIVITY_CANCEL_EVENT,
  BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX,
  BACKGROUND_ACTIVITY_STARTED_EVENT,
  WORKBENCH_PROVIDER,
} from "../../extensions/workbench/protocol.ts";

describe("workbench extension", () => {
  test("registers jobs as scoped background activities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workbench-extension-"));
    await writeFile(join(root, "workbench.py"), "# test\n");
    const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
    const eventHandlers = new Map<string, (value: unknown) => void>();
    const emitted: Array<{ name: string; value: unknown }> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    let tool: ToolDefinition | undefined;

    const pi = {
      registerTool: (definition: ToolDefinition) => {
        tool = definition;
      },
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        lifecycle.set(name, handler);
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ customType, data });
      },
      events: {
        on: (name: string, handler: (value: unknown) => void) => {
          eventHandlers.set(name, handler);
          return () => eventHandlers.delete(name);
        },
        emit: (name: string, value: unknown) => emitted.push({ name, value }),
      },
      exec: async (command: string, args: string[]) => {
        if (command === "herdr") {
          return {
            code: 0,
            killed: false,
            stderr: "",
            stdout: JSON.stringify({ result: { plugins: [{ enabled: true, plugin_root: root }] } }),
          };
        }
        expect(args).toContain("HERDR_PLUGIN_ID=brettinternet.workbench");
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            action: "job.start",
            job: {
              jobId: "job-test",
              paneId: "pane-test",
              workspaceId: "workspace-test",
              status: "running",
            },
          }),
        };
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/repo",
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "session-test",
        getSessionFile: () => "/tmp/session.jsonl",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    workbenchExtension(pi);
    lifecycle.get("session_start")!({}, ctx);
    const result = await tool!.execute(
      "tool-call-test",
      {
        action: "job.start",
        command: ["bun", "test"],
        focus: false,
      } as never,
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(entries.some((entry) =>
      entry.customType === "pi-herdr-workbench-ownership" &&
      (entry.data as { resource?: string }).resource === "job"
    )).toBeTrue();
    expect(emitted).toContainEqual({
      name: BACKGROUND_ACTIVITY_STARTED_EVENT,
      value: {
        version: 1,
        provider: WORKBENCH_PROVIDER,
        activityId: "job-test",
        kind: "job",
        sessionId: "session-test",
        sessionFile: "/tmp/session.jsonl",
        workspaceId: "workspace-test",
        originId: "tool-call-test",
        label: "bun test",
        cancellable: true,
      },
    });

    eventHandlers.get(BACKGROUND_ACTIVITY_CANCEL_EVENT)!({
      version: 1,
      requestId: "cancel-test",
      provider: WORKBENCH_PROVIDER,
      activityId: "job-test",
      sessionId: "session-test",
      workspaceId: "workspace-test",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toContainEqual({
      name: `${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}cancel-test`,
      value: { version: 1, requestId: "cancel-test", success: true },
    });

    lifecycle.get("session_shutdown")!();
  });
});
