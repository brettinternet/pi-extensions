import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type Config } from "../../extensions/title/config.js";
import titleExtension, {
  completeTitle,
  completionOptions,
  resolveModel,
  splitModelReference,
  titleFromCompletion,
} from "../../extensions/title/index.js";

type ModelContext = Parameters<typeof resolveModel>[0];
type Model = NonNullable<ModelContext["model"]>;

const activeModel = { provider: "openrouter", id: "openai/gpt-5.6" } as Model;
const nanoModel = { provider: "openai", id: "gpt-5-nano" } as Model;
const openRouterNanoModel = { provider: "openrouter", id: "openai/gpt-5-nano" } as Model;
const deepSeekModel = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4-flash-latest",
  reasoning: true,
  thinkingLevelMap: { low: "low" },
} as Model;
const freeModel = {
  provider: "openrouter",
  id: "deepseek/deepseek-chat-v3.1:free",
} as Model;
const lowSuffixModel = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4-flash-latest:low",
} as Model;
const deepSeekLatestAliasModel = {
  ...deepSeekModel,
  id: "~deepseek/deepseek-v4-flash-latest",
  name: "DeepSeek V4 Flash Latest",
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: "xhigh",
    max: null,
  },
} as Model;

function config(model: string | null): Config {
  return { ...DEFAULT_CONFIG, model };
}

function context(
  find: (provider: string, modelId: string) => Model | undefined = () => undefined,
  hasConfiguredAuth: (model: Model) => boolean = () => false,
  available: Model[] = [],
): ModelContext {
  return {
    model: activeModel,
    modelRegistry: { find, hasConfiguredAuth, getAvailable: () => available },
  } as unknown as ModelContext;
}

describe("model references", () => {
  test("parses a nested model ID with a thinking level", () => {
    expect(splitModelReference("openrouter/deepseek/deepseek-v4-flash-latest:low")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash-latest",
      thinkingLevel: "low",
    });
  });

  test("preserves colon suffixes that are not thinking levels", () => {
    expect(splitModelReference("openrouter/deepseek/deepseek-chat-v3.1:free")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-chat-v3.1:free",
    });
    expect(splitModelReference("openrouter/model:constructor")).toEqual({
      provider: "openrouter",
      modelId: "model:constructor",
    });
  });
});

describe("model resolution", () => {
  test("uses the active session model when model is not configured", () => {
    expect(resolveModel(context(), config(null))).toEqual({ model: activeModel });
  });

  test("uses the first authenticated automatic candidate", () => {
    const models: Record<string, Model> = {
      "openai/gpt-5-nano": nanoModel,
      "openrouter/openai/gpt-5-nano": openRouterNanoModel,
    };
    const ctx = context(
      (provider, modelId) => models[`${provider}/${modelId}`],
      (model) => model === openRouterNanoModel,
    );

    expect(resolveModel(ctx, config("auto"))).toEqual({ model: openRouterNanoModel });
  });

  test("falls back to the active session model when no automatic candidate is authenticated", () => {
    expect(resolveModel(context(() => nanoModel), config("auto"))).toEqual({ model: activeModel });
  });

  test("tries the full model ID before interpreting a thinking suffix", () => {
    const ctx = context((_provider, modelId) =>
      modelId === lowSuffixModel.id ? lowSuffixModel : undefined,
    );

    expect(resolveModel(ctx, config("openrouter/deepseek/deepseek-v4-flash-latest:low"))).toEqual({
      model: lowSuffixModel,
    });
  });

  test("preserves a non-thinking colon suffix during resolution", () => {
    const ctx = context((_provider, modelId) => modelId === freeModel.id ? freeModel : undefined);
    expect(resolveModel(ctx, config("openrouter/deepseek/deepseek-chat-v3.1:free"))).toEqual({
      model: freeModel,
    });
  });

  test("resolves a model with a thinking level when the full ID is unavailable", () => {
    const ctx = context((provider, modelId) =>
      provider === "openrouter" && modelId === "deepseek/deepseek-v4-flash-latest"
        ? deepSeekModel
        : undefined,
    );

    expect(resolveModel(ctx, config("openrouter/deepseek/deepseek-v4-flash-latest:low"))).toEqual({
      model: deepSeekModel,
      thinkingLevel: "low",
    });
  });

  test("rejects a thinking level the resolved model does not support", () => {
    const ctx = context(
      () => undefined,
      () => true,
      [deepSeekLatestAliasModel],
    );

    expect(() => resolveModel(ctx, config("openrouter/deepseek/deepseek-v4-flash-latest:low"))).toThrow(
      'configured thinking level "low" is unavailable for openrouter/~deepseek/deepseek-v4-flash-latest; supported: off, high, xhigh',
    );
  });

  test("rejects an unavailable explicit model", () => {
    expect(() => resolveModel(context(), config("openrouter/missing:low"))).toThrow(
      "configured model is unavailable: openrouter/missing:low",
    );
  });
});

describe("completion options", () => {
  test("reserves the configured title budget after reasoning", () => {
    expect(completionOptions(config("openrouter/deepseek/deepseek-v4-flash-latest:low"), "low")).toMatchObject({
      maxTokens: DEFAULT_CONFIG.maxTokens + 2048,
      cacheRetention: "none",
      reasoning: "low",
    });
    expect(completionOptions(config("openrouter/deepseek/deepseek-v4-flash-latest:high"), "high")).toMatchObject({
      maxTokens: DEFAULT_CONFIG.maxTokens + 16384,
      reasoning: "high",
    });
  });

  test("omits reasoning when effort is off or not configured", () => {
    expect(completionOptions(config(null))).not.toHaveProperty("reasoning");
    expect(completionOptions(config("openrouter/model:off"), "off")).not.toHaveProperty("reasoning");
  });
});

describe("title command", () => {
  test("registers /title and sets custom titles", async () => {
    let commandName: string | undefined;
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const sessionTitles: string[] = [];
    const terminalTitles: string[] = [];
    const notifications: string[] = [];
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
        commandName = name;
        command = options;
      },
      getSessionName: () => sessionTitles.at(-1),
      setSessionName: (title: string) => sessionTitles.push(title),
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      ui: {
        setTitle: (title: string) => terminalTitles.push(title),
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    titleExtension(pi);
    expect(command!.getArgumentCompletions?.("reg")).toEqual([
      { value: "regenerate", label: "regenerate", description: "Generate a replacement title" },
    ]);
    expect(command!.getArgumentCompletions?.("model act")).toEqual([
      { value: "model active", label: "active", description: "Use the active session model" },
    ]);
    await command!.handler("My custom title", ctx);
    await command!.handler("set status", ctx);

    expect(commandName).toBe("title");
    expect(sessionTitles).toEqual(["My custom title", "status"]);
    expect(terminalTitles).toEqual(["My custom title", "status"]);
    expect(notifications).toEqual(["Session title: My custom title", "Session title: status"]);
  });
});

describe("automatic title generation", () => {
  test("starts from the request without delaying the main agent", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = `/tmp/pi-title-test-${randomUUID()}`;

    try {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      let sessionTitle: string | undefined;
      let resolveCompletion!: (response: {
        content: Array<{ type: string; text?: string }>;
        stopReason: string;
      }) => void;
      const completion = new Promise<{
        content: Array<{ type: string; text?: string }>;
        stopReason: string;
      }>((resolve) => {
        resolveCompletion = resolve;
      });
      let requestCount = 0;
      let titleRequest: { messages?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let markTitleSet!: () => void;
      const titleSet = new Promise<void>((resolve) => {
        markTitleSet = resolve;
      });

      const pi = {
        on: (name: string, handler: unknown) => {
          handlers.set(name, handler as (...args: unknown[]) => unknown);
        },
        registerCommand: () => {},
        getSessionName: () => sessionTitle,
        setSessionName: (title: string) => {
          sessionTitle = title;
          markTitleSet();
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        hasUI: true,
        model: activeModel,
        modelRegistry: {
          getProvider: () => ({
            streamSimple: (_model: unknown, request: typeof titleRequest) => {
              requestCount += 1;
              titleRequest = request;
              markStarted();
              return { result: () => completion };
            },
          }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
        },
        sessionManager: {
          getBranch: () => [
            { type: "message", message: { role: "user", content: "Implement background titles" } },
          ],
        },
        ui: { setTitle: () => {}, notify: () => {} },
      } as unknown as ExtensionCommandContext;

      titleExtension(pi);
      const result = handlers.get("before_agent_start")!(
        { prompt: "Implement background titles" },
        ctx,
      );

      expect(result).toBeUndefined();
      await started;
      expect(sessionTitle).toBeUndefined();
      expect(titleRequest?.messages?.[0]?.content?.[0]?.text).toContain("Implement background titles");
      expect(titleRequest?.messages?.[0]?.content?.[0]?.text).not.toContain("assistant response");

      handlers.get("message_end")!(
        { message: { role: "assistant", content: [{ type: "text", text: "Implemented it" }] } },
        ctx,
      );
      expect(requestCount).toBe(1);

      resolveCompletion({ content: [{ type: "text", text: "Background Session Titles" }], stopReason: "stop" });
      await titleSet;
      expect(sessionTitle).toBe("Background Session Titles");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("cancels an automatic request before explicit regeneration", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = `/tmp/pi-title-test-${randomUUID()}`;

    try {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
      let sessionTitle: string | undefined;
      let automaticSignal: AbortSignal | undefined;
      let markAutomaticStarted!: () => void;
      const automaticStarted = new Promise<void>((resolve) => {
        markAutomaticStarted = resolve;
      });
      let markAutomaticAborted!: () => void;
      const automaticAborted = new Promise<void>((resolve) => {
        markAutomaticAborted = resolve;
      });
      let resolveRegeneration!: (response: {
        content: Array<{ type: string; text?: string }>;
        stopReason: string;
      }) => void;
      const regeneration = new Promise<{
        content: Array<{ type: string; text?: string }>;
        stopReason: string;
      }>((resolve) => {
        resolveRegeneration = resolve;
      });
      let requestCount = 0;

      const pi = {
        on: (name: string, handler: unknown) => {
          handlers.set(name, handler as (...args: unknown[]) => unknown);
        },
        registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
          command = options;
        },
        getSessionName: () => sessionTitle,
        setSessionName: (title: string) => {
          sessionTitle = title;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        hasUI: true,
        model: activeModel,
        modelRegistry: {
          getProvider: () => ({
            streamSimple: (_model: unknown, _request: unknown, options: { signal: AbortSignal }) => {
              requestCount += 1;
              if (requestCount === 1) {
                automaticSignal = options.signal;
                markAutomaticStarted();
                return {
                  result: () => new Promise((_, reject) => {
                    options.signal.addEventListener("abort", () => {
                      markAutomaticAborted();
                      reject(new Error("aborted"));
                    }, { once: true });
                  }),
                };
              }
              return { result: () => regeneration };
            },
          }),
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
        },
        sessionManager: {
          getBranch: () => [
            { type: "message", message: { role: "user", content: "Implement background titles" } },
            { type: "message", message: { role: "assistant", content: "Implemented it" } },
          ],
        },
        ui: { setTitle: () => {}, notify: () => {} },
      } as unknown as ExtensionCommandContext;

      titleExtension(pi);
      handlers.get("message_end")!(
        { message: { role: "assistant", content: [{ type: "text", text: "Implemented it" }] } },
        ctx,
      );
      await automaticStarted;

      const regenerate = command!.handler("regenerate", ctx);
      await automaticAborted;
      expect(automaticSignal?.aborted).toBeTrue();

      resolveRegeneration({ content: [{ type: "text", text: "Regenerated Title" }], stopReason: "stop" });
      await regenerate;
      expect(requestCount).toBe(2);
      expect(sessionTitle).toBe("Regenerated Title");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

describe("title completion output", () => {
  test("reports a thinking-only completion instead of claiming the exchange is missing", () => {
    expect(() =>
      titleFromCompletion(
        { content: [{ type: "thinking" }], stopReason: "length" },
        DEFAULT_CONFIG.maxLength,
      ),
    ).toThrow("title model returned no usable text (stop reason: length)");
  });
});

describe("title completion", () => {
  test("uses authenticated provider streamSimple with the configured thinking level", async () => {
    const response = {
      role: "assistant" as const,
      content: [],
      api: "openai-completions",
      provider: "openrouter",
      model: deepSeekModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 0,
    };
    let requestedModel: Model | undefined;
    let requestedOptions: Record<string, unknown> | undefined;
    const controller = new AbortController();
    const ctx = {
      modelRegistry: {
        getProvider: () => ({
          streamSimple: (model: Model, _request: unknown, options: Record<string, unknown>) => {
            requestedModel = model;
            requestedOptions = options;
            return { result: async () => response };
          },
        }),
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          apiKey: "test-key",
          headers: { "x-test": "value" },
          baseUrl: "https://example.test/v1",
          env: { TEST_ENV: "value" },
        }),
      },
    } as unknown as Parameters<typeof completeTitle>[0];

    await expect(
      completeTitle(ctx, deepSeekModel, { messages: [] }, config("ignored"), "low", controller.signal),
    ).resolves.toBe(response);
    expect(requestedModel?.baseUrl).toBe("https://example.test/v1");
    expect(requestedOptions).toMatchObject({
      apiKey: "test-key",
      headers: { "x-test": "value" },
      env: { TEST_ENV: "value" },
      reasoning: "low",
      signal: controller.signal,
    });
  });
});
