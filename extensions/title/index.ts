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

/** Why a title attempt failed, mapped to how the fallback chain reacts. */
export type TitleFailureKind =
  | "aborted"
  | "auth"
  | "billing"
  | "empty"
  | "invalid"
  | "network"
  | "not-found"
  | "rate-limit"
  | "server"
  | "unknown";

export interface TitleFailure {
  kind: TitleFailureKind;
  status?: number;
  /** Transient failures are worth one bounded retry when nothing else is left to try. */
  retryable: boolean;
  message: string;
}

export const FAILURE_LABELS: Record<TitleFailureKind, string> = {
  aborted: "aborted",
  auth: "authentication failed",
  billing: "insufficient credits",
  empty: "no usable title in the response",
  invalid: "invalid request",
  network: "network error",
  "not-found": "model not found",
  "rate-limit": "rate limited",
  server: "provider server error",
  unknown: "unknown error",
};

const TITLE_RETRY_BASE_DELAY_MS = 500;
const TITLE_RETRY_MAX_DELAY_MS = 4_000;

/** Retryable failures are transient: another attempt or another model may work. */
const RETRYABLE_FAILURES: ReadonlySet<TitleFailureKind> = new Set<TitleFailureKind>([
  "empty",
  "network",
  "rate-limit",
  "server",
]);

/**
 * Account, subscription, and quota exhaustion: deterministic limits, so another
 * attempt on the same model cannot succeed even when the provider reports them with
 * a retryable-looking status such as 429. These codes mirror the ones Pi's own
 * assistant retry classifier refuses to retry.
 */
const NON_RETRYABLE_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|insufficient credits|out of budget|quota exceeded|billing|payment required|subscription_sharing_usage_limit_exceeded/i;

/** Deterministic provider wording, checked before transient wording. */
const DETERMINISTIC_WORDING: ReadonlyArray<readonly [TitleFailureKind, RegExp]> = [
  ["auth", /unauthori|unauthoriz|forbidden|api key|invalid token|authentication/i],
  ["not-found", /not found|does not exist|no such model|unknown model|unsupported model/i],
  ["invalid", /invalid|malformed|bad request/i],
];

/**
 * Transient provider wording, mirroring the patterns Pi's assistant retry
 * classifier treats as retryable. Status numbers are deliberately absent so that
 * recognising a status stays context-aware; see `statusFromText`.
 */
const TRANSIENT_WORDING: ReadonlyArray<readonly [TitleFailureKind, RegExp]> = [
  [
    "rate-limit",
    /overloaded|currently experiencing high demand|rate.?limit|too many requests|you can retry your request|try your request again|please retry your request/i,
  ],
  [
    "network",
    /network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay/i,
  ],
  [
    "server",
    /service.?unavailable|server.?error|internal.?error|provider.?returned.?error|bad gateway|gateway timeout|exceeded request buffer limit while retrying upstream|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable|ResourceExhausted/i,
  ],
];

/** Explicit cancellation phrasing, not an arbitrary occurrence of "abort"/"cancel". */
const ABORT_PATTERNS: readonly RegExp[] = [
  /\bAbortError\b/,
  /\b(?:operation|request|fetch|stream|call|prompt)\s+(?:was\s+|is\s+|has been\s+)?(?:aborted|cancell?ed)\b/i,
  /\b(?:aborted|cancell?ed)\s+(?:by|due to)\s+(?:the\s+)?(?:user|caller|signal|request|client)\b/i,
];

/** The prefix the title call adds to a failed completion, removed before classification. */
const TITLE_ERROR_PREFIX = /^title model failed:\s*/;

/**
 * Extract a status from provider text, but only where a number is presented as one:
 * leading the message, after an `HTTP`/`status`/`code` prefix, or parenthesised. A
 * value that merely sits between whitespace is not a status — real provider text such
 * as `Invalid Azure OpenAI base URL: <value>` embeds a URL there — and a number inside
 * an identifier such as `model-500` is not one either.
 */
function statusFromText(message: string): number | undefined {
  const leading = /^\s*(?:http\s*)?([45]\d{2})\b/i.exec(message);
  if (leading) return Number(leading[1]);
  const prefixed = /\b(?:http|status(?:\s*code)?|code)\s*[:=]?\s*([45]\d{2})\b/i.exec(message);
  if (prefixed) return Number(prefixed[1]);
  const parenthesised = /\(([45]\d{2})\)/.exec(message);
  return parenthesised ? Number(parenthesised[1]) : undefined;
}

/**
 * Limit information can arrive as a structured code rather than in the message, for
 * example OpenAI's parsed `insufficient_quota` error body.
 */
function structuredCodes(error: unknown): string {
  const record = error as { code?: unknown; error?: { code?: unknown } } | null;
  return [record?.code, record?.error?.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/** Bounded exponential backoff, matching the shape of Pi's provider retry policy. */
export function titleRetryDelayMs(attempt: number): number {
  return Math.min(TITLE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), TITLE_RETRY_MAX_DELAY_MS);
}

function sleepTitleRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function kindFromStatus(status: number): TitleFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "not-found";
  if (status === 408 || status === 409 || status === 425 || status === 429) return "rate-limit";
  if (status >= 500) return "server";
  if (status === 400 || status === 422) return "invalid";
  return "unknown";
}

/**
 * Classify a failed title attempt so the chain can choose between a bounded retry,
 * another model, or giving up.
 *
 * Precedence is deliberate:
 * 1. explicit cancellation wording is terminal;
 * 2. an empty completion is retryable;
 * 3. account/quota exhaustion is deterministic even when reported as 429, because
 *    another attempt cannot succeed;
 * 4. a structured status carried by the provider error is authoritative;
 * 5. a status stated in the message text is used when the message presents one (a
 *    leading code, an `HTTP`/`status`/`code` prefix, or a parenthesised code);
 * 6. wording decides last, deterministic wording before transient wording, so
 *    "Provider returned error" cannot turn an explicit 400 into a retry.
 *
 * The title call prefixes a failed completion with "title model failed: " to add context.
 * That prefix is removed before reading a status, because the provider's status is only a
 * status while it still leads the message — wrapped, a "400:" would fall through to
 * wording and a deterministic failure would be retried.
 *
 * Pi's provider retry helper defaults `maxRetries` to 0 and this call path passes no
 * budget, so the extension performs its own bounded retry rather than relying on
 * retries that never happen.
 */
export function classifyTitleFailure(error: unknown): TitleFailure {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.replace(TITLE_ERROR_PREFIX, "");

  if (ABORT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "aborted", retryable: false, message };
  }

  if (/returned no usable text/i.test(text)) {
    return { kind: "empty", retryable: true, message };
  }

  if (NON_RETRYABLE_LIMIT_PATTERN.test(text) || NON_RETRYABLE_LIMIT_PATTERN.test(structuredCodes(error))) {
    return { kind: "billing", retryable: false, message };
  }

  const structured = typeof (error as { status?: unknown } | null)?.status === "number"
    ? (error as { status: number }).status
    : undefined;
  const status = structured ?? statusFromText(text);

  const wording = [...DETERMINISTIC_WORDING, ...TRANSIENT_WORDING]
    .find(([, expression]) => expression.test(text));
  const kind = status !== undefined ? kindFromStatus(status) : wording?.[0] ?? "unknown";

  return {
    kind,
    retryable: RETRYABLE_FAILURES.has(kind),
    ...(status !== undefined ? { status } : {}),
    message,
  };
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

function describeTitleFailures(
  failures: ReadonlyArray<{ candidate: TitleModelCandidate; failure: TitleFailure }>,
): string {
  const attempts = failures.map(({ candidate, failure }) =>
    `${candidate.model.provider}/${candidate.model.id} (${FAILURE_LABELS[failure.kind]})`);
  const last = failures.at(-1)?.failure.message;
  return last ? `${attempts.join("; ")}: ${last}` : attempts.join("; ");
}

function notifyModelFallback(
  ctx: ExtensionContext,
  config: Config,
  chain: TitleModelChain,
  candidate: TitleModelCandidate,
  failure: TitleFailure | undefined,
): void {
  // Reporting is cosmetic and this runs after an awaited model call, so a context that
  // was invalidated while the request was in flight must not turn the report into a
  // failure of a title that was already written.
  try {
    if (!ctx.hasUI) return;
    const requested = config.model ?? "active session model";
    const used = `${candidate.model.provider}/${candidate.model.id}`;
    const reason = chain.configuredFailure
      ? "is unavailable"
      : failure ? `failed (${FAILURE_LABELS[failure.kind]})` : "could not be used";
    ctx.ui.notify(`Configured title model ${requested} ${reason}; used ${used}`, "warning");
  } catch {
    // Ignore: the session may have been replaced while the model was answering.
  }
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
  /** Completed user turns at the last automatic evaluation. */
  let lastEvaluatedTurns = 0;
  /** Set when the session arrived named, or the user named it. */
  let pinned = false;

  function isStaleContextError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith("This extension ctx is stale");
  }

  function applyTerminalTitle(ctx: ExtensionContext, title?: string): void {
    // The terminal title is cosmetic, and this runs both after awaited work and from a
    // timer, so a replaced session must not turn it into a failure or an unhandled throw.
    // The name is read inside the guard: as a default parameter it would be evaluated at
    // call time, before any of this could catch it.
    try {
      const name = title ?? pi.getSessionName();
      if (ctx.hasUI && name) ctx.ui.setTitle(name);
    } catch {
      // Ignore: the session may have been replaced.
    }
  }

  function setTitle(ctx: ExtensionContext, title: string): void {
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
      // applyTerminalTitle tolerates a context invalidated before the next session event
      // cancels this timer.
      applyTerminalTitle(ctx);
    }, 0);
  }

  async function generate(
    ctx: ExtensionContext,
    overwrite: boolean,
    source: TitleRequestSource | undefined = initialSource(ctx.sessionManager.getBranch()),
    expectedName?: string,
  ): Promise<string | undefined> {
    if (generating || (!overwrite && pi.getSessionName()) || !source) return undefined;
    // A refresh may only replace the title this extension wrote itself, and only while
    // the session is still unpinned.
    if (expectedName !== undefined && (pinned || pi.getSessionName() !== expectedName)) return undefined;

    generating = true;
    const controller = new AbortController();
    generationController = controller;
    const expectedLifecycle = lifecycle;
    try {
      const config = await loadConfig();
      if (!config.enabled && !overwrite) return undefined;

      const chain = resolveModelChain(ctx, config);
      if (chain.candidates.length === 0) throw new Error("no title model is available");

      const request = buildTitleRequest(source);
      const failures: Array<{ candidate: TitleModelCandidate; failure: TitleFailure }> = [];
      let lastError: unknown;
      let degraded = false;

      for (let index = 0; index < chain.candidates.length; index += 1) {
        const candidate = chain.candidates[index]!;
        // An earlier failure moves straight to the next model because an untried
        // model is the better bet; a transient failure on the last candidate is
        // retried once instead of giving up on the only option left.
        const maxAttempts = index === chain.candidates.length - 1 ? 2 : 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (controller.signal.aborted || lifecycle !== expectedLifecycle) return undefined;
          try {
            const response = await completeTitle(
              ctx,
              candidate.model,
              request,
              config,
              candidate.thinkingLevel,
              controller.signal,
            );

            if (controller.signal.aborted || lifecycle !== expectedLifecycle) return undefined;
            const title = titleFromCompletion(response, config.maxLength);
            if (!overwrite && pi.getSessionName()) return undefined;
            if (expectedName !== undefined && (pinned || pi.getSessionName() !== expectedName)) return undefined;

            lastAutoName = title;
            pi.setSessionName(title);
            applyTerminalTitle(ctx, title);
            deferTerminalTitle(ctx);
            if (candidate.source === "session") {
              // Explain the configured model's failure, not a later failure of the
              // model that was used as the fallback.
              const replaced = failures.find(({ candidate: failed }) => failed.source === "configured")?.failure;
              notifyModelFallback(ctx, config, chain, candidate, replaced);
            }
            return title;
          } catch (error) {
            if (controller.signal.aborted) return undefined;
            // The background handler suppresses stale-context errors by message;
            // classifying or aggregating one would hide that and make the handler
            // read an already-invalid context.
            if (isStaleContextError(error)) throw error;
            const failure = classifyTitleFailure(error);
            if (failure.kind === "aborted") return undefined;
            lastError = error;
            failures.push({ candidate, failure });
            if (failure.retryable && attempt < maxAttempts) {
              degraded = true;
              await sleepTitleRetry(titleRetryDelayMs(attempt), controller.signal);
              continue;
            }
            break;
          }
        }

        if (index < chain.candidates.length - 1) degraded = true;
      }

      // A single attempt on a single model keeps the original error untouched.
      if (!degraded) throw lastError;
      throw new Error(`title model failed: ${describeTitleFailures(failures)}`);
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
    source: TitleRequestSource | undefined,
    overwrite = false,
    expectedName?: string,
  ): boolean {
    // `generating` is set by an explicit regeneration as well, which is not tracked by
    // `backgroundGeneration`; either one means no new request was started here.
    if (backgroundGeneration || generating) return false;

    const expectedLifecycle = lifecycle;
    const request = generate(ctx, overwrite, source, expectedName);
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

  /**
   * Decide whether this turn should write a title. The first completed turn keeps the
   * existing behaviour, and later turns retitle once every `refreshTurns` completed
   * turns, so a session that drifted from its opening request is named for what it
   * became. A name the extension did not write is never replaced.
   */
  async function evaluateAutomatic(
    ctx: ExtensionContext,
    branch: Parameters<typeof firstCompletedExchange>[0],
  ): Promise<void> {
    const expectedLifecycle = lifecycle;
    try {
      if (pinned) return;

      const config = await loadConfig();
      // Reading the configuration is asynchronous: the session may have been named,
      // replaced, or invalidated in the meantime, and a malformed file rejects here.
      if (lifecycle !== expectedLifecycle || pinned) return;

      const current = pi.getSessionName();
      if (current !== undefined && current !== lastAutoName) {
        pinned = true;
        return;
      }

      const turns = countCompletedExchanges(branch);
      if (lastAutoName === undefined) {
        // The attempt from before the turn started has not landed; title from the first
        // completed exchange instead, as before.
        if (turns < 1) return;
        if (generateInBackground(ctx, initialSource(branch))) lastEvaluatedTurns = turns;
        return;
      }

      // A title written from the opening request anchors the cadence at the first turn.
      // Without this the anchor stays at zero while a title already exists, and the first
      // refresh lands one turn early, which is not what `refreshTurns` promises.
      if (lastEvaluatedTurns === 0) lastEvaluatedTurns = 1;

      if (!config.enabled || config.refreshTurns === 0) return;
      if (turns < lastEvaluatedTurns + config.refreshTurns) return;

      const transcript = recentTranscript(branch);
      if (!transcript) return;

      // Only the extension's own title may be replaced, and only while it is still the
      // current name when the request lands. The cadence advances only when a request
      // actually started, so a busy slot is not silently consumed.
      if (generateInBackground(ctx, { kind: "refresh", transcript }, true, lastAutoName)) {
        lastEvaluatedTurns = turns;
      }
    } catch (error) {
      reportBackgroundFailure(ctx, expectedLifecycle, error);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    completionContext = ctx;
    resetGeneration();
    lastAutoName = undefined;
    lastEvaluatedTurns = 0;
    // An existing name has no source we can verify, so it is treated as the user's and
    // this session is left alone. `/title regenerate` still replaces it on request.
    pinned = pi.getSessionName() !== undefined;
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

  pi.on("before_agent_start", (event, ctx) => {
    if (pinned) return;
    generateInBackground(ctx, { kind: "initial", user: event.prompt });
  });

  pi.on("session_tree", (_event, ctx) => {
    // The active branch changed, so the cadence is rebased on the branch that is now
    // active and any refresh from the abandoned branch is dropped.
    resetGeneration();
    const branch = ctx.sessionManager.getBranch();
    lastEvaluatedTurns = countCompletedExchanges(branch);
    // Discarding the previous work may have cancelled the only attempt to name a
    // still-unnamed session, so let the active branch produce one. Rebasing first
    // means this can only be the initial evaluation, never an immediate refresh.
    void evaluateAutomatic(ctx, branch);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // The turn is over, which is the boundary a refresh cadence counts.
    void evaluateAutomatic(ctx, ctx.sessionManager.getBranch());
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
