import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import titleExtension, { resolveModelChain } from "../../extensions/title/index.js";
import { DEFAULT_CONFIG } from "../../extensions/title/config.js";

type ModelContext = Parameters<typeof resolveModelChain>[0];
type Model = NonNullable<ModelContext["model"]>;
const sessionModel = { provider: "openai", id: "session" } as Model;
const configuredModel = { provider: "anthropic", id: "configured" } as Model;
const configured = "anthropic/configured";
const active = "openai/session";
type Response = { content: Array<{ type: string; text: string }>; stopReason: string; errorMessage?: string };
const ok = (): Response => ({ content: [{ type: "text", text: "Upload retries" }], stopReason: "stop" });
const failed = (errorMessage: string): Response => ({ content: [], stopReason: "error", errorMessage });
let previousAgentDir: string | undefined;
beforeEach(() => { previousAgentDir = process.env.PI_CODING_AGENT_DIR; });
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function context(models = [configuredModel, sessionModel]): ModelContext {
  return {
    model: sessionModel,
    modelRegistry: {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
    },
  } as unknown as ModelContext;
}

function harness(model: string | null, responses: Array<Response | Error | (() => Promise<Response>)>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-title-fallback-"));
  writeFileSync(join(dir, "pi-title.jsonc"), JSON.stringify({ model }));
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const attempts: string[] = [];
  const titles: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let terminalError: Error | undefined;
  let stale = false;
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, value: typeof command) => { command = value; },
    getSessionName: () => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return titles.at(-1);
    },
    setSessionName: (title: string) => { titles.push(title); },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const base = context();
  const ctx = {
    ...base,
    hasUI: true,
    modelRegistry: {
      ...base.modelRegistry,
      streamSimple: (candidate: Model) => {
        attempts.push(`${candidate.provider}/${candidate.id}`);
        return { result: async () => {
          const next = responses.shift();
          if (!next) throw new Error("unexpected model request");
          if (next instanceof Error) throw next;
          return typeof next === "function" ? next() : next;
        } };
      },
    },
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: "Add upload retries" } },
      { type: "message", message: { role: "assistant", content: "Done" } },
    ] },
    ui: {
      notify: (message: string, level: string) => { notifications.push({ message, level }); },
      setTitle: () => { if (terminalError) throw terminalError; },
    },
  } as unknown as ExtensionCommandContext;
  titleExtension(pi);
  return {
    attempts, titles, notifications,
    run: () => command.handler("regenerate", ctx),
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
    breakTerminal: () => { terminalError = new Error("terminal failure"); },
    invalidate: () => { stale = true; },
  };
}

describe("title model chain", () => {
  test("deduplicates the active model, including auto resolution", () => {
    for (const model of [null, active, "auto"]) {
      expect(resolveModelChain(context([sessionModel]), { ...DEFAULT_CONFIG, model }).candidates)
        .toHaveLength(1);
    }
  });
  test("records resolution failures and retains the session model", () => {
    const chain = resolveModelChain(context(), { ...DEFAULT_CONFIG, model: "anthropic/missing" });
    expect(chain.configuredFailure).toContain("anthropic/missing");
    expect(chain.candidates.map((candidate) => candidate.model)).toEqual([sessionModel]);
  });
  test("keeps configured thinking effort on the first candidate only", () => {
    const reasoning = { ...configuredModel, reasoning: true } as Model;
    const chain = resolveModelChain(context([reasoning]), { ...DEFAULT_CONFIG, model: `${configured}:low` });
    expect(chain.candidates.map((candidate) => candidate.thinkingLevel)).toEqual(["low", undefined]);
  });
});

describe("title model fallback", () => {
  test("does not fall back or warn when the configured model works", async () => {
    const h = harness(configured, [ok()]);
    await h.run();
    expect(h.attempts).toEqual([configured]);
    expect(h.titles).toEqual(["Upload retries"]);
    expect(h.notifications.filter((notification) => notification.level === "warning")).toEqual([]);
    h.shutdown();
  });
  test("skips an unavailable configured model and explains fallback", async () => {
    const h = harness("anthropic/missing", [ok()]);
    await h.run();
    expect(h.attempts).toEqual([active]);
    expect(h.notifications[0]).toMatchObject({ level: "warning" });
    expect(h.notifications[0]!.message).toContain("anthropic/missing");
    expect(h.notifications[0]!.message).toContain(`used ${active}`);
    h.shutdown();
  });
  test("falls back once for thrown, provider, and empty-response failures", async () => {
    for (const failure of [new Error("401 unauthorized"), failed("429 quota exceeded"), failed("503 unavailable"), { content: [], stopReason: "stop" }]) {
      const h = harness(configured, [failure, ok()]);
      await h.run();
      expect(h.attempts).toEqual([configured, active]);
      expect(h.titles).toEqual(["Upload retries"]);
      expect(h.notifications[0]!.message).toContain(configured);
      h.shutdown();
    }
  });
  test("reports both failures without retrying either model", async () => {
    const h = harness(configured, [failed("402 payment required"), failed("503 unavailable")]);
    await h.run();
    expect(h.attempts).toEqual([configured, active]);
    expect(h.titles).toEqual([]);
    expect(h.notifications[0]!.message).toContain("402 payment required");
    expect(h.notifications[0]!.message).toContain("503 unavailable");
  });
  test("includes a resolution failure when the fallback fails", async () => {
    const h = harness("anthropic/missing", [failed("503 unavailable")]);
    await h.run();
    expect(h.notifications[0]!.message).toContain("anthropic/missing");
    expect(h.notifications[0]!.message).toContain("503 unavailable");
  });
  test("preserves the error for a single failed model without retrying", async () => {
    const h = harness(null, [new Error("503 unavailable")]);
    await h.run();
    expect(h.attempts).toEqual([active]);
    expect(h.notifications).toEqual([{ message: "503 unavailable", level: "error" }]);
  });
  test("cancellation stops the chain, including partial responses", async () => {
    for (const response of [
      { ...ok(), stopReason: "aborted" },
      new DOMException("Cancelled", "AbortError"),
    ]) {
      const h = harness(configured, [response, ok()]);
      await h.run();
      expect(h.attempts).toEqual([configured]);
      expect(h.titles).toEqual([]);
      // /title regenerate retains its existing no-result informational message.
      expect(h.notifications.every((notification) => notification.level === "info")).toBe(true);
    }
  });
  test("provider cancellation text falls back when the title request was not cancelled", async () => {
    for (const failure of [new Error("The operation was aborted"), failed("The request was cancelled")]) {
      const h = harness(configured, [failure, ok()]);
      await h.run();
      expect(h.attempts).toEqual([configured, active]);
      expect(h.titles).toEqual(["Upload retries"]);
      h.shutdown();
    }
  });
  test("shutdown during a failed request prevents fallback", async () => {
    const h = harness(configured, [async () => { h.shutdown(); return failed("503 unavailable"); }, ok()]);
    await h.run();
    expect(h.attempts).toEqual([configured]);
    expect(h.titles).toEqual([]);
    expect(h.notifications.every((notification) => notification.level === "info")).toBe(true);
  });
  test("stale context and terminal failures do not trigger fallback", async () => {
    const stale = harness(configured, [async () => {
      stale.invalidate();
      throw new Error("This extension ctx is stale after session replacement or reload.");
    }, ok()]);
    await stale.run();
    expect(stale.attempts).toEqual([configured]);
    expect(stale.titles).toEqual([]);
    const terminal = harness(configured, [ok(), ok()]);
    terminal.breakTerminal();
    await terminal.run();
    expect(terminal.attempts).toEqual([configured]);
    expect(terminal.titles).toEqual(["Upload retries"]);
    expect(terminal.notifications).toEqual([{ message: "terminal failure", level: "error" }]);
  });
});
