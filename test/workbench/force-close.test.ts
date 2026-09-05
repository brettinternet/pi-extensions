import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import workbenchExtension from "../../extensions/workbench/index.ts";
import {
  CONFIRMATION_ACKNOWLEDGED_PREFIX,
  CONFIRMATION_REQUESTED_EVENT,
  CONFIRMATION_RESOLVED_PREFIX,
  type ConfirmationRequest,
} from "../../extensions/workbench/confirmation.ts";

type CloseAction = "editor.close" | "job.close";
type VoiceDecision = "approved" | "denied" | "wrong-session" | "expired";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

async function createHarness(options: {
  action: CloseAction;
  force?: boolean;
  owned?: boolean;
  dirty?: boolean;
  jobStatus?: "running" | "completed" | "failed" | "cancelled";
  voiceDecision?: VoiceDecision;
  beforeResolution?: (request: ConfirmationRequest) => void;
  replaceEditorBeforeResolution?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-force-close-"));
  await writeFile(join(root, "workbench.py"), "# test\n");
  const bus = new EventBus();
  const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[][] = [];
  const order: string[] = [];
  const requests: ConfirmationRequest[] = [];
  let tool: ToolDefinition | undefined;
  const owned = options.owned ?? true;
  let currentEditorPaneId = owned ? "pane-owned" : "pane-foreign";
  const resource = options.action === "editor.close" ? "editor" : "job";
  const resourceId = options.action === "editor.close" ? "pane-owned" : "job-owned";
  const branch = owned
    ? [{
      type: "custom",
      customType: "pi-herdr-workbench-ownership",
      data: {
        version: 1,
        operation: "add",
        resource,
        id: resourceId,
        workspaceId: "workspace-owned",
      },
    }]
    : [];

  const reply = (request: ConfirmationRequest) => ({
    version: 1,
    requestId: request.requestId,
    sessionId: request.sessionId,
    sessionFile: request.sessionFile,
    provider: request.provider,
    operationId: request.operationId,
  });

  const voiceHandler = (value: unknown): void => {
    const request = value as ConfirmationRequest;
    requests.push(request);
    order.push("confirmation.requested");
    if (!options.voiceDecision) return;
    bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
    options.beforeResolution?.(request);
    if (options.replaceEditorBeforeResolution) currentEditorPaneId = "pane-replacement";
    if (options.voiceDecision === "wrong-session") {
      setImmediate(() => bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, {
        ...reply(request),
        sessionId: "other-session",
        decision: "approved",
      }));
      return;
    }
    setImmediate(() => {
      const resolution = {
        ...reply(request),
        decision: options.voiceDecision === "expired" ? "approved" : options.voiceDecision,
      };
      bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, resolution);
      if (options.voiceDecision === "approved") {
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, resolution);
      }
    });
  };
  bus.on(CONFIRMATION_REQUESTED_EVENT, voiceHandler);

  const pi = {
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    on: (name: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(name, handler),
    appendEntry: () => {},
    events: bus,
    exec: async (command: string, args: string[]) => {
      if (command === "herdr") return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify({ result: { plugins: [{ enabled: true, plugin_root: root }] } }),
      };
      const controllerArgs = args.slice(3);
      calls.push(controllerArgs);
      const action = controllerArgs.join(" ");
      if (action === "editor status") {
        order.push("editor.status");
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            action: "editor.status",
            editor: {
              paneId: currentEditorPaneId,
              workspaceId: "workspace-owned",
              dirtyBuffers: options.dirty ? [{ name: "modified.txt" }] : [],
            },
          }),
        };
      }
      if (controllerArgs[0] === "job" && controllerArgs[1] === "status") {
        order.push("job.status");
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            action: "job.status",
            job: { jobId: "job-owned", status: options.jobStatus ?? "running" },
          }),
        };
      }
      if (controllerArgs[0] === "editor" && controllerArgs[1] === "close") {
        order.push("editor.close");
        const expectedPaneIndex = controllerArgs.indexOf("--expected-pane-id");
        const expectedPaneId = expectedPaneIndex === -1 ? undefined : controllerArgs[expectedPaneIndex + 1];
        if (expectedPaneId !== undefined && expectedPaneId !== currentEditorPaneId) {
          return {
            code: 1,
            killed: false,
            stdout: "",
            stderr: JSON.stringify({
              ok: false,
              error: { message: "managed editor pane changed before close" },
            }),
          };
        }
        if (options.dirty && !controllerArgs.includes("--force")) {
          return {
            code: 1,
            killed: false,
            stdout: "",
            stderr: JSON.stringify({ ok: false, error: { message: "editor has unsaved changes" } }),
          };
        }
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({ ok: true, action: "editor.close", paneId: "pane-owned" }),
        };
      }
      if (controllerArgs[0] === "job" && controllerArgs[1] === "close") {
        order.push("job.close");
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({ ok: true, action: "job.close", jobId: "job-owned" }),
        };
      }
      throw new Error(`unexpected controller action: ${action}`);
    },
  } as unknown as ExtensionAPI;
  const mode = options.voiceDecision ? "print" : "print";
  const ctx = {
    cwd: "/repo",
    mode,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "session-owned",
      getSessionFile: () => "/session-owned.jsonl",
      getBranch: () => branch,
    },
    ui: { confirm: async () => false, notify: () => {} },
  } as unknown as ExtensionContext;

  workbenchExtension(pi);
  lifecycle.get("session_start")!({}, ctx);
  const execute = (signal = new AbortController().signal) => tool!.execute(
    "force-close-test",
    {
      action: options.action,
      force: options.force,
      ...(options.action === "job.close" ? { jobId: "job-owned" } : {}),
    } as never,
    signal,
    undefined,
    ctx,
  );
  return {
    execute,
    calls,
    order,
    requests,
    closeCalls: () => calls.filter((args) =>
      (args[0] === "editor" && args[1] === "close") ||
      (args[0] === "job" && args[1] === "close")
    ),
    shutdown: () => lifecycle.get("session_shutdown")!(),
  };
}

describe("workbench force close boundary", () => {
  test("confirms an owned editor pane and executes once after approval", async () => {
    const harness = await createHarness({
      action: "editor.close",
      force: true,
      dirty: true,
      voiceDecision: "approved",
    });
    await harness.execute();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.title).toContain("pane-owned");
    expect(harness.requests[0]!.summary).toContain("pane-owned");
    expect(harness.requests[0]!.summary.toLowerCase()).toContain("discard");
    expect(harness.closeCalls()).toHaveLength(1);
    expect(harness.closeCalls()[0]).toEqual([
      "editor",
      "close",
      "--expected-pane-id",
      "pane-owned",
      "--force",
    ]);
    harness.shutdown();
  });

  test("confirms an owned job and executes once after approval", async () => {
    const harness = await createHarness({
      action: "job.close",
      force: true,
      voiceDecision: "approved",
    });
    await harness.execute();
    expect(harness.requests[0]!.title).toContain("job-owned");
    expect(harness.requests[0]!.summary).toContain("job-owned");
    expect(harness.requests[0]!.summary.toLowerCase()).toContain("running process");
    expect(harness.requests[0]!.summary.toLowerCase()).toContain("discard");
    expect(harness.closeCalls()).toEqual([["job", "close", "job-owned", "--force"]]);
    harness.shutdown();
  });

  test("downgrades unnecessary force for clean and completed owned panes", async () => {
    const editor = await createHarness({ action: "editor.close", force: true });
    await editor.execute();
    expect(editor.requests).toHaveLength(0);
    expect(editor.closeCalls()).toEqual([[
      "editor",
      "close",
      "--expected-pane-id",
      "pane-owned",
    ]]);
    editor.shutdown();

    const job = await createHarness({
      action: "job.close",
      force: true,
      jobStatus: "completed",
    });
    await job.execute();
    expect(job.requests).toHaveLength(0);
    expect(job.closeCalls()).toEqual([["job", "close", "job-owned"]]);
    job.shutdown();
  });

  test("checks ownership before requesting force-close confirmation", async () => {
    const editor = await createHarness({ action: "editor.close", force: true, owned: false, voiceDecision: "approved" });
    await expect(editor.execute()).rejects.toThrow("not owned");
    expect(editor.requests).toHaveLength(0);
    expect(editor.closeCalls()).toHaveLength(0);
    editor.shutdown();

    const job = await createHarness({ action: "job.close", force: true, owned: false, voiceDecision: "approved" });
    await expect(job.execute()).rejects.toThrow("not owned");
    expect(job.requests).toHaveLength(0);
    expect(job.closeCalls()).toHaveLength(0);
    job.shutdown();
  });

  test("orders editor ownership lookup, confirmation, and execution", async () => {
    const harness = await createHarness({
      action: "editor.close",
      force: true,
      dirty: true,
      voiceDecision: "approved",
    });
    await harness.execute();
    expect(harness.order).toEqual(["editor.status", "confirmation.requested", "editor.close"]);
    harness.shutdown();
  });

  test("refuses to close a replacement editor after approval", async () => {
    const harness = await createHarness({
      action: "editor.close",
      force: true,
      dirty: true,
      voiceDecision: "approved",
      replaceEditorBeforeResolution: true,
    });
    await expect(harness.execute()).rejects.toThrow("managed editor pane changed before close");
    expect(harness.closeCalls()).toEqual([[
      "editor",
      "close",
      "--expected-pane-id",
      "pane-owned",
      "--force",
    ]]);
    harness.shutdown();
  });

  test("rejection and unavailable confirmation never execute force close", async () => {
    const rejected = await createHarness({ action: "job.close", force: true, voiceDecision: "denied" });
    await expect(rejected.execute()).rejects.toThrow("denied");
    expect(rejected.closeCalls()).toHaveLength(0);
    rejected.shutdown();

    const unavailable = await createHarness({ action: "job.close", force: true });
    await expect(unavailable.execute()).rejects.toThrow("unavailable");
    expect(unavailable.closeCalls()).toHaveLength(0);
    unavailable.shutdown();
  });

  test("wrong-session confirmation never executes force close", async () => {
    const harness = await createHarness({ action: "job.close", force: true, voiceDecision: "wrong-session" });
    const controller = new AbortController();
    const execution = harness.execute(controller.signal);
    setTimeout(() => controller.abort(new Error("wrong-session test timeout")), 10);
    await expect(execution).rejects.toThrow("wrong-session test timeout");
    expect(harness.closeCalls()).toHaveLength(0);
    harness.shutdown();
  });

  test("expired confirmation never executes force close", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Object.defineProperty(Date, "now", { configurable: true, value: () => now });
    try {
      const harness = await createHarness({
        action: "job.close",
        force: true,
        voiceDecision: "expired",
        beforeResolution: (request) => { now = request.expiresAt; },
      });
      await expect(harness.execute()).rejects.toThrow("expired");
      expect(harness.closeCalls()).toHaveLength(0);
      harness.shutdown();
    } finally {
      Object.defineProperty(Date, "now", { configurable: true, value: originalNow });
    }
  });

  test("normal dirty close preserves the plugin refusal without confirmation", async () => {
    const harness = await createHarness({ action: "editor.close", force: false, dirty: true });
    await expect(harness.execute()).rejects.toThrow("editor has unsaved changes");
    expect(harness.requests).toHaveLength(0);
    expect(harness.closeCalls()).toEqual([[
      "editor",
      "close",
      "--expected-pane-id",
      "pane-owned",
    ]]);
    harness.shutdown();
  });
});
