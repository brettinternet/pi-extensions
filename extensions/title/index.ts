import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArguments, completeModelArgument } from "./completions.ts";
import { configPath, loadConfig, saveConfig, type Config } from "./config.js";
import { cleanTitle, countCompletedExchanges, firstCompletedExchange, recentTranscript, TITLE_SYSTEM_PROMPT } from "./title.js";

type TitleSource = { user: string; assistant?: string };

/** What the model is asked to title: the opening request, or a later refresh. */
type TitleRequestSource =
  | ({ kind: "initial" } & TitleSource)
  | { kind: "refresh"; transcript: string };

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

/** A model the title can be generated with, in fallback order. */
export interface TitleModelCandidate {
  model: TitleModel;
  thinkingLevel?: ThinkingLevel;
  /** `configured` is the requested model, `session` is the fallback. */
  source: "configured" | "session";
}

export interface TitleModelChain {
  candidates: TitleModelCandidate[];
  /** Why the configured model could not be used at all, when it could not. */
  configuredFailure?: string;
}

function sameModel(left: TitleModel, right: TitleModel): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Build the ordered title model chain: the configured model first, then the
 * active session model as a fallback. A configured model that cannot be
 * resolved at all is recorded and skipped instead of aborting the attempt.
 */
export function resolveModelChain(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: Config,
): TitleModelChain {
  const candidates: TitleModelCandidate[] = [];
  let configuredFailure: string | undefined;

  if (config.model) {
    try {
      const { model, thinkingLevel } = resolveModel(ctx, config);
      if (model) candidates.push({ model, thinkingLevel, source: "configured" });
    } catch (error) {
      configuredFailure = error instanceof Error ? error.message : String(error);
    }
  }

  const sessionModel = ctx.model;
  if (sessionModel && !candidates.some((candidate) => sameModel(candidate.model, sessionModel))) {
    candidates.push({ model: sessionModel, source: config.model ? "session" : "configured" });
  }

  return { candidates, ...(configuredFailure ? { configuredFailure } : {}) };
}

function buildTitleRequest(source: TitleRequestSource): TitleRequest {
  const body = source.kind === "initial"
    ? [
        "--- First user request ---",
        source.user.slice(0, 4800),
        ...(source.assistant
          ? ["--- First assistant response ---", source.assistant.slice(0, 2400)]
          : []),
      ]
    : ["--- Recent session transcript ---", source.transcript];

  return {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [...body, "--- End session data ---"].join("\n"),
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };
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
  return ctx.modelRegistry
    .streamSimple(model, request, {
      ...completionOptions(config, thinkingLevel),
      signal,
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
  response: {
    content: Array<{ type: string; text?: string }>;
    stopReason: string;
    errorMessage?: string;
  },
  maxLength: number,
): string {
  if (response.stopReason === "error" && response.errorMessage) {
    throw new Error(`title model failed: ${response.errorMessage}`);
  }

  const title = cleanTitle(completionText(response.content), maxLength);
  if (!title) throw new Error(`title model returned no usable text (stop reason: ${response.stopReason})`);
  return title;
}

const TITLE_ENTRY = "pi-title";
type TitleEntry = { title: string };

/** Whether the current name was the latest write recorded by this extension. */
function isRecordedAutomaticName(
  entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
  name: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "session_info") return false;
    if (entry.type === "custom" && entry.customType === TITLE_ENTRY) {
      return (entry.data as TitleEntry | undefined)?.title === name;
    }
  }
  return false;
}

/** The opening exchange gives a one-exchange session more context than the bounded transcript. */
function latestSource(
  entries: Parameters<typeof firstCompletedExchange>[0],
): TitleRequestSource | undefined {
  const transcript = countCompletedExchanges(entries) > 1 ? recentTranscript(entries) : undefined;
  return transcript ? { kind: "refresh", transcript } : initialSource(entries);
}

function initialSource(
  entries: Parameters<typeof firstCompletedExchange>[0],
): TitleRequestSource | undefined {
  const exchange = firstCompletedExchange(entries);
  return exchange ? { kind: "initial", ...exchange } : undefined;
}

export default function titleExtension(pi: ExtensionAPI) {
  let generating = false;
  let generationController: AbortController | undefined;
  let backgroundGeneration: Promise<string | undefined> | undefined;
  let lifecycle = 0;
  let completionContext: ExtensionContext | undefined;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last title this extension wrote, to tell its own writes from the user's. */
  let lastAutoName: string | undefined;
  /** Completed exchanges when the last automatic request started. */
  let lastEvaluatedTurns = 0;
  /** Set when the session arrived named, or the user named it. */
  let pinned = false;

  function isStaleContextError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith("This extension ctx is stale");
  }

  function applyTerminalTitle(ctx: ExtensionContext, title = pi.getSessionName()): void {
    if (ctx.hasUI && title) ctx.ui.setTitle(title);
  }

  function canWriteAutomatic(): boolean {
    return !pinned && pi.getSessionName() === lastAutoName;
  }

  function setTitle(ctx: ExtensionContext, title: string): void {
    pinned = true;
    pi.setSessionName(title);
    applyTerminalTitle(ctx, title);
    deferTerminalTitle(ctx);
    ctx.ui.notify(`Session title: ${title}`, "info");
  }

  function deferTerminalTitle(ctx: ExtensionContext): void {
    if (titleTimer) clearTimeout(titleTimer);
    const expectedLifecycle = lifecycle;
    titleTimer = setTimeout(() => {
      titleTimer = undefined;
      if (lifecycle !== expectedLifecycle) return;
      try {
        applyTerminalTitle(ctx);
      } catch (error) {
        // Session replacement can invalidate ctx before the next session event cancels this timer.
        if (!isStaleContextError(error)) throw error;
      }
    }, 0);
  }

  async function generate(
    ctx: ExtensionContext,
    config: Config,
    source: TitleRequestSource | undefined,
    mode: "automatic" | "explicit" = "automatic",
  ): Promise<string | undefined> {
    if (generating || !source) return undefined;
    if (mode === "automatic" && (!config.enabled || !canWriteAutomatic())) return undefined;

    generating = true;
    const controller = new AbortController();
    generationController = controller;
    const expectedLifecycle = lifecycle;
    try {
      const chain = resolveModelChain(ctx, config);
      if (chain.candidates.length === 0) {
        throw new Error(chain.configuredFailure ?? "no title model is available");
      }

      const request = buildTitleRequest(source);
      const failures: string[] = chain.configuredFailure ? [chain.configuredFailure] : [];
      let lastError: unknown;
      for (const candidate of chain.candidates) {
        if (controller.signal.aborted || lifecycle !== expectedLifecycle) return undefined;
        if (mode === "automatic" && !canWriteAutomatic()) return undefined;

        let title: string;
        try {
          const response = await completeTitle(
            ctx, candidate.model, request, config, candidate.thinkingLevel, controller.signal,
          );
          if (controller.signal.aborted || lifecycle !== expectedLifecycle ||
              response.stopReason === "aborted") return undefined;
          title = titleFromCompletion(response, config.maxLength);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (controller.signal.aborted || lifecycle !== expectedLifecycle ||
              (error instanceof Error && error.name === "AbortError")) return undefined;
          if (isStaleContextError(error)) throw error;
          lastError = error;
          failures.push(`${candidate.model.provider}/${candidate.model.id}: ${message}`);
          continue;
        }

        // Only model failures advance the chain; session/UI errors must not issue another request.
        if (mode === "automatic" && !canWriteAutomatic()) return undefined;
        lastAutoName = title;
        pi.setSessionName(title);
        // Lets a resumed session recognize this name as automatic and keep refreshing it.
        if (!pinned) pi.appendEntry<TitleEntry>(TITLE_ENTRY, { title });
        applyTerminalTitle(ctx, title);
        deferTerminalTitle(ctx);
        if (candidate.source === "session" && ctx.hasUI) {
          ctx.ui.notify(
            `Title model fallback: ${failures.join("; ")}; used ${candidate.model.provider}/${candidate.model.id}`,
            "warning",
          );
        }
        return title;
      }

      if (failures.length === 1) throw lastError;
      throw new Error(`title model failed: ${failures.join("; ")}`);
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

  /** Report a background failure the same way wherever an attempt was started. */
  function reportBackgroundFailure(ctx: ExtensionContext, expectedLifecycle: number, error: unknown): void {
    if (lifecycle !== expectedLifecycle || isStaleContextError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.warn(`[pi-title] ${message}`);
    } catch {
      // Reading the context can fail once it has been invalidated; never let that
      // escape as an unhandled rejection.
      console.warn(`[pi-title] ${message}`);
    }
  }

  /** Returns whether a request was started, so callers can avoid consuming a slot. */
  function generateInBackground(
    ctx: ExtensionContext,
    config: Config,
    source: TitleRequestSource | undefined,
  ): boolean {
    if (backgroundGeneration || generating || !source) return false;

    const expectedLifecycle = lifecycle;
    const request = generate(ctx, config, source);
    backgroundGeneration = request;
    void request
      .catch((error) => {
        reportBackgroundFailure(ctx, expectedLifecycle, error);
      })
      .finally(() => {
        if (backgroundGeneration === request) backgroundGeneration = undefined;
      });
    return true;
  }

  function resetGeneration(): void {
    lifecycle += 1;
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = undefined;
    generationController?.abort();
    generationController = undefined;
    backgroundGeneration = undefined;
    generating = false;
  }

  async function evaluateAutomatic(ctx: ExtensionContext, openingRequest?: string): Promise<void> {
    const expectedLifecycle = lifecycle;
    try {
      if (!canWriteAutomatic() || generating || backgroundGeneration) return;
      if (openingRequest !== undefined && lastAutoName !== undefined) return;

      const branch = ctx.sessionManager.getBranch();
      const config = await loadConfig();
      if (lifecycle !== expectedLifecycle || !config.enabled || !canWriteAutomatic()) return;

      const turns = countCompletedExchanges(branch);
      if (lastAutoName === undefined) {
        const source = openingRequest === undefined
          ? initialSource(branch)
          : { kind: "initial" as const, user: openingRequest };
        if (generateInBackground(ctx, config, source)) {
          // The opening exchange anchors the cadence even before its answer arrives.
          lastEvaluatedTurns = Math.max(1, turns);
        }
        return;
      }

      if (config.refreshTurns === 0 || turns < lastEvaluatedTurns + config.refreshTurns) return;
      const transcript = recentTranscript(branch);
      if (transcript && generateInBackground(ctx, config, { kind: "refresh", transcript })) {
        lastEvaluatedTurns = turns;
      }
    } catch (error) {
      reportBackgroundFailure(ctx, expectedLifecycle, error);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    completionContext = ctx;
    resetGeneration();
    // A resumed automatic title keeps refreshing, rebased on the active branch. Any other
    // existing name is treated as the user's. `/title regenerate` still replaces it on request.
    const name = pi.getSessionName();
    const automatic = name !== undefined && isRecordedAutomaticName(ctx.sessionManager.getEntries(), name);
    lastAutoName = automatic ? name : undefined;
    lastEvaluatedTurns = automatic ? countCompletedExchanges(ctx.sessionManager.getBranch()) : 0;
    pinned = name !== undefined && !automatic;
    deferTerminalTitle(ctx);

  });

  pi.on("session_shutdown", () => {
    completionContext = undefined;
    resetGeneration();
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (event.name !== undefined && event.name !== lastAutoName) pinned = true;
    deferTerminalTitle(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => evaluateAutomatic(ctx, event.prompt));

  pi.on("session_tree", (_event, ctx) => {
    // The active branch changed, so the cadence is rebased on the branch that is now
    // active and any refresh from the abandoned branch is dropped.
    resetGeneration();
    const branch = ctx.sessionManager.getBranch();
    lastEvaluatedTurns = countCompletedExchanges(branch);
    // Discarding the previous work may have cancelled the only attempt to name a
    // still-unnamed session, so let the active branch produce one. Rebasing first
    // means this can only be the initial evaluation, never an immediate refresh.
    return evaluateAutomatic(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => evaluateAutomatic(ctx));

  pi.registerCommand("title", {
    description: "[status | on | off | model [provider/model[:thinking]|auto|active] | every [turns|off] | regenerate | set <title>] — Set or configure titles",
    getArgumentCompletions: (prefix) => {
      if (/^every\s/i.test(prefix)) {
        return completeArguments(prefix, [
          { value: "every off", label: "off", description: "Title once" },
          ...[1, 2, 4, 8].map((turns) => ({
            value: `every ${turns}`,
            label: String(turns),
            description: `Refresh every ${turns} answered turn${turns === 1 ? "" : "s"}`,
          })),
        ]);
      }
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
        { value: "every ", label: "every", description: "Show or set the refresh interval" },
        { value: "regenerate", label: "regenerate", description: "Generate a replacement title" },
        { value: "set ", label: "set <title>", description: "Set a title matching a subcommand name" },
      ]);
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const [action, ...rest] = input.split(/\s+/).filter(Boolean);

      try {
        const configActions = new Set(["status", "on", "off", "model", "every", "regenerate", "set"]);
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
              `refresh turns: ${config.refreshTurns}`,
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

        if (action === "every") {
          const value = rest.join(" ").trim();
          if (value) {
            const turns = value === "off" ? 0 : Number(value);
            if (!/^(\d+|off)$/.test(value) || !Number.isSafeInteger(turns)) {
              throw new Error("usage: /title every <turns|off>");
            }
            config.refreshTurns = turns;
            await saveConfig(config);
          }
          ctx.ui.notify(
            config.refreshTurns === 0
              ? "Title refresh: off"
              : `Title refresh: every ${config.refreshTurns} answered turn${config.refreshTurns === 1 ? "" : "s"}`,
            "info",
          );
          return;
        }

        if (action === "regenerate") {
          if (backgroundGeneration) {
            generationController?.abort();
            await backgroundGeneration.catch(() => undefined);
          }
          const title = await generate(ctx, config, latestSource(ctx.sessionManager.getBranch()), "explicit");
          ctx.ui.notify(title ? `Session title: ${title}` : "No completed exchange to title", "info");
          return;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
