import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import loopExtension, {
  LOOP_STATE_ENTRY,
  formatLoopStatus,
  formatLoopWidget,
  parseLoopCommand,
  readLoopState,
  type LoopState,
} from "../../extensions/loop/index.ts";

type TestEntry = { type: "custom"; customType: string; data: unknown };

type Manager = {
  id: string;
  file: string;
  entries: TestEntry[];
  getSessionId: () => string;
  getSessionFile: () => string;
  getBranch: () => TestEntry[];
  appendCustomEntry: (customType: string, data: unknown) => void;
};

type Harness = ReturnType<typeof createHarness>;

function manager(id: string, file: string, entries: TestEntry[] = []): Manager {
  const value: Manager = {
    id,
    file,
    entries,
    getSessionId: () => value.id,
    getSessionFile: () => value.file,
    getBranch: () => value.entries,
    appendCustomEntry: (customType, data) => value.entries.push({ type: "custom", customType, data }),
  };
  return value;
}

function stateOf(value: Manager): LoopState | undefined {
  return readLoopState(value.entries);
}

function createHarness(options: { cancelReplacement?: boolean } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const notifications: string[] = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const prompts: string[] = [];
  const parents: Array<string | undefined> = [];
  let current = manager("session-0", "/tmp/session-0.jsonl", [
    { type: "custom", customType: "unrelated", data: { keep: true } },
  ]);
  let replacementNumber = 0;
  let activeContext: ExtensionCommandContext;

  const ui = {
    setWidget: (key: string, value: unknown) => widgets.push({ key, value }),
    notify: (message: string) => notifications.push(message),
    setEditorText: () => {},
  };

  const contextFor = (value: Manager): ExtensionCommandContext => ({
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: value,
    modelRegistry: {},
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: "/repo" }),
    sendUserMessage: async (content: string) => prompts.push(content),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext);

  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (_name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = value;
    },
    appendEntry: (customType: string, data: unknown) => current.entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content: string, opts?: { expandPromptTemplates?: boolean }) => {
      if (opts?.expandPromptTemplates && content.startsWith("/loop ")) {
        const [, ...args] = content.slice(1).split(" ");
        void command?.handler(args.join(" "), activeContext);
      } else {
        prompts.push(content);
      }
    },
  } as unknown as ExtensionAPI;

  const originalNewSession = async (opts?: {
    parentSession?: string;
    setup?: (sessionManager: Manager) => Promise<void>;
    withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
  }) => {
    parents.push(opts?.parentSession);
    if (options.cancelReplacement) return { cancelled: true };
    const next = manager(`session-${++replacementNumber}`, `/tmp/session-${replacementNumber}.jsonl`);
    const nextContext = contextFor(next);
    (nextContext as any).newSession = originalNewSession;
    current = next;
    activeContext = nextContext;
    handlers.get("session_start")?.({ reason: "new" }, nextContext);
    await opts?.setup?.(next);
    await opts?.withSession?.(nextContext);
    return { cancelled: false };
  };

  loopExtension(pi);
  const initialContext = contextFor(current);
  activeContext = initialContext;
  (initialContext as any).newSession = originalNewSession;

  return {
    handlers,
    command: command!,
    context: initialContext,
    get current() {
      return current;
    },
    notifications,
    widgets,
    prompts,
    parents,
    settle: async () => {
      handlers.get("agent_settled")?.({}, activeContext);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    agentStart: () => handlers.get("before_agent_start")?.({ prompt: prompts.at(-1) ?? "" }, activeContext),
    agentEnd: (stopReason: "stop" | "error" | "aborted") =>
      handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason }] }, activeContext),
    commandContext: () => activeContext,
    state: () => stateOf(current),
  };
}

// The harness above cannot override the method created as an object literal in
// a type-safe way, so use a small adapter that installs the new-session method
// before command execution.
function commandContext(harness: Harness): ExtensionCommandContext {
  return harness.commandContext();
}

function latestWidgetLines(harness: Harness, width = 80): string[] | undefined {
  const value = harness.widgets.at(-1)?.value;
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== "function") return undefined;
  return (value({}, {}) as { render: (width: number) => string[] }).render(width);
}

describe("loop parser and state", () => {
  test("parses starts, retunes, controls, and rejects ambiguous input", () => {
    expect(parseLoopCommand("3 fix the failing tests")).toEqual({
      kind: "start",
      count: 3,
      prompt: "fix the failing tests",
    });
    expect(parseLoopCommand("4")).toEqual({ kind: "retune", count: 4 });
    expect(parseLoopCommand("+2")).toEqual({ kind: "adjust", delta: 2 });
    expect(parseLoopCommand("-1")).toEqual({ kind: "adjust", delta: -1 });
    expect(parseLoopCommand("status")).toEqual({ kind: "status" });
    expect(parseLoopCommand("")).toEqual({ kind: "stop" });
    expect(() => parseLoopCommand("0 prompt")).toThrow("positive integer");
    expect(() => parseLoopCommand("+0")).toThrow("positive integer");
    expect(() => parseLoopCommand("-2 prompt")).toThrow("adjustment");
    expect(() => parseLoopCommand("2.5 prompt")).toThrow("positive integer");
    expect(() => parseLoopCommand("status now")).toThrow("does not accept");
  });

  test("completes public controls and common iteration counts", () => {
    const { command } = createHarness();
    expect(command.getArgumentCompletions?.("st")).toEqual([
      { value: "status", label: "status", description: "Show the current loop state" },
      { value: "stop", label: "stop", description: "Stop gracefully" },
    ]);
    expect(command.getArgumentCompletions?.("3")).toEqual([
      { value: "3 ", label: "3 <prompt>", description: "Run a prompt three times" },
    ]);
    expect(command.getArgumentCompletions?.("+")).toEqual([
      { value: "+1", label: "+1", description: "Add one future iteration" },
    ]);
    expect(command.getArgumentCompletions?.("__")).toBeNull();
  });

  test("formats persisted status without exposing the prompt", () => {
    const state: LoopState = {
      version: 1,
      runId: "run-1",
      prompt: "secret prompt",
      currentIteration: 2,
      remainingBudget: 3,
      pendingRetune: 5,
      status: "paused",
    };
    expect(formatLoopStatus(state)).toContain("loop: paused");
    expect(formatLoopStatus(state)).toContain("pending retune: 5");
    expect(formatLoopStatus(state)).not.toContain("secret prompt");
  });

  test("formats a one-line countdown and truncates the prompt to the available width", () => {
    const state: LoopState = {
      version: 1,
      runId: "run-1",
      prompt: "inspect the repository\nand fix the failing tests",
      currentIteration: 1,
      remainingBudget: 3,
      pendingRetune: null,
      status: "active",
    };
    expect(formatLoopWidget(state, 80)).toBe(
      "loop active 4/4 · inspect the repository and fix the failing tests",
    );
    const narrow = formatLoopWidget(state, 32);
    expect(stripTerminalSequences(narrow)).toBe("loop active 4/4 · inspect the r…");
    expect(visibleWidth(narrow)).toBe(32);
  });
});

describe("loop lifecycle", () => {
  test("starts the first counted iteration in a fresh session", async () => {
    const harness = createHarness();
    await harness.command.handler("2 inspect the repository", harness.context);
    expect(harness.current.getSessionId()).toBe("session-1");
    expect(harness.parents).toEqual(["/tmp/session-0.jsonl"]);
    expect(harness.prompts).toEqual(["inspect the repository"]);
    expect(harness.current.entries.every((entry) => entry.customType === LOOP_STATE_ENTRY)).toBeTrue();
    expect(stateOf(harness.current)).toMatchObject({ currentIteration: 1, remainingBudget: 1, status: "active" });
    expect(latestWidgetLines(harness)).toEqual(["loop active 2/2 · inspect the repository"]);
  });

  test("continues exactly once at the settled boundary", async () => {
    const harness = createHarness();
    await harness.command.handler("2 do the work", harness.context);
    harness.agentStart();
    await harness.settle();
    expect(harness.prompts).toEqual(["do the work", "do the work"]);
    expect(harness.current.getSessionId()).toBe("session-2");
    expect(harness.state()).toMatchObject({ currentIteration: 2, remainingBudget: 0, status: "active" });
    await harness.settle();
    await harness.settle();
    expect(harness.prompts).toHaveLength(2);
    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 2 });
  });

  test("ignores duplicate and stale settlement callbacks", async () => {
    const harness = createHarness();
    await harness.command.handler("2 do the work", harness.context);
    const oldContext = harness.context;
    const settled = harness.handlers.get("agent_settled")!;
    settled({}, harness.commandContext());
    settled({}, harness.commandContext());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompts).toHaveLength(2);
    settled({}, oldContext);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompts).toHaveLength(2);
  });

  test("retunes only future iterations at the next boundary", async () => {
    const harness = createHarness();
    await harness.command.handler("2 repeat the check", harness.context);
    await harness.command.handler("4", commandContext(harness));
    expect(harness.state()).toMatchObject({ remainingBudget: 1, pendingRetune: 4 });
    expect(latestWidgetLines(harness)).toEqual(["loop active 5/5 · repeat the check"]);
    await harness.settle();
    expect(harness.state()).toMatchObject({ currentIteration: 2, remainingBudget: 3, pendingRetune: null });
    expect(latestWidgetLines(harness)).toEqual(["loop active 4/5 · repeat the check"]);
  });

  test("adds and subtracts future iterations while active", async () => {
    const harness = createHarness();
    await harness.command.handler("3 repeat the check", harness.context);
    await harness.command.handler("+2", commandContext(harness));
    expect(harness.state()?.pendingRetune).toBe(4);
    expect(latestWidgetLines(harness)).toEqual(["loop active 5/5 · repeat the check"]);

    await harness.command.handler("-4", commandContext(harness));
    expect(harness.state()?.pendingRetune).toBe(0);
    await harness.command.handler("-1", commandContext(harness));
    expect(harness.state()?.pendingRetune).toBe(0);
    expect(harness.notifications.at(-1)).toContain("cannot subtract more");

    await harness.settle();
    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 1 });
  });

  test("stops gracefully and stops paused runs immediately", async () => {
    const harness = createHarness();
    await harness.command.handler("2 work", harness.context);
    await harness.command.handler("stop", commandContext(harness));
    expect(harness.state()?.status).toBe("stopping");
    await harness.settle();
    expect(harness.state()?.status).toBe("stopped");

    const paused = createHarness();
    await paused.command.handler("2 work", paused.context);
    paused.agentEnd("error");
    expect(paused.state()?.status).toBe("paused");
    await paused.command.handler("stop", commandContext(paused));
    expect(paused.state()?.status).toBe("stopped");
  });

  test("pauses on terminal errors and resume retries in a fresh session", async () => {
    const harness = createHarness();
    await harness.command.handler("2 retry this", harness.context);
    harness.agentEnd("aborted");
    expect(harness.state()).toMatchObject({ status: "paused", currentIteration: 1, remainingBudget: 1 });
    await harness.settle();
    expect(harness.prompts).toHaveLength(1);
    await harness.command.handler("resume", commandContext(harness));
    expect(harness.prompts).toHaveLength(2);
    expect(harness.current.getSessionId()).toBe("session-2");
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 1, remainingBudget: 1 });
  });

  test("cancellation leaves a paused owner and cannot start a stale continuation", async () => {
    const harness = createHarness({ cancelReplacement: true });
    await harness.command.handler("2 work", harness.context);
    expect(harness.current.getSessionId()).toBe("session-0");
    expect(harness.state()?.status).toBe("paused");
    await harness.settle();
    expect(harness.prompts).toHaveLength(0);
  });

  test("marks the old owner inactive when transferring state", async () => {
    const harness = createHarness();
    const old = harness.current;
    await harness.command.handler("2 work", harness.context);
    expect(stateOf(old)?.status).toBe("inactive");
    expect(stateOf(harness.current)?.ownerSessionId).toBe("session-1");
    expect(stateOf(harness.current)?.ownerSessionId).not.toBe(old.id);
  });
});
