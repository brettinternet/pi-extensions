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
    await command!.handler("My custom title", ctx);
    await command!.handler("set status", ctx);

    expect(commandName).toBe("title");
    expect(sessionTitles).toEqual(["My custom title", "status"]);
    expect(terminalTitles).toEqual(["My custom title", "status"]);
    expect(notifications).toEqual(["Session title: My custom title", "Session title: status"]);
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
      completeTitle(ctx, deepSeekModel, { messages: [] }, config("ignored"), "low"),
    ).resolves.toBe(response);
    expect(requestedModel?.baseUrl).toBe("https://example.test/v1");
    expect(requestedOptions).toMatchObject({
      apiKey: "test-key",
      headers: { "x-test": "value" },
      env: { TEST_ENV: "value" },
      reasoning: "low",
    });
  });
});
