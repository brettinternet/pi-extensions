import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "../../extensions/ask-user-question/index.ts";
import agentStateExtension, {
  registerAgentState,
} from "../../extensions/agent-state/index.ts";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, value: unknown = {}): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function setup(
  sendRequest?: (request: Record<string, unknown>) => Promise<void>,
  now: () => number = () => 1_000,
  transport: { env?: Record<string, string | undefined>; output?: { isTTY?: boolean; write: (sequence: string) => unknown } } = {},
) {
  const events = new EventBus();
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    events,
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => "session-1",
    },
  } as unknown as ExtensionContext;
  const bridge = registerAgentState(pi, {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
    now,
    output: { isTTY: false, write: () => {} },
    ...transport,
    sendRequest: sendRequest ?? (async () => {}),
  });
  return { pi, events, hooks, ctx, bridge };
}

function params(request: Record<string, unknown>): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

function collectStateReports(reports: Record<string, unknown>[]) {
  return async (request: Record<string, unknown>): Promise<void> => {
    if (request.method === "pane.report_agent") reports.push(params(request));
  };
}

async function start(hooks: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>, ctx: ExtensionContext): Promise<void> {
  await hooks.get("session_start")!({}, ctx);
}

describe("Pi agent state integration", () => {
  test("reports OSC outside Herdr, sanitizes bounded UTF-8 messages, and clears on shutdown", async () => {
    const sequences: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(async (request) => { requests.push(request); }, undefined, {
      env: {}, output: { isTTY: true, write: (sequence) => sequences.push(sequence) },
    });
    await start(hooks, ctx);
    expect(sequences).toEqual(["\x1b]7501;state=idle:app=pi\x1b\\"]);
    events.emit("herdr:busy", { active: true, label: "a\n\x1b\x07\x7f\x85:=" + "😀".repeat(1000) });
    const sequence = sequences.at(-1)!;
    expect(sequence.startsWith("\x1b]7501;state=working:app=pi:msg=")).toBe(true);
    expect(sequence.endsWith("\x1b\\")).toBe(true);
    expect(Buffer.byteLength(sequence)).toBeLessThanOrEqual(4096);
    const encoded = sequence.split(":msg=")[1]!.slice(0, -2);
    const message = Buffer.from(encoded, "base64");
    expect(encoded.length).toBeLessThanOrEqual(2732);
    expect(message.byteLength).toBeLessThanOrEqual(2048);
    expect(message.toString()).toBe("a:=" + "😀".repeat(511));
    events.emit("herdr:blocked", { active: true, scope: "root", label: "Approval?" });
    expect(sequences.at(-1)).toBe("\x1b]7501;state=blocked:app=pi:msg=QXBwcm92YWw/\x1b\\");
    events.emit("herdr:blocked", { active: false, scope: "root" });
    expect(sequences.at(-1)).toBe(sequence);
    events.emit("herdr:busy", { active: false });
    expect(sequences.at(-1)).toBe("\x1b]7501;state=idle:app=pi\x1b\\");
    hooks.get("session_shutdown")!({}, ctx);
    expect(sequences.at(-1)).toBe("\x1b]7501;state=clear:app=pi\x1b\\");
    const count = sequences.length;
    hooks.get("session_shutdown")!({}, ctx);
    events.emit("herdr:busy", { active: true });
    await bridge.flush();
    expect(sequences).toHaveLength(count);
    expect(requests).toEqual([]);
  });

  test("never emits OSC in non-TUI modes or to redirected stdout", async () => {
    for (const mode of ["json", "rpc", "print", "tui"] as const) {
      const sequences: string[] = [];
      const { events, hooks, ctx, bridge } = setup(undefined, undefined, {
        output: { isTTY: mode !== "tui", write: (sequence) => sequences.push(sequence) },
      });
      const context = { ...ctx, mode } as ExtensionContext;
      await start(hooks, context);
      hooks.get("agent_start")!({}, context);
      events.emit("herdr:busy", { active: true });
      hooks.get("session_shutdown")!({}, context);
      await bridge.flush();
      expect(sequences).toEqual([]);
    }
  });

  test("restores busy state received before the interactive session starts", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(collectStateReports(reports));

    events.emit("herdr:busy", { active: true, label: "subagent" });
    await start(hooks, ctx);
    await bridge.flush();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ state: "working", message: "subagent" });
  });

  test("anchors the Pi session before reporting initial lifecycle state", async () => {
    const requests: Record<string, unknown>[] = [];
    const { hooks, ctx, bridge } = setup(async (request) => {
      requests.push(request);
    });

    await hooks.get("session_start")!({ reason: "startup" }, ctx);
    await bridge.flush();

    expect(requests.map((request) => request.method)).toEqual([
      "pane.report_agent_session",
      "pane.report_agent",
    ]);
    expect(params(requests[0])).toMatchObject({
      source: "herdr:pi",
      agent: "pi",
      session_start_source: "startup",
      agent_session_path: "/tmp/pi-session.jsonl",
    });
  });

  test("keeps working after the parent settles while a sibling is busy", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    hooks.get("agent_start")!({}, ctx);
    events.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
    hooks.get("agent_settled")!({}, ctx);
    await bridge.flush();

    expect(reports.map((report) => report.state)).toEqual(["working", "working"]);
    expect(reports.at(-1)).toMatchObject({
      pane_id: "pane-1",
      source: "herdr:pi",
      agent: "pi",
      state: "working",
      message: "⏳ 1 subagent",
      agent_session_path: "/tmp/pi-session.jsonl",
    });

    events.emit("herdr:busy", { active: false });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "idle" });
  });

  test("gives blocked status precedence and restores the underlying state", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    events.emit("herdr:busy", { active: true, label: "subagent" });
    events.emit("herdr:blocked", { active: true, label: "Approval required", scope: "root" });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "blocked", message: "Approval required" });

    events.emit("herdr:blocked", { active: false, scope: "root" });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "working", message: "subagent" });

    events.emit("herdr:busy", { active: false });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "idle" });
  });

  test("reports blocking built-in UI prompts and restores active work", async () => {
    const reports: Record<string, unknown>[] = [];
    const { hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    hooks.get("agent_start")!({}, ctx);
    hooks.get("ui_prompt_start")!({ kind: "select", title: "Local stack" }, ctx);
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "blocked", message: "Local stack" });

    hooks.get("ui_prompt_end")!({ kind: "select" }, ctx);
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "working", message: undefined });
  });

  test("reports ask-user questionnaires and restores active work", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    hooks.get("agent_start")!({}, ctx);
    events.emit("rpiv:ask-user:blocked", { active: true });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "blocked", message: "Waiting for user" });

    events.emit("rpiv:ask-user:blocked", { active: false });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "working", message: undefined });
  });

  for (const outcome of ["submit", "cancel", "abort", "error"] as const) {
    test(`actual questionnaire reports blocked and clears on ${outcome}`, async () => {
      const reports: Record<string, unknown>[] = [];
      const { pi, hooks, ctx, bridge } = setup(collectStateReports(reports));
      let tool: any;
      askUserQuestion({ ...pi, on: () => () => {}, registerTool: (value) => { tool = value; } });
      await start(hooks, ctx);
      hooks.get("agent_start")!({}, ctx);
      const controller = new AbortController();
      let finish!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      const uiResult = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const promptCtx = { ...ctx, hasUI: true, ui: {
        custom: async () => {
          hooks.get("ui_prompt_start")!({ kind: "custom" }, ctx);
          try { return await uiResult; }
          finally { hooks.get("ui_prompt_end")!({ kind: "custom" }, ctx); }
        },
      } } as unknown as ExtensionContext;
      const execution = tool.execute("question", { questions: [{
        header: "Store", question: "Which store?", options: [
          { label: "SQLite", description: "Embedded" }, { label: "Postgres", description: "Remote" },
        ],
      }] }, controller.signal, undefined, promptCtx);
      try {
        await bridge.flush();
        expect(reports.at(-1)).toMatchObject({ state: "blocked", message: "Waiting for user" });
      } finally {
        if (outcome === "error") fail(new Error("UI failed"));
        else {
          if (outcome === "abort") controller.abort();
          finish({ cancelled: outcome !== "submit", answers: [] });
        }
        if (outcome === "error") await expect(execution).rejects.toThrow("UI failed");
        else await execution;
        await bridge.flush();
      }
      expect(reports.at(-1)).toMatchObject({ state: "working", message: undefined });
      hooks.get("agent_settled")!({}, ctx);
      await bridge.flush();
      expect(reports.at(-1)).toMatchObject({ state: "idle" });
    });
  }

  test("keeps working during generic custom UI", async () => {
    const reports: Record<string, unknown>[] = [];
    const { hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    hooks.get("agent_start")!({}, ctx);
    hooks.get("ui_prompt_start")!({ kind: "custom" }, ctx);
    await bridge.flush();

    expect(reports).toEqual([expect.objectContaining({ state: "working" })]);
  });

  test("keeps working when a subagent needs attention", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(collectStateReports(reports));
    await start(hooks, ctx);
    reports.length = 0;

    events.emit("herdr:busy", { active: true, label: "⏳ 1 subagent ⚠" });
    events.emit("herdr:blocked", { active: true, label: "subagent needs attention" });
    await bridge.flush();

    expect(reports.at(-1)).toMatchObject({
      state: "working",
      message: "⏳ 1 subagent ⚠",
    });
  });

  test("does nothing without a transport or outside the interactive TUI", async () => {
    const reports: Record<string, unknown>[] = [];
    const headless = setup(collectStateReports(reports));
    const headlessCtx = { ...headless.ctx, mode: "json" } as ExtensionContext;
    headless.events.emit("herdr:busy", { active: true });
    await headless.hooks.get("session_start")!({}, headlessCtx);
    await headless.bridge.flush();
    expect(reports).toEqual([]);

    const inert = {
      events: new EventBus(),
      on: () => {},
    } as unknown as ExtensionAPI;
    agentStateExtension(inert);
    inert.events.emit("herdr:busy", { active: true });
  });

  test("coalesces reports and preserves sequence order across an async send", async () => {
    const reports: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { events, hooks, ctx, bridge } = setup(async (request) => {
      if (request.method !== "pane.report_agent") return;
      reports.push(params(request));
      if (reports.length === 1) await firstSend;
    });
    await start(hooks, ctx);
    hooks.get("agent_start")!({}, ctx);
    hooks.get("agent_settled")!({}, ctx);
    events.emit("herdr:busy", { active: true });
    const flushed = bridge.flush();
    await Promise.resolve();
    releaseFirst();
    await flushed;

    expect(reports.map((report) => report.state)).toEqual(["idle", "working"]);
    expect(reports[0].seq).toBe(1_000_001);
    expect(reports[1].seq).toBeGreaterThan(reports[0].seq as number);
  });
});
