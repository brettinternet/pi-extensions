import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import progressExtension, { INFERENCE_ENTRY } from "../../extensions/progress/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Model = NonNullable<ExtensionContext["model"]>;
const model = { provider: "openai", id: "gpt-5-nano" } as Model;
const semantic = {
  phase: "Implementation",
  current: "Updating progress inference",
  completed: ["Collected activity"],
  blocked: [],
  confidence: 0.9,
};

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function harness(completions: Array<Promise<any>> = []) {
  const handlers = new Map<string, Handler>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  let registerToolCalls = 0;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: () => { registerToolCalls += 1; },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: { setWidget: () => {}, notify: () => {} },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }),
      getProvider: () => ({
        streamSimple: (_model: Model, _request: unknown, options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          const completion = completions[calls++] ?? Promise.resolve({
            content: [{ type: "text", text: JSON.stringify(semantic) }],
            stopReason: "stop",
          });
          return { result: () => completion };
        },
      }),
    },
  } as unknown as ExtensionContext;
  progressExtension(pi);
  return { handlers, entries, signals, get calls() { return calls; }, get registerToolCalls() { return registerToolCalls; }, ctx };
}

function settleMeaningful(run: ReturnType<typeof harness>, prompt = "Implement inference"): void {
  run.handlers.get("before_agent_start")!({ prompt }, run.ctx);
  run.handlers.get("message_end")!({ message: { role: "assistant", content: "Implemented changes" } }, run.ctx);
  run.handlers.get("agent_settled")!({}, run.ctx);
}

describe("progress inference lifecycle", () => {
  test("does not call a provider when no model is configured", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = `/tmp/pi-progress-absent-${randomUUID()}`;
    try {
      const run = harness();
      run.handlers.get("session_start")!({}, run.ctx);
      settleMeaningful(run);
      await flushAsync();
      expect(run.calls).toBe(0);
      expect(run.registerToolCalls).toBe(0);
      expect(run.handlers.has("context")).toBeFalse();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("invalidates config loads before tree, switch, and fork transitions", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = `/tmp/pi-progress-pending-${randomUUID()}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, { recursive: true });
    await writeFile(`${agentDir}/pi-progress.json`, JSON.stringify({ model: "openai/gpt-5-nano" }));
    try {
      const run = harness();
      run.handlers.get("session_start")!({}, run.ctx);
      for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"]) {
        settleMeaningful(run, event);
        run.handlers.get(event)!({}, run.ctx);
      }
      await flushAsync();
      expect(run.calls).toBe(0);
      expect(run.entries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("coalesces to the newest run and rejects stale results", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = `/tmp/pi-progress-enabled-${randomUUID()}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, { recursive: true });
    await writeFile(`${agentDir}/pi-progress.json`, JSON.stringify({ model: "openai/gpt-5-nano" }));

    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    try {
      const run = harness([first, second]);
      run.handlers.get("session_start")!({}, run.ctx);
      settleMeaningful(run, "First run");
      await flushAsync();
      expect(run.calls).toBe(1);

      settleMeaningful(run, "Newer run");
      expect(run.signals[0].aborted).toBeTrue();
      await flushAsync();
      expect(run.calls).toBe(2);

      resolveFirst({ content: [{ type: "text", text: JSON.stringify({ ...semantic, phase: "Stale" }) }], stopReason: "stop" });
      resolveSecond({ content: [{ type: "text", text: JSON.stringify(semantic) }], stopReason: "stop" });
      await flushAsync();
      expect(run.entries).toEqual([{ type: INFERENCE_ENTRY, data: semantic }]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("cancels inference during tree navigation and restores only branch metadata", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = `/tmp/pi-progress-tree-${randomUUID()}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, { recursive: true });
    await writeFile(`${agentDir}/pi-progress.json`, JSON.stringify({ model: "openai/gpt-5-nano" }));
    const pending = new Promise(() => {});
    try {
      const run = harness([pending]);
      run.handlers.get("session_start")!({}, run.ctx);
      settleMeaningful(run);
      await flushAsync();
      run.handlers.get("session_before_tree")!({}, run.ctx);
      expect(run.signals[0].aborted).toBeTrue();

      const restored = harness();
      restored.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: INFERENCE_ENTRY, data: semantic }] as any;
      restored.handlers.get("session_start")!({}, restored.ctx);
      restored.handlers.get("session_shutdown")!({}, restored.ctx);
      expect(restored.entries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
