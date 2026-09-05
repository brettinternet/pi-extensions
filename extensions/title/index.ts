import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArguments, completeModelArgument } from "./completions.ts";
import { configPath, loadConfig, saveConfig, type Config } from "./config.js";
import { cleanTitle, firstCompletedExchange, TITLE_SYSTEM_PROMPT } from "./title.js";

type TitleSource = { user: string; assistant?: string };

const AUTOMATIC_MODEL_CANDIDATES = [
  "openai/gpt-5-nano",
  "openrouter/openai/gpt-5-nano",
  "google/gemini-2.5-flash-lite",
  "openrouter/google/gemini-2.5-flash-lite",
  "anthropic/claude-haiku-4-5",
];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

const THINKING_TOKEN_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 16384,
  max: 16384,
};

type TitleModel = NonNullable<ExtensionContext["model"]>;
type TitleRequest = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];

function splitProviderAndModel(reference: string): { provider: string; modelId: string } | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

export function splitModelReference(
  reference: string,
): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined {
  const full = splitProviderAndModel(reference);
  if (!full) return undefined;

  const colon = full.modelId.lastIndexOf(":");
  if (colon < 0) return full;

  const modelId = full.modelId.slice(0, colon);
  const thinkingLevel = full.modelId.slice(colon + 1) as ThinkingLevel;
  if (!modelId || !Object.hasOwn(THINKING_LEVELS, thinkingLevel)) return full;
  return { provider: full.provider, modelId, thinkingLevel };
}
function findConfiguredModel(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  provider: string,
  modelId: string,
): TitleModel | undefined {
  const exact = ctx.modelRegistry.find(provider, modelId);
  if (exact) return exact;

  const normalizedProvider = provider.toLowerCase();
  const normalizedPattern = modelId.toLowerCase();
  const matches = ctx.modelRegistry.getAvailable().filter(
    (model) =>
      model.provider.toLowerCase() === normalizedProvider &&
      (model.id.toLowerCase().includes(normalizedPattern) ||
        model.name?.toLowerCase().includes(normalizedPattern)),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((model) => !/-\d{8}$/.test(model.id));
  const candidates = aliases.length > 0 ? aliases : matches;
  candidates.sort((a, b) => b.id.localeCompare(a.id));
  return candidates[0];
}
function supportedThinkingLevels(model: TitleModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return (Object.keys(THINKING_LEVELS) as ThinkingLevel[]).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function assertThinkingLevelSupported(model: TitleModel, level: ThinkingLevel): void {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(level)) return;
  throw new Error(
    `configured thinking level "${level}" is unavailable for ${model.provider}/${model.id}; supported: ${supported.join(", ")}`,
  );
}

export function resolveModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: Config,
): { model: ExtensionContext["model"]; thinkingLevel?: ThinkingLevel } {
  if (!config.model) return { model: ctx.model };

  if (config.model === "auto") {
    for (const reference of AUTOMATIC_MODEL_CANDIDATES) {
      const parsed = splitModelReference(reference)!;
      const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
      if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { model };
    }
    return { model: ctx.model };
  }

  const full = splitProviderAndModel(config.model);
  if (!full) throw new Error(`invalid model reference: ${config.model}`);

  const exactModel = findConfiguredModel(ctx, full.provider, full.modelId);
  if (exactModel) return { model: exactModel };

  const parsed = splitModelReference(config.model)!;
  if (parsed.thinkingLevel) {
    const model = findConfiguredModel(ctx, parsed.provider, parsed.modelId);
    if (model) {
      assertThinkingLevelSupported(model, parsed.thinkingLevel);
      return { model, thinkingLevel: parsed.thinkingLevel };
    }
  }

  throw new Error(`configured model is unavailable: ${config.model}`);
}

export function completionOptions(config: Config, thinkingLevel?: ThinkingLevel) {
  const thinkingTokens = thinkingLevel && thinkingLevel !== "off"
    ? THINKING_TOKEN_BUDGETS[thinkingLevel]
    : 0;
  return {
    maxTokens: config.maxTokens + thinkingTokens,
    cacheRetention: "none" as const,
    sessionId: randomUUID(),
    ...(thinkingLevel && thinkingLevel !== "off" && { reasoning: thinkingLevel }),
  };
}

export async function completeTitle(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: TitleModel,
  request: TitleRequest,
  config: Config,
  thinkingLevel?: ThinkingLevel,
  signal?: AbortSignal,
) {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`unknown provider: ${model.provider}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const resolvedModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return provider
    .streamSimple(resolvedModel, request, {
      ...completionOptions(config, thinkingLevel),
      signal,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
    })
    .result();
}

function completionText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function titleFromCompletion(
  response: { content: Array<{ type: string; text?: string }>; stopReason: string },
  maxLength: number,
): string {
  const title = cleanTitle(completionText(response.content), maxLength);
  if (!title) throw new Error(`title model returned no usable text (stop reason: ${response.stopReason})`);
  return title;
}

export default function titleExtension(pi: ExtensionAPI) {
  let generating = false;
  let generationController: AbortController | undefined;
  let backgroundGeneration: Promise<string | undefined> | undefined;
  let lifecycle = 0;
  let completionContext: ExtensionContext | undefined;

  function applyTerminalTitle(ctx: ExtensionContext, title = pi.getSessionName()): void {
    if (ctx.hasUI && title) ctx.ui.setTitle(title);
  }

  function setTitle(ctx: ExtensionContext, title: string): void {
    pi.setSessionName(title);
    applyTerminalTitle(ctx, title);
    deferTerminalTitle(ctx);
    ctx.ui.notify(`Session title: ${title}`, "info");
  }

  function deferTerminalTitle(ctx: ExtensionContext): void {
    const expectedLifecycle = lifecycle;
    setTimeout(() => {
      if (lifecycle === expectedLifecycle) applyTerminalTitle(ctx);
    }, 0);
  }

  async function generate(
    ctx: ExtensionContext,
    overwrite: boolean,
    source: TitleSource | undefined = firstCompletedExchange(ctx.sessionManager.getBranch()),
  ): Promise<string | undefined> {
    if (generating || (!overwrite && pi.getSessionName()) || !source) return undefined;

    generating = true;
    const controller = new AbortController();
    generationController = controller;
    const expectedLifecycle = lifecycle;
    try {
      const config = await loadConfig();
      if (!config.enabled && !overwrite) return undefined;

      const { model, thinkingLevel } = resolveModel(ctx, config);
      if (!model) throw new Error("no title model is available");

      const response = await completeTitle(
        ctx,
        model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "--- First user request ---",
                    source.user.slice(0, 4800),
                    ...(source.assistant
                      ? ["--- First assistant response ---", source.assistant.slice(0, 2400)]
                      : []),
                    "--- End session data ---",
                  ].join("\n"),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        config,
        thinkingLevel,
        controller.signal,
      );

      if (controller.signal.aborted || lifecycle !== expectedLifecycle) return undefined;
      const title = titleFromCompletion(response, config.maxLength);
      if (!overwrite && pi.getSessionName()) return undefined;

      pi.setSessionName(title);
      applyTerminalTitle(ctx, title);
      deferTerminalTitle(ctx);
      return title;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (generationController === controller) {
        generationController = undefined;
        generating = false;
      }
    }
  }

  function generateInBackground(ctx: ExtensionContext, source: TitleSource | undefined): void {
    if (backgroundGeneration) return;

    const expectedLifecycle = lifecycle;
    const request = generate(ctx, false, source);
    backgroundGeneration = request;
    void request
      .catch((error) => {
        if (lifecycle !== expectedLifecycle) return;
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.warn(`[pi-title] ${message}`);
      })
      .finally(() => {
        if (backgroundGeneration === request) backgroundGeneration = undefined;
      });
  }

  function resetGeneration(): void {
    lifecycle += 1;
    generationController?.abort();
    generationController = undefined;
    backgroundGeneration = undefined;
    generating = false;
  }

  pi.on("session_start", (_event, ctx) => {
    completionContext = ctx;
    resetGeneration();
    deferTerminalTitle(ctx);
  });

  pi.on("session_shutdown", () => {
    completionContext = undefined;
    resetGeneration();
  });

  pi.on("session_info_changed", (_event, ctx) => {
    deferTerminalTitle(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    generateInBackground(ctx, { user: event.prompt });
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const exchange = firstCompletedExchange([
      ...ctx.sessionManager.getBranch(),
      { type: "message", message: event.message },
    ]);
    if (exchange) generateInBackground(ctx, exchange);
  });

  pi.registerCommand("title", {
    description: "[status | on | off | model [provider/model[:thinking]|auto|active] | regenerate | set <title>] — Set or configure titles",
    getArgumentCompletions: (prefix) => {
      if (/^model\s/i.test(prefix)) {
        return completeModelArgument(prefix, completionContext, [
          { value: "model active", label: "active", description: "Use the active session model" },
          { value: "model auto", label: "auto", description: "Use the lightweight-model fallback" },
        ]);
      }
      return completeArguments(prefix, [
        { value: "status", label: "status", description: "Show title status and configuration" },
        { value: "on", label: "on", description: "Enable automatic titles" },
        { value: "off", label: "off", description: "Disable automatic titles" },
        { value: "model ", label: "model", description: "Show or select the title model" },
        { value: "regenerate", label: "regenerate", description: "Generate a replacement title" },
        { value: "set ", label: "set <title>", description: "Set a title matching a subcommand name" },
      ]);
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const [action, ...rest] = input.split(/\s+/).filter(Boolean);

      try {
        const configActions = new Set(["status", "on", "off", "model", "regenerate", "set"]);
        if (action && !configActions.has(action)) {
          setTitle(ctx, input);
          return;
        }

        if (action === "set") {
          const title = rest.join(" ").trim();
          if (!title) throw new Error("usage: /title set <custom title>");
          setTitle(ctx, title);
          return;
        }

        const config = await loadConfig();
        if (!action || action === "status") {
          ctx.ui.notify(
            [
              `title: ${pi.getSessionName() ?? "none"}`,
              `enabled: ${config.enabled}`,
              `model: ${config.model ?? "active session model"}`,
              `config: ${configPath()}`,
            ].join("\n"),
            "info",
          );
          return;
        }

        if (action === "on" || action === "off") {
          config.enabled = action === "on";
          await saveConfig(config);
          ctx.ui.notify(`Automatic session titles ${config.enabled ? "enabled" : "disabled"}`, "info");
          return;
        }

        if (action === "model") {
          const reference = rest.join(" ").trim();
          if (!reference) {
            ctx.ui.notify(`Title model: ${config.model ?? "active session model"}`, "info");
            return;
          }
          if (reference !== "active" && reference !== "auto" && !splitModelReference(reference)) {
            throw new Error("usage: /title model <provider/model[:effort]|auto|active>");
          }
          config.model = reference === "active" ? null : reference;
          await saveConfig(config);
          ctx.ui.notify(`Title model: ${config.model ?? "active session model"}`, "info");
          return;
        }

        if (action === "regenerate") {
          if (backgroundGeneration) {
            generationController?.abort();
            await backgroundGeneration.catch(() => undefined);
          }
          const title = await generate(ctx, true);
          ctx.ui.notify(title ? `Session title: ${title}` : "No completed exchange to title", "info");
          return;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
