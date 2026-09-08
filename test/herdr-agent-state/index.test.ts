import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import herdrAgentStateExtension, {
  registerHerdrAgentState,
} from "../../extensions/herdr-agent-state/index.ts";

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
  const bridge = registerHerdrAgentState(pi, {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
    now,
    sendRequest: sendRequest ?? (async () => {}),
  });
  return { events, hooks, ctx, bridge };
}

function params(request: Record<string, unknown>): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

async function start(hooks: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>, ctx: ExtensionContext): Promise<void> {
  await hooks.get("session_start")!({}, ctx);
}

describe("Herdr Pi agent state workaround", () => {
  test("restores busy state received before the interactive session starts", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(async (request) => {
      reports.push(params(request));
    });

    events.emit("herdr:busy", { active: true, label: "subagent" });
    await start(hooks, ctx);
    await bridge.flush();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ state: "working", message: "subagent" });
  });

  test("reaffirms working after managed idle when a sibling is busy", async () => {
    const reports: Record<string, unknown>[] = [];
    let currentTime = 1_000;
    const { events, hooks, ctx, bridge } = setup(async (request) => {
      reports.push(params(request));
    }, () => currentTime);
    await start(hooks, ctx);
    reports.length = 0;

    hooks.get("agent_start")!({}, ctx);
    events.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
    await bridge.flush();
    currentTime = 2_000;
    hooks.get("agent_settled")!({}, ctx);
    reports.push({ state: "idle", seq: currentTime * 1000 - 1 });
    await Promise.resolve();
    await bridge.flush();

    expect(reports.map((report) => report.state)).toEqual(["working", "working", "idle", "working"]);
    expect(reports.at(-1)).toMatchObject({
      pane_id: "pane-1",
      source: "herdr:pi",
      agent: "pi",
      state: "working",
      message: "⏳ 1 subagent",
      agent_session_path: "/tmp/pi-session.jsonl",
    });
    expect(reports.at(-1)!.seq).toBe(currentTime * 1000);
    expect(reports.at(-1)!.seq).toBeGreaterThan(reports.at(-2)!.seq as number);
  });

  test("gives blocked status precedence and restores the underlying state", async () => {
    const reports: Record<string, unknown>[] = [];
    const { events, hooks, ctx, bridge } = setup(async (request) => {
      reports.push(params(request));
    });
    await start(hooks, ctx);
    reports.length = 0;

    events.emit("herdr:busy", { active: true, label: "subagent" });
    events.emit("herdr:blocked", { active: true, label: "Approval required" });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "blocked", message: "Approval required" });

    events.emit("herdr:blocked", { active: false });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "working", message: "subagent" });

    events.emit("herdr:busy", { active: false });
    await bridge.flush();
    expect(reports.at(-1)).toMatchObject({ state: "idle" });
  });

  test("does nothing outside Herdr or outside the interactive TUI", async () => {
    const reports: Record<string, unknown>[] = [];
    const headless = setup(async (request) => {
      reports.push(params(request));
    });
    const headlessCtx = { ...headless.ctx, mode: "json" } as ExtensionContext;
    headless.events.emit("herdr:busy", { active: true });
    await headless.hooks.get("session_start")!({}, headlessCtx);
    await headless.bridge.flush();
    expect(reports).toEqual([]);

    const inert = {
      events: new EventBus(),
      on: () => {},
    } as unknown as ExtensionAPI;
    herdrAgentStateExtension(inert);
    inert.events.emit("herdr:busy", { active: true });
  });

  test("coalesces reports and preserves sequence order across an async send", async () => {
    const reports: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { events, hooks, ctx, bridge } = setup(async (request) => {
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
    expect(reports[0].seq).toBe(1_000_000);
    expect(reports[1].seq).toBeGreaterThan(reports[0].seq as number);
  });
});
