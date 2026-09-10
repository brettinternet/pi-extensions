import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import waitExtension, {
  WAIT_WIDGET_KEY,
  formatRemaining,
  formatWaitWidget,
  parseWaitCommand,
  parseWaitDuration,
} from "../../extensions/wait/index.ts";

function createHarness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const notifications: string[] = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const messages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  let idle = true;

  const context = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: (key: string, value: unknown) => widgets.push({ key, value }),
      notify: (message: string) => notifications.push(message),
    },
    isIdle: () => idle,
  } as unknown as ExtensionCommandContext;

  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (_name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = value;
    },
    sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      messages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  waitExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, context);

  return {
    command: command!,
    context,
    handlers,
    notifications,
    widgets,
    messages,
    setIdle: (value: boolean) => { idle = value; },
  };
}

function latestWidgetLines(harness: ReturnType<typeof createHarness>, width = 80): string[] | undefined {
  const value = [...harness.widgets].reverse().find(({ key }) => key === WAIT_WIDGET_KEY)?.value;
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== "function") return undefined;
  return (value({}, {}) as { render: (width: number) => string[] }).render(width);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("wait parser and formatting", () => {
  test("parses durations, scheduling, and controls", () => {
    expect(parseWaitDuration("500ms")).toBe(500);
    expect(parseWaitDuration("1.5m")).toBe(90_000);
    expect(parseWaitDuration("2h")).toBe(7_200_000);
    expect(parseWaitDuration("1d")).toBe(86_400_000);
    expect(parseWaitCommand("5m check the deployment")).toEqual({
      kind: "schedule",
      delay: 300_000,
      prompt: "check the deployment",
    });
    expect(parseWaitCommand("status")).toEqual({ kind: "status" });
    expect(parseWaitCommand("")).toEqual({ kind: "status" });
    expect(parseWaitCommand("cancel")).toEqual({ kind: "cancel" });
    expect(() => parseWaitDuration("5")).toThrow("duration");
    expect(() => parseWaitDuration("25d")).toThrow("24d");
    expect(() => parseWaitCommand("5m")).toThrow("prompt");
  });

  test("formats the countdown and truncates the queued prompt", () => {
    expect(formatRemaining(61_000)).toBe("1m 1s");
    expect(formatRemaining(3_600_000)).toBe("1h");
    const line = formatWaitWidget({ prompt: "check\nall deployment environments", dueAt: 62_000 }, 36, 1_000);
    expect(stripTerminalSequences(line)).toBe("wait 1m 1s · /wait cancel · check a…");
    expect(visibleWidth(line)).toBe(36);
  });

  test("completes controls and common durations", () => {
    const { command } = createHarness();
    expect(command.getArgumentCompletions?.("ca")).toEqual([
      { value: "cancel", label: "cancel", description: "Cancel the queued message" },
    ]);
    expect(command.getArgumentCompletions?.("5")).toEqual([
      { value: "5m ", label: "5m <prompt>", description: "Send a message after 5m" },
    ]);
  });
});

describe("wait lifecycle", () => {
  test("delivers when idle and clears the widget", async () => {
    const harness = createHarness();

    await harness.command.handler("5ms run the checks", harness.context);
    expect(latestWidgetLines(harness)?.[0]).toContain("/wait cancel");
    await sleep(15);

    expect(harness.messages).toEqual([{ content: "run the checks", options: undefined }]);
    expect(harness.widgets.at(-1)).toEqual({ key: WAIT_WIDGET_KEY, value: undefined });
  });

  test("uses follow-up delivery when busy", async () => {
    const harness = createHarness();
    harness.setIdle(false);

    await harness.command.handler("5ms inspect the result", harness.context);
    await sleep(15);

    expect(harness.messages).toEqual([
      { content: "inspect the result", options: { deliverAs: "followUp" } },
    ]);
  });

  test("cancels and replaces queued messages", async () => {
    const harness = createHarness();

    await harness.command.handler("10ms first", harness.context);
    await harness.command.handler("15ms second", harness.context);
    expect(harness.notifications.at(-1)).toContain("replaced queued message");
    await harness.command.handler("cancel", harness.context);
    await sleep(25);

    expect(harness.messages).toEqual([]);
    expect(harness.notifications.at(-1)).toBe("queued message cancelled");
  });

  test("cancels pending delivery on session shutdown", async () => {
    const harness = createHarness();

    await harness.command.handler("5ms should not send", harness.context);
    harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.context);
    await sleep(15);

    expect(harness.messages).toEqual([]);
  });
});
