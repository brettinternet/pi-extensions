import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { loadConfig } from "../../extensions/progress/config.ts";
import progressExtension, { RUNTIME_ENTRY } from "../../extensions/progress/index.ts";

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

function setup() {
  const handlers = new Map<string, Handler>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] | undefined;
  const notifications: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const widgets: Array<{
    key: string;
    content: WidgetFactory | undefined;
    options?: { placement?: string };
  }> = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = options;
    },
    registerShortcut: (_key: string, options: Parameters<ExtensionAPI["registerShortcut"]>[1]) => {
      shortcut = options;
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      setWidget: (
        key: string,
        content: WidgetFactory | undefined,
        options?: { placement?: string },
      ) => widgets.push({ key, content, options }),
      notify: (message: string) => notifications.push(message),
    },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getAvailable: () => [] },
  } as unknown as ExtensionContext;
  progressExtension(pi);
  return { handlers, widgets, command: command!, shortcut: shortcut!, notifications, entries, ctx };
}

async function flushRender(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
}

function latestLines(
  widgets: ReturnType<typeof setup>["widgets"],
  width = 120,
): string[] {
  const widget = widgets.at(-1);
  if (!widget?.content) return [];
  return widget.content({} as TUI, theme).render(width);
}

describe("progress extension", () => {
  test("renders observed activity below the editor without context hooks", async () => {
    const { handlers, widgets, ctx } = setup();
    expect(handlers.has("context")).toBeFalse();

    handlers.get("session_start")!({}, ctx);
    expect(latestLines(widgets)).toEqual([]);

    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress <1m · ● thinking"]);

    handlers.get("tool_execution_start")!(
      {
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "/repo/src/a.ts" },
      },
      ctx,
    );
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress <1m · ● edit src/a.ts"]);
    expect(widgets.at(-1)?.options).toEqual({ placement: "belowEditor" });

    handlers.get("tool_result")!(
      {
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: "/repo/src/a.ts" },
        isError: false,
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual([
      "progress <1m · ✓ settled",
      "touched src/a.ts",
    ]);
  });

  test("tracks activity when Pi supplies a fresh context for each event", async () => {
    const { handlers, widgets, ctx } = setup();

    handlers.get("session_start")!({}, { ...ctx });
    handlers.get("before_agent_start")!({}, { ...ctx });
    handlers.get("tool_execution_start")!(
      {
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "/repo/src/a.ts" },
      },
      { ...ctx },
    );
    await flushRender();

    expect(latestLines(widgets)).toEqual(["progress <1m · ● edit src/a.ts"]);
  });

  test("starts counting runtime at the first prompt", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000);
    const { handlers, widgets, ctx } = setup();
    try {
      handlers.get("session_start")!({}, ctx);
      now.mockReturnValue(3_601_000);
      expect(latestLines(widgets)).toEqual([]);

      handlers.get("before_agent_start")!({ prompt: "Start" }, ctx);
      await flushRender();
      expect(latestLines(widgets)).toEqual(["progress <1m · ● thinking"]);
    } finally {
      handlers.get("session_shutdown")!({}, ctx);
      now.mockRestore();
    }
  });

  test("accumulates active work while excluding idle and UI prompt time", async () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    const { handlers, widgets, entries, ctx } = setup();
    try {
      handlers.get("session_start")!({}, ctx);
      handlers.get("before_agent_start")!({ prompt: "First" }, ctx);
      now.mockReturnValue(30_000);
      handlers.get("ui_prompt_start")!({}, ctx);
      now.mockReturnValue(90_000);
      handlers.get("ui_prompt_end")!({}, ctx);
      now.mockReturnValue(120_000);
      handlers.get("agent_settled")!({}, ctx);
      await flushRender();

      expect(latestLines(widgets)).toEqual(["progress 1m · ✓ settled"]);
      expect(entries).toContainEqual({ type: RUNTIME_ENTRY, data: { activeMs: 60_000 } });

      now.mockReturnValue(420_000);
      expect(latestLines(widgets)).toEqual(["progress 1m · ✓ settled"]);

      handlers.get("before_agent_start")!({ prompt: "Second" }, ctx);
      now.mockReturnValue(480_000);
      await flushRender();
      expect(latestLines(widgets)).toEqual(["progress 2m · ● thinking"]);
    } finally {
      handlers.get("session_shutdown")!({}, ctx);
      now.mockRestore();
    }
  });

  test("restores accumulated active work from session metadata", () => {
    const { handlers, widgets, ctx } = setup();
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: RUNTIME_ENTRY,
      data: { activeMs: 90 * 60_000 },
    }] as any;

    handlers.get("session_start")!({}, ctx);
    expect(latestLines(widgets)).toEqual(["progress 1h"]);
    handlers.get("session_shutdown")!({}, ctx);
  });

  test("keeps a read-only result until the next request starts", async () => {
    const { handlers, widgets, ctx } = setup();
    handlers.get("session_start")!({}, ctx);
    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("tool_execution_start")!(
      {
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "/repo/src/a.ts" },
      },
      ctx,
    );
    handlers.get("tool_result")!(
      {
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "/repo/src/a.ts" },
        isError: false,
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress <1m · ✓ settled"]);

    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress <1m · ● thinking"]);
  });

  test("shows check outcomes and clears state for the next request", async () => {
    const { handlers, widgets, ctx } = setup();
    handlers.get("session_start")!({}, ctx);
    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("tool_execution_start")!(
      {
        toolCallId: "check-1",
        toolName: "bash",
        args: { command: "bun test" },
      },
      ctx,
    );
    handlers.get("tool_result")!(
      {
        toolCallId: "check-1",
        toolName: "bash",
        input: { command: "bun test" },
        isError: true,
      },
      ctx,
    );
    await flushRender();
    expect(latestLines(widgets)).toEqual([
      "progress <1m · ● thinking · ✗ bun test",
    ]);

    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress <1m · ● thinking"]);
  });

  test("completes steps, status, model, and disabling inference", () => {
    const { command } = setup();
    expect(command.getArgumentCompletions?.("ste")).toEqual([
      { value: "steps", label: "steps", description: "Show inferred progress history" },
    ]);
    expect(command.getArgumentCompletions?.("sta")).toEqual([
      { value: "status", label: "status", description: "Show inference status and configuration" },
    ]);
    expect(command.getArgumentCompletions?.("model of")).toEqual([
      { value: "model off", label: "off", description: "Disable progress inference" },
    ]);
  });

  test("shows progress history from the command and shortcut without a TUI", async () => {
    const { command, shortcut, notifications, ctx } = setup();
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "pi-progress-inference-v1",
      data: {
        phase: "Implementation",
        current: "Updated progress history",
        completed: ["Added the overlay"],
        blocked: [],
        confidence: 0.9,
      },
    }] as any;

    await command.handler("steps", ctx as unknown as ExtensionCommandContext);
    await shortcut.handler(ctx);

    expect(notifications).toEqual([
      "1. Implementation · Updated progress history\n  ✓ Added the overlay",
      "1. Implementation · Updated progress history\n  ✓ Added the overlay",
    ]);
  });

  test("toggles full-width progress history above the TUI editor", async () => {
    const { command, widgets, ctx } = setup();
    (ctx as { mode?: string }).mode = "tui";
    ctx.sessionManager.getBranch = () => [{
      type: "custom",
      customType: "pi-progress-inference-v1",
      data: {
        phase: "Implementation",
        current: "Moved progress history",
        completed: ["Used an above-editor widget"],
        blocked: [],
        confidence: 0.9,
      },
    }] as any;

    await command.handler("steps", ctx as unknown as ExtensionCommandContext);
    expect(widgets.at(-1)?.options).toEqual({ placement: "aboveEditor" });
    expect(latestLines(widgets)).toEqual([
      "Progress history",
      "1. Implementation · Moved progress history",
      "✓ Used an above-editor widget",
      "alt+g or /progress steps to close",
    ]);

    await command.handler("steps", ctx as unknown as ExtensionCommandContext);
    expect(widgets.at(-1)).toMatchObject({
      key: "pi-progress-history",
      content: undefined,
    });
  });

  test("sets, shows, and disables the inference model", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const directory = await mkdtemp(join(tmpdir(), "pi-progress-command-"));
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      const { command, notifications, ctx } = setup();
      const commandContext = ctx as unknown as ExtensionCommandContext;
      await command.handler("model openai/gpt-5-nano:minimal", commandContext);
      expect(await loadConfig(join(directory, "pi-progress.jsonc"))).toEqual({
        model: "openai/gpt-5-nano:minimal",
        maxInputChars: 12_000,
        maxTokens: 180,
        timeoutMs: 15_000,
      });

      await command.handler("model", commandContext);
      await command.handler("model off", commandContext);
      expect(notifications).toEqual([
        "Progress model: openai/gpt-5-nano:minimal",
        "Progress model: openai/gpt-5-nano:minimal",
        "Progress model: off",
      ]);
      expect((await loadConfig(join(directory, "pi-progress.jsonc"))).model).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("removes its widget when the session shuts down", () => {
    const { handlers, widgets, ctx } = setup();
    handlers.get("session_start")!({}, ctx);
    handlers.get("session_shutdown")!({}, ctx);
    expect(widgets.slice(-2)).toEqual([
      { key: "pi-progress", content: undefined, options: undefined },
      { key: "pi-progress-history", content: undefined, options: undefined },
    ]);
  });
});
