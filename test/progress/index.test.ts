import { describe, expect, test } from "bun:test";
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
import progressExtension from "../../extensions/progress/index.ts";

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
  const notifications: string[] = [];
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
    appendEntry: () => {},
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
  } as unknown as ExtensionContext;
  progressExtension(pi);
  return { handlers, widgets, command: command!, notifications, ctx };
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
    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress · ● thinking"]);

    handlers.get("tool_execution_start")!(
      {
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "/repo/src/a.ts" },
      },
      ctx,
    );
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress · ● edit src/a.ts"]);
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
      "progress · ✓ settled",
      "touched src/a.ts",
    ]);
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
    expect(latestLines(widgets)).toEqual(["progress · ✓ settled"]);

    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress · ● thinking"]);
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
      "progress · ● thinking · ✗ bun test",
    ]);

    handlers.get("before_agent_start")!({}, ctx);
    await flushRender();
    expect(latestLines(widgets)).toEqual(["progress · ● thinking"]);
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
    expect(widgets.at(-1)).toMatchObject({
      key: "pi-progress",
      content: undefined,
    });
  });
});
