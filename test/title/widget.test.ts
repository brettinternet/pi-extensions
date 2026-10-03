import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import titleExtension from "../../extensions/title/index.js";

const sessionModel = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };

let previousAgentDir: string | undefined;
let readOnlyDirs: string[] = [];

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  readOnlyDirs = [];
});

afterEach(() => {
  for (const dir of readOnlyDirs) chmodSync(dir, 0o755);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function configDir(config?: Record<string, unknown>): string {
  const dir = join("/tmp", `pi-title-widget-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  if (config) writeFileSync(join(dir, "pi-title.jsonc"), JSON.stringify(config), "utf8");
  return dir;
}

function configPath(dir: string): string {
  return join(dir, "pi-title.jsonc");
}

interface WidgetWrite {
  key: string;
  content: string[] | undefined;
  placement: string | undefined;
}

interface HarnessOptions {
  dir: string;
  name?: string;
  responses?: string[];
  /** Make every notification throw, as a replaced context does. */
  notifyThrows?: boolean;
}

function harness(options: HarnessOptions) {
  process.env.PI_CODING_AGENT_DIR = options.dir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const widgets: WidgetWrite[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const titles: string[] = [];
  const responses = [...(options.responses ?? [])];
  let name = options.name;
  let command: {
    handler: (args: string, ctx: unknown) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  } | undefined;

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (
      _name: string,
      options: {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      },
    ) => {
      command = options;
    },
    getSessionName: () => name,
    setSessionName: (title: string) => {
      name = title;
      titles.push(title);
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    model: sessionModel,
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      hasConfiguredAuth: () => true,
      streamSimple: () => {
        const next = responses.shift();
        if (!next) throw new Error("no queued response");
        return { result: async () => ({ content: [{ type: "text", text: next }], stopReason: "stop" }) };
      },
    },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Implement background titles" } },
        { type: "message", message: { role: "assistant", content: "Implemented it" } },
      ],
    },
    ui: {
      // The real theme returns styled text; returning it unchanged keeps assertions readable.
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (
        key: string,
        content: string[] | undefined,
        widgetOptions?: { placement?: string },
      ) => {
        widgets.push({ key, content, placement: widgetOptions?.placement });
      },
      setTitle: () => {},
      notify: (message: string, level = "info") => {
        if (options.notifyThrows) throw new Error("This extension ctx is stale after session replacement or reload.");
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;

  titleExtension(pi);

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  return {
    widgets,
    notifications,
    titles,
    flush,
    lastWrite: () => widgets.at(-1),
    lastContent: () => widgets.at(-1)?.content,
    configFile: () => readFileSync(configPath(options.dir), "utf8"),
    start: async () => {
      await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
      await flush();
    },
    renameExternally: (title: string) => {
      name = title;
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
    clearExternally: () => {
      name = undefined;
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: undefined }, ctx);
    },
    generate: async () => {
      handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "Implement background titles" }, ctx);
      await flush();
    },
    command: async (args: string) => {
      await command!.handler(args, ctx);
      await flush();
    },
    completionsFor: (prefix: string) => command!.getArgumentCompletions?.(prefix) ?? null,
  };
}

describe("title widget", () => {
  test("shows the current title once the session starts", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);
  });

  test("clears the widget when the session has no title", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);

    h.clearExternally();
    expect(h.lastContent()).toBeUndefined();
  });

  test("follows the title when it changes", async () => {
    const h = harness({ dir: configDir({ showWidget: true }) });
    await h.start();
    h.renameExternally("Renamed by the user");
    expect(h.lastContent()).toEqual(["● Title: Renamed by the user"]);
  });

  test("shows a title that was generated automatically", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), responses: ["Background Session Titles"] });
    await h.start();
    await h.generate();
    expect(h.titles).toEqual(["Background Session Titles"]);
    expect(h.lastContent()).toEqual(["● Title: Background Session Titles"]);
  });

  test("uses one widget slot below the editor", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    h.renameExternally("Another title");

    expect(h.widgets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.widgets.map((write) => write.key))).toEqual(new Set(["title"]));
    expect(h.widgets.every((write) => write.placement === "belowEditor")).toBe(true);
  });

  test("hides and shows the widget, persisting the choice", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);

    await h.command("hide");
    expect(h.lastContent()).toBeUndefined();
    // saveConfig rewrites the file through JSONC modify, so match without assuming spacing.
    expect(h.configFile()).toMatch(/"showWidget"\s*:\s*false/);
    expect(h.notifications.at(-1)?.message).toBe("Session title widget hidden");

    await h.command("show");
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);
    expect(h.configFile()).toMatch(/"showWidget"\s*:\s*true/);
    expect(h.notifications.at(-1)?.message).toBe("Session title widget shown");
  });

  test("a hidden widget stays hidden when the title changes", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    await h.command("hide");

    h.renameExternally("Renamed by the user");
    expect(h.lastContent()).toBeUndefined();
  });

  test("leaves the widget off by default without painting first", async () => {
    const h = harness({ dir: configDir(), name: "Existing title" });
    await h.start();

    // Off unless it is turned on, and the preference is read before the first paint, so
    // the widget is never drawn and then cleared.
    expect(h.widgets).toHaveLength(1);
    expect(h.lastContent()).toBeUndefined();

    await h.command("show");
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);
  });

  test("repaints the widget when a command reloads a changed preference", async () => {
    const dir = configDir({ showWidget: true });
    const h = harness({ dir, name: "Existing title" });
    await h.start();
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);

    // Changed outside the extension, then adopted by the next command.
    writeFileSync(configPath(dir), JSON.stringify({ showWidget: false }), "utf8");
    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("widget: disabled");
    expect(h.lastContent()).toBeUndefined();
  });

  test("keeps the widget when the preference could not be saved", async () => {
    const dir = configDir({ showWidget: true });
    const h = harness({ dir, name: "Existing title" });
    await h.start();

    // A read-only directory: the configuration still loads, but saving fails.
    chmodSync(dir, 0o555);
    readOnlyDirs.push(dir);

    await h.command("hide");
    expect(h.notifications.at(-1)?.level).toBe("error");
    expect(h.configFile()).toMatch(/"showWidget"\s*:\s*true/);
    expect(h.lastContent()).toEqual(["● Title: Existing title"]);

    // The failed preference is not adopted either.
    h.renameExternally("Renamed by the user");
    expect(h.lastContent()).toEqual(["● Title: Renamed by the user"]);
  });

  test("does not throw when the context is invalidated while hiding the widget", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title", notifyThrows: true });
    await h.start();

    await h.command("hide");
    expect(h.lastContent()).toBeUndefined();
    expect(h.configFile()).toMatch(/"showWidget"\s*:\s*false/);
  });

  test("treats show and hide as subcommands rather than titles", async () => {
    const h = harness({ dir: configDir({ showWidget: true }) });
    await h.start();

    await h.command("hide");
    await h.command("show");
    expect(h.titles).toEqual([]);

    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("title: none");
  });

  test("still allows a title that matches a subcommand name", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();

    await h.command("set show");
    expect(h.titles).toEqual(["show"]);
    expect(h.lastContent()).toEqual(["● Title: show"]);
  });

  test("reports the widget state in the status output", async () => {
    const h = harness({ dir: configDir({ showWidget: true }), name: "Existing title" });
    await h.start();
    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("widget: enabled");

    await h.command("hide");
    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("widget: disabled");
  });

  test("reports the widget as enabled when there is no title to show", async () => {
    // An enabled widget with nothing to show renders nothing, so status reports the
    // preference instead of claiming the widget is on screen.
    const h = harness({ dir: configDir({ showWidget: true }) });
    await h.start();
    expect(h.lastContent()).toBeUndefined();

    await h.command("status");
    expect(h.notifications.at(-1)?.message).toContain("widget: enabled");
    expect(h.notifications.at(-1)?.message).toContain("title: none");
  });

  test("completes show and hide", async () => {
    const h = harness({ dir: configDir({ showWidget: true }) });
    await h.start();
    const values = h.completionsFor("")!.map((entry) => entry.value);
    expect(values).toContain("show");
    expect(values).toContain("hide");
  });
});
