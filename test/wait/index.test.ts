import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
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
  let autocomplete: AutocompleteProvider | undefined;
  const notifications: string[] = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const messages: Array<{
    content: string;
    options?: {
      deliverAs?: "steer" | "followUp";
      expandPromptTemplates?: boolean;
    };
  }> = [];
  let idle = true;

  const context = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: (key: string, value: unknown) => widgets.push({ key, value }),
      notify: (message: string) => notifications.push(message),
      addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
        autocomplete = factory({
          getSuggestions: async () => null,
          applyCompletion: () => { throw new Error("not used"); },
        });
      },
    },
    isIdle: () => idle,
  } as unknown as ExtensionContext;

  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    sendUserMessage: (
      content: string,
      options?: {
        deliverAs?: "steer" | "followUp";
        expandPromptTemplates?: boolean;
      },
    ) => {
      messages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  waitExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, context);

  return {
    get autocomplete() { return autocomplete!; },
    context,
    handlers,
    notifications,
    widgets,
    messages,
    submit: (args: string, streamingBehavior?: "steer" | "followUp") => handlers.get("input")?.({
      text: `/wait${args ? ` ${args}` : ""}`,
      source: "interactive",
      streamingBehavior,
    }, context),
    settle: () => handlers.get("agent_settled")?.({}, context),
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

  test("completes the command, controls, and common durations", async () => {
    const { autocomplete } = createHarness();
    const options = { signal: new AbortController().signal } as any;
    expect(await autocomplete.getSuggestions(["/wa"], 0, 3, options)).toEqual({
      prefix: "/wa",
      items: [{
        value: "/wait ",
        label: "/wait",
        description: "Send a queued message after a timeout",
      }],
    });
    expect(await autocomplete.getSuggestions(["/wait ca"], 0, 8, options)).toEqual({
      prefix: "ca",
      items: [{ value: "cancel", label: "cancel", description: "Cancel the queued message" }],
    });
    expect(await autocomplete.getSuggestions(["/wait 5"], 0, 7, options)).toEqual({
      prefix: "5",
      items: [{ value: "5m ", label: "5m <prompt>", description: "Send a message after 5m" }],
    });
  });
});

describe("wait lifecycle", () => {
  test("delivers when idle and clears the widget", async () => {
    const harness = createHarness();

    await harness.submit("5ms run the checks");
    expect(latestWidgetLines(harness)?.[0]).toContain("/wait cancel");
    await sleep(15);

    expect(harness.messages).toEqual([{
      content: "run the checks",
      options: { expandPromptTemplates: true },
    }]);
    expect(harness.widgets.at(-1)).toEqual({ key: WAIT_WIDGET_KEY, value: undefined });
  });

  test("starts an Enter-steered timer immediately while busy", async () => {
    const harness = createHarness();
    harness.setIdle(false);

    await harness.submit("5ms inspect the result", "steer");
    await sleep(15);

    expect(harness.messages).toEqual([
      {
        content: "inspect the result",
        options: { deliverAs: "followUp", expandPromptTemplates: true },
      },
    ]);
  });

  test("does not start a queued follow-up timer until the agent settles", async () => {
    const harness = createHarness();
    harness.setIdle(false);

    await harness.submit("10ms inspect after settling", "followUp");
    expect(latestWidgetLines(harness)?.[0]).toContain("wait queued");
    await sleep(15);
    expect(harness.messages).toEqual([]);

    harness.setIdle(true);
    harness.settle();
    await sleep(15);

    expect(harness.messages).toEqual([{
      content: "inspect after settling",
      options: { expandPromptTemplates: true },
    }]);
  });

  test("dispatches a queued slash command with skill arguments", async () => {
    const harness = createHarness();

    await harness.submit("5ms /skill:myskill skill argument here");
    await sleep(15);

    expect(harness.messages).toEqual([{
      content: "/skill:myskill skill argument here",
      options: { expandPromptTemplates: true },
    }]);
  });

  test("cancels and replaces queued messages", async () => {
    const harness = createHarness();

    await harness.submit("10ms first");
    await harness.submit("15ms second");
    expect(harness.notifications.at(-1)).toContain("replaced queued message");
    await harness.submit("cancel");
    await sleep(25);

    expect(harness.messages).toEqual([]);
    expect(harness.notifications.at(-1)).toBe("queued message cancelled");
  });

  test("cancels pending delivery on session shutdown", async () => {
    const harness = createHarness();

    await harness.submit("5ms should not send");
    harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.context);
    await sleep(15);

    expect(harness.messages).toEqual([]);
  });
});
