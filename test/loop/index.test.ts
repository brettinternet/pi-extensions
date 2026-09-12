import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import loopExtension, {
  DEFAULT_LOOP_RETRIES,
  LOOP_STATE_ENTRY,
  formatLoopStatus,
  formatLoopWidget,
  parseLoopCommand,
  parseLoopDuration,
  parseLoopTimeframe,
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

function createHarness(options: {
  cancelReplacement?: boolean;
  beforeWithSession?: (manager: Manager, replacementNumber: number) => void;
} = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const notifications: string[] = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const prompts: string[] = [];
  const promptOptions: Array<{ expandPromptTemplates?: boolean } | undefined> = [];
  const parents: Array<string | undefined> = [];
  const herdrEvents: unknown[] = [];
  let current = manager("session-0", "/tmp/session-0.jsonl", [
    { type: "custom", customType: "unrelated", data: { keep: true } },
  ]);
  let replacementNumber = 0;
  let idle = true;
  let abortCount = 0;
  let widgetRenderRequests = 0;
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
    isIdle: () => idle,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => { abortCount += 1; },
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: "/repo" }),
    sendUserMessage: async (
      content: string,
      options?: { expandPromptTemplates?: boolean },
    ) => {
      if (options?.expandPromptTemplates && content.startsWith("/loop ")) {
        await command?.handler(content.slice("/loop ".length), activeContext);
        return;
      }
      prompts.push(content);
      promptOptions.push(options);
    },
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext);

  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    events: {
      emit: (name: string, value: unknown) => {
        if (name === "herdr:blocked") herdrEvents.push(value);
      },
    },
    registerCommand: (_name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = value;
    },
    registerTool: (value: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      tool = value;
    },
    appendEntry: (customType: string, data: unknown) => current.entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content: string, opts?: { expandPromptTemplates?: boolean }) => {
      if (opts?.expandPromptTemplates && content.startsWith("/loop ")) {
        const [, ...args] = content.slice(1).split(" ");
        void command?.handler(args.join(" "), activeContext);
      } else {
        prompts.push(content);
        promptOptions.push(opts);
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
    options.beforeWithSession?.(next, replacementNumber);
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
    tool: tool!,
    context: initialContext,
    get current() {
      return current;
    },
    notifications,
    widgets,
    prompts,
    promptOptions,
    parents,
    herdrEvents,
    get abortCount() {
      return abortCount;
    },
    get widgetRenderRequests() {
      return widgetRenderRequests;
    },
    requestWidgetRender: () => { widgetRenderRequests += 1; },
    settle: async () => {
      handlers.get("agent_settled")?.({}, activeContext);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    agentStart: () => handlers.get("before_agent_start")?.({
      prompt: prompts.at(-1) ?? "",
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    }, activeContext),
    setIdle: (value: boolean) => { idle = value; },
    messageEnd: (stopReason: "stop" | "error" | "aborted", errorMessage?: string) =>
      handlers.get("message_end")?.({ message: { role: "assistant", stopReason, errorMessage } }, activeContext),
    agentEnd: (stopReason: "stop" | "error" | "aborted", errorMessage?: string) =>
      handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason, errorMessage }] }, activeContext),
    sessionStart: async (reason: "startup" | "reload" | "resume") => {
      handlers.get("session_start")?.({ reason }, activeContext);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    sessionShutdown: (reason: "quit" | "reload") => {
      handlers.get("session_shutdown")?.({ reason }, activeContext);
    },
    setState: (patch: Partial<LoopState>) => {
      const state = stateOf(current);
      if (!state) throw new Error("loop state is unavailable");
      current.appendCustomEntry(LOOP_STATE_ENTRY, { ...state, ...patch });
    },
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
  return (value({ requestRender: harness.requestWidgetRender }, {}) as { render: (width: number) => string[] }).render(width);
}

describe("loop parser and state", () => {
  test("parses starts, retunes, controls, and rejects ambiguous input", () => {
    expect(parseLoopCommand("3 fix the failing tests")).toEqual({
      kind: "start",
      count: 3,
      delay: 0,
      prompt: "fix the failing tests",
    });
    expect(parseLoopCommand("3 --delay 2s fix the failing tests")).toEqual({
      kind: "start",
      count: 3,
      delay: 2_000,
      prompt: "fix the failing tests",
    });
    expect(parseLoopCommand("for 4h --delay 5m watch the queue")).toEqual({
      kind: "startTimed",
      duration: 4 * 60 * 60 * 1_000,
      delay: 5 * 60 * 1_000,
      prompt: "watch the queue",
    });
    expect(parseLoopCommand("delay 1m")).toEqual({ kind: "delay", delay: 60_000 });
    expect(parseLoopCommand("delay off")).toEqual({ kind: "delay", delay: 0 });
    expect(parseLoopDuration("1000ms")).toBe(1_000);
    expect(parseLoopDuration("1.5s")).toBe(1_500);
    expect(parseLoopTimeframe("2d")).toBe(2 * 24 * 60 * 60 * 1_000);
    expect(parseLoopCommand("4")).toEqual({ kind: "retune", count: 4 });
    expect(parseLoopCommand("+2")).toEqual({ kind: "adjust", delta: 2 });
    expect(parseLoopCommand("-1")).toEqual({ kind: "adjust", delta: -1 });
    expect(parseLoopCommand("prompt focus on tests")).toEqual({
      kind: "replacePrompt",
      prompt: "focus on tests",
    });
    expect(parseLoopCommand("append preserve the public API")).toEqual({
      kind: "appendPrompt",
      prompt: "preserve the public API",
    });
    expect(parseLoopCommand("status")).toEqual({ kind: "status" });
    expect(parseLoopCommand("next")).toEqual({ kind: "next" });
    expect(parseLoopCommand("end")).toEqual({ kind: "end" });
    expect(parseLoopCommand("")).toEqual({ kind: "end" });
    expect(() => parseLoopCommand("stop")).toThrow("expected a positive count or a loop command");
    expect(() => parseLoopCommand("0 prompt")).toThrow("positive integer");
    expect(() => parseLoopCommand("+0")).toThrow("positive integer");
    expect(() => parseLoopCommand("-2 prompt")).toThrow("adjustment");
    expect(() => parseLoopCommand("2.5 prompt")).toThrow("positive integer");
    expect(() => parseLoopCommand("status now")).toThrow("does not accept");
    expect(() => parseLoopCommand("next now")).toThrow("does not accept");
    expect(() => parseLoopCommand("prompt")).toThrow("requires text");
    expect(() => parseLoopCommand("append")).toThrow("requires text");
    expect(() => parseLoopCommand("delay")).toThrow("requires one duration");
    expect(() => parseLoopCommand("delay 999ms")).toThrow("at least 1s");
    expect(() => parseLoopCommand("delay 25h")).toThrow("24h");
    expect(() => parseLoopCommand("3 --delay nope fix")).toThrow("duration");
    expect(() => parseLoopCommand("3 --delay 1s")).toThrow("prompt");
    expect(() => parseLoopCommand("for 4h watch the queue")).toThrow("timed loops require");
    expect(() => parseLoopCommand("for 4h --delay off watch the queue")).toThrow("non-zero");
    expect(() => parseLoopCommand("for 31d --delay 1h watch the queue")).toThrow("30d");
  });

  test("completes public controls and common iteration counts", () => {
    const { command } = createHarness();
    expect(command.getArgumentCompletions?.("st")).toEqual([
      { value: "status", label: "status", description: "Show the current loop state" },
    ]);
    expect(command.getArgumentCompletions?.("")).toContainEqual(
      { value: "end", label: "end", description: "End the loop gracefully" },
    );
    expect(command.getArgumentCompletions?.("3")).toEqual([
      { value: "3 ", label: "3 <prompt>", description: "Run a prompt three times" },
    ]);
    expect(command.getArgumentCompletions?.("+")).toEqual([
      { value: "+1", label: "+1", description: "Add one future iteration" },
    ]);
    expect(command.getArgumentCompletions?.("ap")).toEqual([
      { value: "append ", label: "append <text>", description: "Append to the future loop prompt" },
    ]);
    expect(command.getArgumentCompletions?.("ne")).toEqual([
      { value: "next", label: "next", description: "Skip a paused iteration and start the next one" },
    ]);
    expect(command.getArgumentCompletions?.("delay ")).toContainEqual({
      value: "delay off",
      label: "delay off",
      description: "Set the delay between settled iterations",
    });
    expect(command.getArgumentCompletions?.("3 --delay ")).toContainEqual({
      value: "3 --delay 1s",
      label: "3 --delay 1s",
      description: "Set the delay between settled iterations",
    });
    expect(command.getArgumentCompletions?.("fo")).toContainEqual({
      value: "for ",
      label: "for <duration> --delay <duration> <prompt>",
      description: "Run until a wall-clock deadline",
    });
    expect(command.getArgumentCompletions?.("for 4h ")).toEqual([{
      value: "for 4h --delay ",
      label: "for 4h --delay <duration> <prompt>",
      description: "Run until 4h elapses",
    }]);
    expect(command.getArgumentCompletions?.("for 4h --delay ")).toContainEqual({
      value: "for 4h --delay 5m",
      label: "for 4h --delay 5m",
      description: "Set the delay between settled iterations",
    });
    expect(command.getArgumentCompletions?.("for 4h --delay ")).not.toContainEqual(
      expect.objectContaining({ value: "for 4h --delay off" }),
    );
    expect(command.getArgumentCompletions?.("for 4h --delay=")).toContainEqual({
      value: "for 4h --delay=5m",
      label: "for 4h --delay=5m",
      description: "Set the delay between settled iterations",
    });
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
      delay: 2_000,
      status: "paused",
    };
    expect(formatLoopStatus(state)).toContain("loop: paused");
    expect(formatLoopStatus(state)).toContain("pending retune: 5");
    expect(formatLoopStatus(state)).toContain("delay: 2s");
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
      delay: 0,
      status: "active",
    };
    expect(formatLoopWidget(state, 80)).toBe(
      "loop active 4/4 · inspect the repository and fix the failing tests",
    );
    const narrow = formatLoopWidget(state, 32);
    expect(stripTerminalSequences(narrow)).toBe("loop active 4/4 · inspect the r…");
    expect(visibleWidth(narrow)).toBe(32);

    expect(formatLoopWidget({ ...state, status: "stopping" }, 80)).toBe(
      "loop stopping · inspect the repository and fix the failing tests",
    );
    expect(formatLoopWidget({ ...state, delay: 2_000 }, 80)).toBe(
      "loop active 4/4 · delay 2s · inspect the repository and fix the failing tests",
    );
    expect(formatLoopWidget({ ...state, retryCount: 2 }, 80)).toBe(
      "loop active 4/4 · retry 2/3 · inspect the repository and fix the failing tests",
    );
  });

  test("defaults delay to zero when loading an older persisted state", () => {
    expect(readLoopState([{
      type: "custom",
      customType: LOOP_STATE_ENTRY,
      data: {
        version: 1,
        runId: "run-older",
        prompt: "old prompt",
        currentIteration: 1,
        remainingBudget: 0,
        pendingRetune: null,
        status: "completed",
      },
    }])).toMatchObject({ delay: 0, retryCount: 0, phase: "running" });
  });
});

describe("loop lifecycle", () => {
  test("starts the first counted iteration in a fresh session", async () => {
    const harness = createHarness();
    await harness.command.handler("2 inspect the repository", harness.context);
    expect(harness.current.getSessionId()).toBe("session-1");
    expect(harness.parents).toEqual(["/tmp/session-0.jsonl"]);
    expect(harness.prompts).toEqual(["inspect the repository"]);
    expect(harness.promptOptions).toEqual([{ expandPromptTemplates: true }]);
    expect(harness.current.entries.every((entry) => entry.customType === LOOP_STATE_ENTRY)).toBeTrue();
    expect(stateOf(harness.current)).toMatchObject({ currentIteration: 1, remainingBudget: 1, status: "active" });
    expect(latestWidgetLines(harness)).toEqual(["loop active 2/2 · inspect the repository"]);
  });

  test("runs timed loops until their persisted deadline", async () => {
    const harness = createHarness();
    await harness.command.handler("for 4h --delay 5m watch the queue", harness.context);

    expect(harness.state()).toMatchObject({
      currentIteration: 1,
      remainingBudget: 0,
      delay: 5 * 60 * 1_000,
      status: "active",
    });
    expect(harness.state()?.endsAt).toBeGreaterThan(Date.now() + 3 * 60 * 60 * 1_000);
    expect(formatLoopStatus(harness.state())).toContain("ends at:");
    expect(formatLoopWidget(harness.state()!, 100, harness.state()!.endsAt! - 4 * 60 * 60 * 1_000)).toBe(
      "loop active · 4h left · delay 5m · watch the queue",
    );

    const first = harness.state()!;
    await harness.command.handler(`__continue ${first.runId} 1`, harness.commandContext());
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 2, remainingBudget: 0 });

    harness.setState({ endsAt: Date.now() - 1 });
    await harness.settle();
    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 2 });
    expect(harness.prompts).toEqual(["watch the queue", "watch the queue"]);
  });

  test("does not dispatch an iteration whose deadline expires during session replacement", async () => {
    const harness = createHarness({
      beforeWithSession: (replacement) => {
        const entry = replacement.entries.at(-1);
        if (entry?.customType === LOOP_STATE_ENTRY) {
          (entry.data as LoopState).endsAt = Date.now() - 1;
        }
      },
    });

    await harness.command.handler("for 1s --delay 1s watch the queue", harness.context);

    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 1 });
    expect(harness.prompts).toEqual([]);
  });

  test("makes active loop sessions aware of semantic pause without cache-varying iteration data", async () => {
    const harness = createHarness();
    await harness.command.handler("2 perform unattended work", harness.context);

    const promptResult = harness.agentStart() as { systemPrompt?: string };
    expect(promptResult.systemPrompt).toContain("active unattended loop");
    expect(promptResult.systemPrompt).toContain("loop_pause");
    expect(promptResult.systemPrompt).not.toContain("iteration 1");

    const result = await (harness.tool.execute as any)(
      "tool-1",
      { reason: "deployment credentials are required" },
      undefined,
      undefined,
      harness.commandContext(),
    );
    expect(result.terminate).toBeTrue();
    expect(harness.tool.executionMode).toBe("sequential");
    expect(harness.abortCount).toBe(1);
    expect(harness.state()).toMatchObject({
      status: "paused",
      pauseReason: "deployment credentials are required",
      currentIteration: 1,
      remainingBudget: 1,
    });
    expect(harness.herdrEvents).toEqual([{
      active: true,
      label: "Loop paused: deployment credentials are required",
      scope: "root",
    }]);
    await harness.settle();
    expect(harness.prompts).toEqual(["perform unattended work"]);
  });

  test("completes an expired timed loop instead of resuming blocked work", async () => {
    const harness = createHarness();
    await harness.command.handler("for 4h --delay 5m watch the queue", harness.context);
    await (harness.tool.execute as any)(
      "tool-1",
      { reason: "human approval is required" },
      undefined,
      undefined,
      harness.commandContext(),
    );
    harness.setState({ endsAt: Date.now() - 1 });

    await harness.command.handler("resume", harness.commandContext());

    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 1 });
    expect(harness.prompts).toEqual(["watch the queue"]);
    expect(harness.herdrEvents.at(-1)).toEqual({ active: false, scope: "root" });
  });

  test("dispatches a nested slash command on every iteration", async () => {
    const harness = createHarness();
    await harness.command.handler("2 /wait 10m /skill:myskill skill argument here", harness.context);

    expect(harness.prompts).toEqual(["/wait 10m /skill:myskill skill argument here"]);
    expect(harness.promptOptions).toEqual([{ expandPromptTemplates: true }]);

    await harness.settle();
    expect(harness.prompts).toEqual([
      "/wait 10m /skill:myskill skill argument here",
      "/wait 10m /skill:myskill skill argument here",
    ]);
    expect(harness.promptOptions).toEqual([
      { expandPromptTemplates: true },
      { expandPromptTemplates: true },
    ]);
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

  test("waits after settlement, then applies updates made during the wait", async () => {
    const harness = createHarness();
    await harness.command.handler("2 --delay 2s original prompt", harness.context);
    await harness.settle();
    expect(harness.prompts).toEqual(["original prompt"]);

    await harness.command.handler("prompt updated prompt", commandContext(harness));
    await harness.command.handler("delay 1s", commandContext(harness));
    expect(harness.state()).toMatchObject({ delay: 1_000, currentIteration: 1, status: "active" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.prompts).toHaveLength(1);

    await harness.command.handler("delay off", commandContext(harness));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompts).toEqual(["original prompt", "updated prompt"]);
  });

  test("stops immediately during a delay and does not wait after a pending stop", async () => {
    const waiting = createHarness();
    await waiting.command.handler("2 --delay 1s work", waiting.context);
    await waiting.settle();
    await waiting.command.handler("end", commandContext(waiting));
    expect(waiting.state()?.status).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(waiting.prompts).toHaveLength(1);

    const stopping = createHarness();
    await stopping.command.handler("2 --delay 1s work", stopping.context);
    await stopping.command.handler("end", commandContext(stopping));
    await stopping.command.handler("delay 2s", commandContext(stopping));
    expect(stopping.state()).toMatchObject({ status: "stopping", delay: 2_000 });
    await stopping.settle();
    expect(stopping.state()?.status).toBe("stopped");
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

  test("replaces and cumulatively appends to future iteration prompts", async () => {
    const harness = createHarness();
    await harness.command.handler("3 broad review", harness.context);
    expect(latestWidgetLines(harness)).toEqual(["loop active 3/3 · broad review"]);
    const mountedWidgetCount = harness.widgets.length;

    await harness.command.handler("prompt fix the failing tests", commandContext(harness));
    expect(harness.widgets).toHaveLength(mountedWidgetCount);
    expect(harness.widgetRenderRequests).toBe(1);
    expect(latestWidgetLines(harness)).toEqual(["loop active 3/3 · fix the failing tests"]);
    await harness.command.handler("append preserve public APIs", commandContext(harness));
    await harness.command.handler("append update relevant docs", commandContext(harness));

    expect(harness.prompts).toEqual(["broad review"]);
    expect(harness.state()).toMatchObject({
      prompt: "fix the failing tests\n\npreserve public APIs\n\nupdate relevant docs",
      remainingBudget: 2,
      pendingRetune: null,
      status: "active",
    });
    expect(harness.notifications.at(-1)).toBe("future loop prompt extended; active iteration unchanged");

    await harness.settle();
    expect(harness.prompts).toEqual([
      "broad review",
      "fix the failing tests\n\npreserve public APIs\n\nupdate relevant docs",
    ]);
    expect(harness.state()).toMatchObject({ currentIteration: 2, remainingBudget: 1 });
  });

  test("advances a paused iteration with next into a fresh session", async () => {
    const harness = createHarness();
    await harness.command.handler("3 retry this", harness.context);
    harness.setState({ retryCount: DEFAULT_LOOP_RETRIES });
    harness.agentEnd("error");
    await harness.settle();
    expect(harness.state()).toMatchObject({ status: "paused", currentIteration: 1, remainingBudget: 2 });

    const pausedSession = harness.current.getSessionId();
    await harness.command.handler("next", commandContext(harness));

    expect(harness.current.getSessionId()).not.toBe(pausedSession);
    expect(harness.prompts).toEqual(["retry this", "retry this"]);
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 2, remainingBudget: 1 });
  });

  test("completes a paused final iteration with next without creating a session", async () => {
    const harness = createHarness();
    await harness.command.handler("1 finish this", harness.context);
    harness.setState({ retryCount: DEFAULT_LOOP_RETRIES });
    harness.agentEnd("error");
    await harness.settle();
    const pausedSession = harness.current.getSessionId();

    await harness.command.handler("next", commandContext(harness));

    expect(harness.current.getSessionId()).toBe(pausedSession);
    expect(harness.prompts).toEqual(["finish this"]);
    expect(harness.state()).toMatchObject({ status: "completed", currentIteration: 1, remainingBudget: 0 });
  });

  test("rejects next unless the loop is paused", async () => {
    const harness = createHarness();
    await harness.command.handler("2 keep working", harness.context);
    const session = harness.current.getSessionId();

    await harness.command.handler("next", commandContext(harness));

    expect(harness.current.getSessionId()).toBe(session);
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 1, remainingBudget: 1 });
    expect(harness.notifications.at(-1)).toBe("loop is active; /loop next is only available while paused");
  });

  test("updates the prompt while paused and uses it on resume", async () => {
    const harness = createHarness();
    await harness.command.handler("2 retry this", harness.context);
    harness.setState({ retryCount: DEFAULT_LOOP_RETRIES });
    harness.agentEnd("error");
    await harness.settle();

    await harness.command.handler("prompt use the new approach", commandContext(harness));
    expect(harness.state()).toMatchObject({
      prompt: "use the new approach",
      status: "paused",
      currentIteration: 1,
      remainingBudget: 1,
    });
    expect(harness.notifications.at(-1)).toBe("loop prompt replaced; resume will use it");

    const pausedSession = harness.current.getSessionId();
    await harness.command.handler("resume", commandContext(harness));
    expect(harness.current.getSessionId()).toBe(pausedSession);
    expect(harness.prompts).toEqual([
      "retry this",
      "Continue the current loop iteration from where you left off without repeating completed work.\n\nCurrent loop instructions:\nuse the new approach",
    ]);
  });

  test("continues an iteration in the same session when a mid-run edit interrupts it", async () => {
    const harness = createHarness();
    await harness.command.handler("2 inspect the repository", harness.context);
    const activeSession = harness.current.getSessionId();

    harness.setIdle(false);
    await harness.command.handler("append preserve completed work", commandContext(harness));
    harness.messageEnd("aborted");
    harness.agentEnd("aborted");
    harness.setIdle(true);
    await harness.settle();

    expect(harness.current.getSessionId()).toBe(activeSession);
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 1, remainingBudget: 1 });
    expect(harness.prompts.at(-1)).toBe(
      "Continue the current loop iteration from where you left off without repeating completed work.\n\nCurrent loop instructions:\ninspect the repository\n\npreserve completed work",
    );

    await harness.settle();
    expect(harness.current.getSessionId()).not.toBe(activeSession);
    expect(harness.prompts.at(-1)).toBe("inspect the repository\n\npreserve completed work");
    expect(harness.state()).toMatchObject({ status: "active", currentIteration: 2, remainingBudget: 0 });
  });

  test("still pauses a genuine abort after an uninterrupted mid-run command", async () => {
    const harness = createHarness();
    await harness.command.handler("2 work", harness.context);
    harness.setIdle(false);
    await harness.command.handler("status", commandContext(harness));
    harness.setIdle(true);
    await harness.settle();

    harness.agentEnd("aborted");
    await harness.settle();
    expect(harness.state()).toMatchObject({ status: "paused", currentIteration: 2, remainingBudget: 0 });
  });

  test("prompt updates preserve stopping state and reject terminal runs", async () => {
    const harness = createHarness();
    await harness.command.handler("2 work", harness.context);
    await harness.command.handler("end", commandContext(harness));
    await harness.command.handler("append if resumed, focus on tests", commandContext(harness));

    expect(harness.state()).toMatchObject({
      prompt: "work\n\nif resumed, focus on tests",
      status: "stopping",
      remainingBudget: 1,
    });
    expect(harness.notifications.at(-1)).toBe("loop prompt extended; loop is still stopping");

    await harness.settle();
    expect(harness.state()?.status).toBe("stopped");
    await harness.command.handler("prompt cannot apply", commandContext(harness));
    expect(harness.state()?.prompt).toBe("work\n\nif resumed, focus on tests");
    expect(harness.notifications.at(-1)).toContain("must be active, stopping, or paused");
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
    await harness.command.handler("end", commandContext(harness));
    expect(harness.state()?.status).toBe("stopping");
    expect(latestWidgetLines(harness)).toEqual(["loop stopping · work"]);
    await harness.settle();
    expect(harness.state()?.status).toBe("stopped");

    const paused = createHarness();
    await paused.command.handler("2 work", paused.context);
    paused.setState({ retryCount: DEFAULT_LOOP_RETRIES });
    paused.agentEnd("error");
    await paused.settle();
    expect(paused.state()?.status).toBe("paused");
    await paused.command.handler("end", commandContext(paused));
    expect(paused.state()?.status).toBe("stopped");
  });

  test("can resume or retune while a graceful stop is pending", async () => {
    const resumed = createHarness();
    await resumed.command.handler("2 work", resumed.context);
    await resumed.command.handler("end", commandContext(resumed));
    await resumed.command.handler("resume", commandContext(resumed));
    expect(resumed.state()).toMatchObject({ status: "active", pendingRetune: null });
    expect(resumed.prompts).toHaveLength(1);
    await resumed.settle();
    expect(resumed.state()).toMatchObject({ status: "active", currentIteration: 2 });

    const retuned = createHarness();
    await retuned.command.handler("2 work", retuned.context);
    await retuned.command.handler("end", commandContext(retuned));
    await retuned.command.handler("3", commandContext(retuned));
    expect(retuned.state()).toMatchObject({ status: "active", pendingRetune: 3 });
    expect(latestWidgetLines(retuned)).toEqual(["loop active 4/4 · work"]);
    await retuned.settle();
    expect(retuned.state()).toMatchObject({ status: "active", currentIteration: 2, remainingBudget: 2 });
  });

  test("retries settled provider errors with bounded exponential backoff", async () => {
    const harness = createHarness();
    await harness.command.handler("2 retry this", harness.context);

    harness.agentEnd("error", "WebSocket error");
    await harness.settle();

    expect(harness.state()).toMatchObject({
      status: "active",
      currentIteration: 1,
      retryCount: 1,
    });
    expect(harness.notifications.at(-1)).toContain(
      "retrying iteration 1 in 30s after WebSocket error (1/3)",
    );
    expect(formatLoopStatus(harness.state())).toContain("retries: 1/3");

    await harness.command.handler("end", commandContext(harness));
    expect(harness.state()?.status).toBe("stopped");
  });

  test("pauses with diagnostics after retries are exhausted", async () => {
    const harness = createHarness();
    await harness.command.handler("2 retry this", harness.context);
    harness.setState({ retryCount: DEFAULT_LOOP_RETRIES });

    harness.agentEnd("error", "servers overloaded");
    await harness.settle();

    expect(harness.state()).toMatchObject({
      status: "paused",
      retryCount: DEFAULT_LOOP_RETRIES,
      pauseReason: "servers overloaded",
    });
    expect(harness.state()?.pausedAt).toBeNumber();
    expect(formatLoopStatus(harness.state())).toContain("pause reason: servers overloaded");
  });

  test("recovers persisted active iterations after startup and reload", async () => {
    const startup = createHarness();
    await startup.command.handler("2 keep working", startup.context);
    await startup.sessionStart("startup");
    expect(startup.prompts.at(-1)).toContain(
      "Continue the current loop iteration from where you left off",
    );
    expect(startup.notifications.at(-2)).toBe("loop recovering interrupted iteration 1");

    const reload = createHarness();
    await reload.command.handler("2 keep working", reload.context);
    reload.sessionShutdown("reload");
    expect(reload.state()?.status).toBe("active");
    await reload.sessionStart("reload");
    expect(reload.prompts.at(-1)).toContain(
      "Continue the current loop iteration from where you left off",
    );
  });

  test("restores pending boundary and retry timers without repeating completed work", async () => {
    const boundary = createHarness();
    await boundary.command.handler("2 --delay 1s next task", boundary.context);
    await boundary.settle();
    boundary.setState({ phase: "waiting", nextActionAt: Date.now() - 1, settledAt: undefined });

    await boundary.sessionStart("startup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(boundary.prompts).toEqual(["next task", "next task"]);
    expect(boundary.state()).toMatchObject({ currentIteration: 2, phase: "running" });

    const retry = createHarness();
    await retry.command.handler("2 retry task", retry.context);
    retry.setState({ retryCount: 2, phase: "retrying", nextActionAt: Date.now() - 1 });

    await retry.sessionStart("startup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retry.prompts.at(-1)).toContain(
      "Continue the current loop iteration from where you left off",
    );
    expect(retry.state()).toMatchObject({ currentIteration: 1, retryCount: 2, phase: "running" });
  });

  test("updates a restored boundary deadline before recovery dispatches", async () => {
    const harness = createHarness();
    await harness.command.handler("2 --delay 1s keep working", harness.context);
    await harness.settle();
    const settledAt = Date.now() - 2_000;
    const originalDeadline = Date.now() + 10_000;
    harness.setState({ phase: "waiting", settledAt, nextActionAt: originalDeadline });

    const startup = harness.sessionStart("startup");
    await harness.command.handler("delay 2s", commandContext(harness));
    expect(harness.state()?.nextActionAt).toBe(settledAt + 2_000);
    await harness.command.handler("end", commandContext(harness));
    await startup;
  });

  test("end cancels startup recovery before it can dispatch", async () => {
    const harness = createHarness();
    await harness.command.handler("2 keep working", harness.context);

    const startup = harness.sessionStart("startup");
    await harness.command.handler("end", commandContext(harness));
    await startup;

    expect(harness.state()?.status).toBe("stopped");
    expect(harness.prompts).toEqual(["keep working"]);
  });

  test("does not recover a loop after an intentional process exit", async () => {
    const harness = createHarness();
    await harness.command.handler("2 keep working", harness.context);
    harness.sessionShutdown("quit");
    expect(harness.state()?.status).toBe("inactive");

    await harness.sessionStart("startup");
    expect(harness.prompts).toEqual(["keep working"]);
  });

  test("does not pause failures recovered before the agent settles", async () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const harness = createHarness();
      await harness.command.handler("2 retry this", harness.context);

      harness.agentEnd(stopReason);
      expect(harness.state()).toMatchObject({ status: "active", currentIteration: 1 });

      harness.messageEnd("stop");
      harness.agentEnd("stop");
      await harness.settle();

      expect(harness.prompts).toEqual(["retry this", "retry this"]);
      expect(harness.state()).toMatchObject({ status: "active", currentIteration: 2, remainingBudget: 0 });
    }
  });

  test("pauses on terminal errors and resume continues in the current session", async () => {
    const harness = createHarness();
    await harness.command.handler("2 retry this", harness.context);
    harness.agentEnd("aborted");
    await harness.settle();
    expect(harness.state()).toMatchObject({
      status: "paused",
      currentIteration: 1,
      remainingBudget: 1,
      pauseReason: "assistant aborted",
    });
    await harness.settle();
    expect(harness.prompts).toHaveLength(1);
    await harness.command.handler("resume", commandContext(harness));
    expect(harness.prompts).toHaveLength(2);
    expect(harness.current.getSessionId()).toBe("session-1");
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
