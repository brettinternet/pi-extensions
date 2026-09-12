import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const LOOP_STATE_ENTRY = "pi-loop-state-v1";
export const LOOP_WIDGET_KEY = "pi-loop";
export const LOOP_USAGE =
  "usage: /loop <positive-count> [--delay <duration>] <prompt> | /loop for <duration> --delay <duration> <prompt> | /loop <positive-count> | /loop <+|-><count> | /loop delay <duration> | /loop prompt <text> | /loop append <text> | /loop status | /loop resume | /loop next | /loop end";

export const MIN_LOOP_DELAY_MS = 1_000;
export const MAX_LOOP_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_LOOP_TIMEFRAME_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_LOOP_RETRIES = 3;
export const DEFAULT_LOOP_RETRY_DELAY_MS = 30_000;

const LOOP_CONTINUATION_PROMPT =
  "Continue the current loop iteration from where you left off without repeating completed work.";
const LOOP_AGENT_GUIDANCE = `## Active Loop

This session is part of an active unattended loop. If no useful work can continue without human input, credentials, permissions, or another non-transient external dependency, call loop_pause with the blocker. Do not pause for a temporary condition expected to resolve in a later iteration.`;

export type LoopStatus = "active" | "stopping" | "paused" | "completed" | "stopped" | "inactive";
export type LoopPhase = "running" | "waiting" | "retrying";

export interface LoopState {
  version: 1;
  runId: string;
  prompt: string;
  currentIteration: number;
  remainingBudget: number;
  pendingRetune: number | null;
  delay: number;
  status: LoopStatus;
  retryCount?: number;
  phase?: LoopPhase;
  nextActionAt?: number;
  settledAt?: number;
  endsAt?: number;
  pauseReason?: string;
  pausedAt?: number;
  ownerSessionId?: string;
  ownerSessionFile?: string;
}

export type ParsedLoopCommand =
  | { kind: "start"; count: number; delay: number; prompt: string }
  | { kind: "startTimed"; duration: number; delay: number; prompt: string }
  | { kind: "retune"; count: number }
  | { kind: "adjust"; delta: number }
  | { kind: "delay"; delay: number }
  | { kind: "replacePrompt"; prompt: string }
  | { kind: "appendPrompt"; prompt: string }
  | { kind: "status" }
  | { kind: "resume" }
  | { kind: "next" }
  | { kind: "end" }
  | { kind: "continue"; runId: string; iteration: number }
  | { kind: "pause"; runId: string; iteration: number };

const ACTIVE_STATUSES = new Set<LoopStatus>(["active", "stopping"]);
const VISIBLE_STATUSES = new Set<LoopStatus>(["active", "stopping", "paused"]);
const TERMINAL_STATUSES = new Set<LoopStatus>(["completed", "stopped", "inactive"]);

type ArgumentCompletion = { value: string; label: string; description?: string };

function completeArguments(
  prefix: string,
  candidates: readonly ArgumentCompletion[],
): ArgumentCompletion[] | null {
  const query = prefix.trimStart().toLowerCase();
  const matches = candidates.filter(({ value }) => value.toLowerCase().includes(query));
  return matches.length > 0 ? matches : null;
}

const COMMON_LOOP_DELAYS = ["off", "1s", "5s", "10s", "30s", "1m", "5m", "1h", "24h"] as const;
const COMMON_LOOP_TIMEFRAMES = ["1h", "4h", "8h", "12h", "24h", "2d", "7d"] as const;

function delayCompletions(
  prefix: string,
  command: string,
  values: readonly string[] = COMMON_LOOP_DELAYS,
  separator = " ",
): ArgumentCompletion[] | null {
  return completeArguments(prefix, values.map((value) => ({
    value: `${command}${separator}${value}`,
    label: `${command}${separator}${value}`,
    description: "Set the delay between settled iterations",
  })));
}

function completeLoopArguments(prefix: string): ArgumentCompletion[] | null {
  const input = prefix.trimStart();
  const delayCommand = /^(delay|--delay)(?:\s+(.*))?$/.exec(input);
  if (delayCommand?.[2] !== undefined) return delayCompletions(prefix, delayCommand[1]);

  const timedDelay = /^for\s+(\S+)\s+--delay(=|\s+)?(.*)$/.exec(input);
  if (timedDelay) {
    if (timedDelay[2] !== undefined) {
      const equals = timedDelay[2] === "=";
      return delayCompletions(
        prefix,
        `for ${timedDelay[1]} --delay${equals ? "=" : ""}`,
        COMMON_LOOP_DELAYS.filter((value) => value !== "off"),
        equals ? "" : " ",
      );
    }
    return [{
      value: `for ${timedDelay[1]} --delay `,
      label: `for ${timedDelay[1]} --delay <duration>`,
      description: "Set the required delay between timed-loop iterations",
    }];
  }

  const timedPrefix = /^for(?:\s+(.*))?$/.exec(input);
  if (timedPrefix) {
    const durationPrefix = timedPrefix[1] ?? "";
    const exactDuration = COMMON_LOOP_TIMEFRAMES.find((value) => durationPrefix.trim() === value);
    if (exactDuration && /\s$/.test(durationPrefix)) {
      return [{
        value: `for ${exactDuration} --delay `,
        label: `for ${exactDuration} --delay <duration> <prompt>`,
        description: `Run until ${exactDuration} elapses`,
      }];
    }
    return completeArguments(durationPrefix, COMMON_LOOP_TIMEFRAMES.map((value) => ({
      value: `for ${value} `,
      label: `for ${value} --delay <duration> <prompt>`,
      description: `Run until ${value} elapses`,
    })));
  }

  const countDelay = /^(\d+)\s+--delay(=|\s+)?(.*)$/.exec(input);
  if (countDelay) {
    if (countDelay[2] !== undefined) {
      const equals = countDelay[2] === "=";
      return delayCompletions(
        prefix,
        `${countDelay[1]} --delay${equals ? "=" : ""}`,
        COMMON_LOOP_DELAYS,
        equals ? "" : " ",
      );
    }
    return [{
      value: `${countDelay[1]} --delay `,
      label: `${countDelay[1]} --delay <duration>`,
      description: "Set the delay between settled iterations for this loop",
    }];
  }

  const countPrefix = /^(\d+)\s+$/.exec(input);
  if (countPrefix) {
    return [
      { value: `${countPrefix[1]} `, label: `${countPrefix[1]} <prompt>`, description: `Run a prompt ${countPrefix[1]} time${countPrefix[1] === "1" ? "" : "s"}` },
      { value: `${countPrefix[1]} --delay `, label: `${countPrefix[1]} --delay <duration>`, description: "Set the delay between settled iterations for this loop" },
    ];
  }

  return completeArguments(prefix, [
    { value: "status", label: "status", description: "Show the current loop state" },
    { value: "resume", label: "resume", description: "Retry a paused iteration" },
    { value: "next", label: "next", description: "Skip a paused iteration and start the next one" },
    { value: "end", label: "end", description: "End the loop gracefully" },
    { value: "delay ", label: "delay <duration>", description: "Set the delay between settled iterations" },
    { value: "prompt ", label: "prompt <text>", description: "Replace the future loop prompt" },
    { value: "append ", label: "append <text>", description: "Append to the future loop prompt" },
    { value: "for ", label: "for <duration> --delay <duration> <prompt>", description: "Run until a wall-clock deadline" },
    { value: "+1", label: "+1", description: "Add one future iteration" },
    { value: "-1", label: "-1", description: "Remove one future iteration" },
    { value: "1 ", label: "1 <prompt>", description: "Run a prompt once" },
    { value: "3 ", label: "3 <prompt>", description: "Run a prompt three times" },
    { value: "5 ", label: "5 <prompt>", description: "Run a prompt five times" },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidLoopDelay(value: unknown): value is number {
  return isNonNegativeInteger(value) &&
    (value === 0 || (value >= MIN_LOOP_DELAY_MS && value <= MAX_LOOP_DELAY_MS));
}

const LOOP_DURATION_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h|d)$/;
const LOOP_DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 24 * 3_600_000,
};

function parseDuration(value: string, label: string, maximum: number, maximumLabel: string): number {
  const match = LOOP_DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`${label} must be a duration such as 1s, 5m, 4h, or 1d`);
  }
  const milliseconds = Number(match[1]) * LOOP_DURATION_MULTIPLIERS[match[2]];
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_LOOP_DELAY_MS) {
    throw new Error(`${label} must be at least 1s`);
  }
  if (milliseconds > maximum) {
    throw new Error(`${label} must not exceed ${maximumLabel}`);
  }
  return Math.round(milliseconds);
}

export function parseLoopDuration(value: string): number {
  if (value.trim() === "off") return 0;
  return parseDuration(value, "delay", MAX_LOOP_DELAY_MS, "24h");
}

export function parseLoopTimeframe(value: string): number {
  return parseDuration(value, "timeframe", MAX_LOOP_TIMEFRAME_MS, "30d");
}

export function formatLoopDelay(delay: number): string {
  if (delay === 0) return "off";
  if (delay % (24 * 3_600_000) === 0) return `${delay / (24 * 3_600_000)}d`;
  if (delay % 3_600_000 === 0) return `${delay / 3_600_000}h`;
  if (delay % 60_000 === 0) return `${delay / 60_000}m`;
  if (delay % 1_000 === 0) return `${delay / 1_000}s`;
  return `${delay}ms`;
}

/** Parse public and internal /loop arguments without consulting current run state. */
export function parseLoopCommand(args: string): ParsedLoopCommand {
  const input = args.trim();
  if (!input) return { kind: "end" };

  const firstSpace = input.search(/\s/);
  const first = firstSpace < 0 ? input : input.slice(0, firstSpace);
  const rest = firstSpace < 0 ? "" : input.slice(firstSpace).trim();

  if (first === "status") {
    if (rest) throw new Error(`status does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "status" };
  }
  if (first === "end") {
    if (rest) throw new Error(`end does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "end" };
  }
  if (first === "resume") {
    if (rest) throw new Error(`resume does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "resume" };
  }
  if (first === "next") {
    if (rest) throw new Error(`next does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "next" };
  }
  if (first === "delay") {
    const fields = rest.split(/\s+/).filter(Boolean);
    if (fields.length !== 1) throw new Error(`delay requires one duration; ${LOOP_USAGE}`);
    return { kind: "delay", delay: parseLoopDuration(fields[0]) };
  }
  if (first === "prompt" || first === "append") {
    if (!rest) throw new Error(`${first} requires text; ${LOOP_USAGE}`);
    return first === "prompt"
      ? { kind: "replacePrompt", prompt: rest }
      : { kind: "appendPrompt", prompt: rest };
  }
  if (first === "for") {
    const timed = /^(\S+)\s+--delay(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
    if (!timed) {
      throw new Error(`timed loops require: for <duration> --delay <duration> <prompt>; ${LOOP_USAGE}`);
    }
    const duration = parseLoopTimeframe(timed[1]);
    const delay = parseLoopDuration(timed[2]);
    const prompt = timed[3]?.trim() ?? "";
    if (delay === 0) throw new Error(`timed loops require a non-zero --delay; ${LOOP_USAGE}`);
    if (!prompt) throw new Error(`a prompt is required after --delay; ${LOOP_USAGE}`);
    return { kind: "startTimed", duration, delay, prompt };
  }

  // These commands are only emitted by the extension itself. Keeping them in
  // the same dispatcher gives boundary transitions command-only session APIs
  // while preventing user input from accidentally looking like one.
  if (first === "__continue" || first === "__pause") {
    const fields = rest.split(/\s+/).filter(Boolean);
    if (fields.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(fields[0])) {
      throw new Error("invalid internal loop command");
    }
    const iteration = Number(fields[1]);
    if (!isPositiveInteger(iteration) || !/^\d+$/.test(fields[1])) {
      throw new Error("invalid internal loop command iteration");
    }
    return first === "__continue"
      ? { kind: "continue", runId: fields[0], iteration }
      : { kind: "pause", runId: fields[0], iteration };
  }

  if (/^[+\-]\d/.test(first)) {
    if (rest || !/^[+\-]\d+$/.test(first)) {
      throw new Error(`adjustment must be +<count> or -<count>; ${LOOP_USAGE}`);
    }
    const count = Number(first.slice(1));
    if (!isPositiveInteger(count)) throw new Error(`count must be a positive integer; ${LOOP_USAGE}`);
    return { kind: "adjust", delta: first[0] === "+" ? count : -count };
  }

  // Treat anything that starts like a count as a count error, rather than as
  // an opaque command, so zero, decimals, and overflow are explicit.
  if (/^\d/.test(first)) {
    if (!/^\d+$/.test(first)) throw new Error(`count must be a positive integer; ${LOOP_USAGE}`);
    const count = Number(first);
    if (!isPositiveInteger(count)) throw new Error(`count must be a positive integer; ${LOOP_USAGE}`);
    if (!rest) return { kind: "retune", count };

    let delay = 0;
    let prompt = rest;
    const delayOption = /^(--delay)(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
    if (delayOption) {
      delay = parseLoopDuration(delayOption[2]);
      prompt = delayOption[3]?.trim() ?? "";
      if (!prompt) throw new Error(`a prompt is required after --delay; ${LOOP_USAGE}`);
    } else if (/^--delay(?:\s|=|$)/.test(rest)) {
      throw new Error(`--delay requires a duration and prompt; ${LOOP_USAGE}`);
    }
    return { kind: "start", count, delay, prompt };
  }

  throw new Error(`expected a positive count or a loop command; ${LOOP_USAGE}`);
}

/** Return the latest loop state on a session branch. */
export function readLoopState(entries: readonly SessionEntry[] | readonly unknown[]): LoopState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== LOOP_STATE_ENTRY) continue;
    return parseLoopState(entry.data);
  }
  return undefined;
}

export function parseLoopState(value: unknown): LoopState | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (
    status !== "active" &&
    status !== "stopping" &&
    status !== "paused" &&
    status !== "completed" &&
    status !== "stopped" &&
    status !== "inactive"
  ) {
    return undefined;
  }
  const delay = value.delay === undefined ? 0 : value.delay;
  if (
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    !value.runId ||
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    !isPositiveInteger(value.currentIteration) ||
    !isNonNegativeInteger(value.remainingBudget) ||
    (value.pendingRetune !== null && !isNonNegativeInteger(value.pendingRetune)) ||
    !isValidLoopDelay(delay) ||
    (value.retryCount !== undefined && !isNonNegativeInteger(value.retryCount))
  ) {
    return undefined;
  }
  if (
    value.phase !== undefined &&
    value.phase !== "running" &&
    value.phase !== "waiting" &&
    value.phase !== "retrying"
  ) return undefined;
  if (value.nextActionAt !== undefined && !isNonNegativeInteger(value.nextActionAt)) return undefined;
  if (value.settledAt !== undefined && !isNonNegativeInteger(value.settledAt)) return undefined;
  if (value.endsAt !== undefined && (!isNonNegativeInteger(value.endsAt) || delay === 0)) return undefined;
  if (value.pauseReason !== undefined && typeof value.pauseReason !== "string") return undefined;
  if (value.pausedAt !== undefined && !isNonNegativeInteger(value.pausedAt)) return undefined;
  if (value.ownerSessionId !== undefined && typeof value.ownerSessionId !== "string") return undefined;
  if (value.ownerSessionFile !== undefined && typeof value.ownerSessionFile !== "string") return undefined;

  return {
    version: 1,
    runId: value.runId,
    prompt: value.prompt,
    currentIteration: value.currentIteration,
    remainingBudget: value.remainingBudget,
    pendingRetune: value.pendingRetune,
    delay,
    status,
    retryCount: value.retryCount ?? 0,
    phase: value.phase ?? "running",
    ...(value.nextActionAt !== undefined ? { nextActionAt: value.nextActionAt } : {}),
    ...(value.settledAt !== undefined ? { settledAt: value.settledAt } : {}),
    ...(value.endsAt !== undefined ? { endsAt: value.endsAt } : {}),
    ...(value.pauseReason ? { pauseReason: value.pauseReason } : {}),
    ...(value.pausedAt !== undefined ? { pausedAt: value.pausedAt } : {}),
    ...(value.ownerSessionId ? { ownerSessionId: value.ownerSessionId } : {}),
    ...(value.ownerSessionFile ? { ownerSessionFile: value.ownerSessionFile } : {}),
  };
}

export function formatLoopStatus(state: LoopState | undefined): string {
  if (!state || state.status === "inactive") return "loop: idle";
  const pending = state.pendingRetune === null ? "none" : String(state.pendingRetune);
  return [
    `loop: ${state.status}`,
    `run: ${state.runId}`,
    `iteration: ${state.currentIteration}`,
    ...(state.endsAt !== undefined
      ? [`ends at: ${new Date(state.endsAt).toISOString()}`]
      : [`remaining: ${state.remainingBudget}`, `pending retune: ${pending}`]),
    `delay: ${formatLoopDelay(state.delay ?? 0)}`,
    `retries: ${state.retryCount ?? 0}/${DEFAULT_LOOP_RETRIES}`,
    `phase: ${state.phase ?? "running"}`,
    ...(state.nextActionAt ? [`next action: ${new Date(state.nextActionAt).toISOString()}`] : []),
    ...(state.pauseReason ? [`pause reason: ${state.pauseReason}`] : []),
    ...(state.pausedAt ? [`paused at: ${new Date(state.pausedAt).toISOString()}`] : []),
  ].join("\n");
}

type SessionIdentity = {
  id?: string;
  file?: string;
  token?: string;
};

type ContextWithSession = Pick<ExtensionContext, "sessionManager">;
type SessionIdentitySource = Pick<SessionManager, "getSessionId" | "getSessionFile">;
type ReplacementContext = ExtensionCommandContext & {
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): Promise<void>;
};

function sessionIdentity(value: SessionIdentitySource): SessionIdentity {
  try {
    const id = value.getSessionId();
    const file = value.getSessionFile();
    return {
      id: id || undefined,
      file: file || undefined,
      token: file || id || undefined,
    };
  } catch {
    return {};
  }
}

function contextIdentity(ctx: ContextWithSession): SessionIdentity {
  try {
    return sessionIdentity(ctx.sessionManager);
  } catch {
    return {};
  }
}

function stateBelongsToContext(state: LoopState, ctx: ContextWithSession): boolean {
  const identity = contextIdentity(ctx);
  if (state.ownerSessionFile && identity.file) return state.ownerSessionFile === identity.file;
  if (state.ownerSessionId && identity.id) return state.ownerSessionId === identity.id;
  // Older/in-memory test sessions may not expose identity metadata. The
  // persisted status still protects them from stale callbacks.
  return !state.ownerSessionFile && !state.ownerSessionId;
}

function stateForSession(state: LoopState, identity: SessionIdentity): LoopState {
  const { ownerSessionId: _oldOwnerId, ownerSessionFile: _oldOwnerFile, ...withoutOwner } = state;
  return {
    ...withoutOwner,
    ...(identity.id ? { ownerSessionId: identity.id } : {}),
    ...(identity.file ? { ownerSessionFile: identity.file } : {}),
  };
}

function latestStateFromContext(ctx: ContextWithSession): LoopState | undefined {
  try {
    return readLoopState(ctx.sessionManager.getBranch());
  } catch {
    return undefined;
  }
}

function statusIsActive(state: LoopState | undefined): state is LoopState {
  return Boolean(state && ACTIVE_STATUSES.has(state.status));
}

function statusIsVisible(state: LoopState | undefined): state is LoopState {
  return Boolean(state && VISIBLE_STATUSES.has(state.status));
}

function isTerminal(state: LoopState | undefined): boolean {
  return Boolean(state && TERMINAL_STATUSES.has(state.status));
}

function formatTimeRemaining(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  if (seconds >= 24 * 60 * 60) return `${Math.ceil(seconds / (24 * 60 * 60))}d`;
  if (seconds >= 60 * 60) return `${Math.ceil(seconds / (60 * 60))}h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  return `${seconds}s`;
}

export function formatLoopWidget(state: LoopState, width: number, now = Date.now()): string {
  const prompt = state.prompt.replace(/\s+/g, " ").trim();
  const delay = state.delay > 0 ? ` · delay ${formatLoopDelay(state.delay)}` : "";
  const timeframe = state.endsAt === undefined
    ? ""
    : state.endsAt <= now
      ? " · deadline reached"
      : ` · ${formatTimeRemaining(state.endsAt - now)} left`;
  const retries = (state.retryCount ?? 0) > 0
    ? ` · retry ${state.retryCount}/${DEFAULT_LOOP_RETRIES}`
    : "";
  if (state.status === "stopping") {
    return truncateToWidth(`loop stopping${timeframe}${delay}${retries} · ${prompt}`, width, "…");
  }
  if (state.endsAt !== undefined) {
    return truncateToWidth(
      `loop ${state.status}${timeframe}${delay}${retries} · ${prompt}`,
      width,
      "…",
    );
  }
  const futureIterations = state.pendingRetune ?? state.remainingBudget;
  const remainingIterations = futureIterations + 1;
  const totalIterations = state.currentIteration + futureIterations;
  return truncateToWidth(
    `loop ${state.status} ${remainingIterations}/${totalIterations}${delay}${retries} · ${prompt}`,
    width,
    "…",
  );
}

type ContinuationWait = {
  key: string;
  settledAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type RetryWait = {
  key: string;
  retryCount: number;
  timer: ReturnType<typeof setTimeout>;
};

type PendingFailure = {
  key: string;
  stopReason: "aborted" | "error";
  reason: string;
};

export default function loopExtension(pi: ExtensionAPI): void {
  let runState: LoopState | undefined;
  let transitionInFlight = false;
  let handledSettlementKey: string | undefined;
  let continuationWait: ContinuationWait | undefined;
  let retryWait: RetryWait | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let activeCommandKey: string | undefined;
  let commandInterruptedKey: string | undefined;
  let pendingFailure: PendingFailure | undefined;
  let currentSessionManagerRef: unknown;
  let widgetState: LoopState | undefined;
  let widgetTui: { requestRender(): void } | undefined;
  let widgetMounted = false;

  function stateFrom(ctx: ContextWithSession): LoopState | undefined {
    runState = latestStateFromContext(ctx);
    return runState;
  }

  function persist(ctx: Pick<ExtensionAPI, "appendEntry">, state: LoopState): void {
    ctx.appendEntry(LOOP_STATE_ENTRY, state);
    runState = state;
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }
    const output = `[pi-loop] ${message}`;
    if (type === "error") console.error(output);
    else console.warn(output);
  }

  function clearWidget(ctx: ExtensionContext): void {
    widgetState = undefined;
    widgetTui = undefined;
    widgetMounted = false;
    if (ctx.hasUI) ctx.ui.setWidget(LOOP_WIDGET_KEY, undefined);
  }

  function showWidget(ctx: ExtensionContext, state: LoopState): void {
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(LOOP_WIDGET_KEY, [formatLoopWidget(state, Number.MAX_SAFE_INTEGER)], { placement: "belowEditor" });
      return;
    }
    widgetState = state;
    if (widgetMounted && widgetTui) {
      widgetTui.requestRender();
      return;
    }
    ctx.ui.setWidget(LOOP_WIDGET_KEY, (tui, _theme) => {
      widgetTui = tui;
      widgetMounted = true;
      return {
        render: (width) => widgetState ? [formatLoopWidget(widgetState, width)] : [],
        invalidate: () => {},
      };
    }, { placement: "belowEditor" });
  }

  function renderWidget(ctx: ExtensionContext, state = runState): void {
    if (!ctx.hasUI || !statusIsVisible(state)) {
      clearWidget(ctx);
      return;
    }
    showWidget(ctx, state);
  }

  function currentState(ctx: ContextWithSession): LoopState | undefined {
    let sessionManager: unknown;
    try {
      sessionManager = ctx.sessionManager;
    } catch {
      return undefined;
    }
    if (currentSessionManagerRef !== undefined && sessionManager !== currentSessionManagerRef) return undefined;
    const loaded = stateFrom(ctx);
    if (!loaded) return undefined;
    if (!stateBelongsToContext(loaded, ctx)) return undefined;
    return loaded;
  }

  function stateKey(ctx: ContextWithSession, state: LoopState): string {
    const identity = contextIdentity(ctx);
    return `${state.runId}:${state.currentIteration}:${identity.token ?? "unknown"}`;
  }

  function clearContinuationWait(): void {
    if (!continuationWait) return;
    clearTimeout(continuationWait.timer);
    continuationWait = undefined;
  }

  function clearRetryWait(): void {
    if (!retryWait) return;
    clearTimeout(retryWait.timer);
    retryWait = undefined;
  }

  function clearRecoveryTimer(): void {
    if (!recoveryTimer) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }

  function pauseLoop(ctx: ExtensionContext, state: LoopState, reason: string): void {
    clearContinuationWait();
    clearRetryWait();
    const {
      nextActionAt: _nextActionAt,
      settledAt: _settledAt,
      ...withoutSchedule
    } = state;
    const paused = {
      ...withoutSchedule,
      status: "paused" as const,
      phase: "running" as const,
      pauseReason: reason,
      pausedAt: Date.now(),
    };
    persist(pi, paused);
    renderWidget(ctx, paused);
  }

  function scheduleContinuation(
    ctx: ExtensionContext,
    state: LoopState,
    settledAt = Date.now(),
  ): void {
    if (!statusIsActive(state) || transitionInFlight) return;
    const nextBudget = state.pendingRetune ?? state.remainingBudget;
    if (state.status === "stopping" || (state.endsAt === undefined && nextBudget <= 0) || state.delay === 0) {
      clearContinuationWait();
      dispatchContinuation(ctx, state);
      return;
    }

    const key = stateKey(ctx, state);
    if (continuationWait?.key === key) return;
    clearContinuationWait();
    const nextActionAt = state.endsAt !== undefined
      ? Math.min(settledAt + state.delay, state.endsAt)
      : settledAt + state.delay;
    const waiting: LoopState = { ...state, phase: "waiting", nextActionAt, settledAt };
    persist(pi, waiting);
    renderWidget(ctx, waiting);
    const waitMs = Math.max(0, nextActionAt - Date.now());
    if (waitMs === 0) {
      dispatchContinuation(ctx, waiting);
      return;
    }

    const timer = setTimeout(() => {
      if (!continuationWait || continuationWait.key !== key || continuationWait.timer !== timer) return;
      continuationWait = undefined;
      const latest = currentState(ctx);
      if (!latest || latest.runId !== state.runId || latest.currentIteration !== state.currentIteration) return;
      if (!statusIsActive(latest) || latest.phase !== "waiting") return;
      dispatchContinuation(ctx, latest);
    }, waitMs);
    continuationWait = { key, settledAt, timer };
  }

  function rescheduleContinuation(ctx: ExtensionContext, state: LoopState): void {
    if (!continuationWait || continuationWait.key !== stateKey(ctx, state)) return;
    const settledAt = continuationWait.settledAt;
    clearContinuationWait();
    scheduleContinuation(ctx, state, settledAt);
  }

  function isWaitingForContinuation(ctx: ContextWithSession, state: LoopState): boolean {
    const key = stateKey(ctx, state);
    return continuationWait?.key === key || retryWait?.key === key || recoveryTimer !== undefined;
  }

  function clearCommandInterruption(): void {
    activeCommandKey = undefined;
    commandInterruptedKey = undefined;
  }

  function continueCurrentIteration(ctx: ExtensionContext, state: LoopState): void {
    if (state.endsAt !== undefined && Date.now() >= state.endsAt) {
      dispatchContinuation(ctx, state);
      return;
    }
    const content = `${LOOP_CONTINUATION_PROMPT}\n\nCurrent loop instructions:\n${state.prompt}`;
    try {
      pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      notify(ctx, "loop continuing the current iteration", "info");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      pauseLoop(ctx, state, reason);
      notify(ctx, `loop paused: ${reason}`, "error");
    }
  }

  function recordAssistantOutcome(
    ctx: ExtensionContext,
    assistant: { stopReason?: string; errorMessage?: string } | undefined,
  ): void {
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded) || transitionInFlight) return;
    const key = stateKey(ctx, loaded);
    const stopReason = assistant?.stopReason;
    if (stopReason !== "aborted" && stopReason !== "error") {
      if (pendingFailure?.key === key) pendingFailure = undefined;
      return;
    }
    clearContinuationWait();
    if (stopReason === "aborted" && activeCommandKey === key) {
      pendingFailure = undefined;
      commandInterruptedKey = key;
      return;
    }
    clearCommandInterruption();
    pendingFailure = {
      key,
      stopReason,
      reason: stopReason === "error"
        ? assistant?.errorMessage?.trim() || "assistant error"
        : "assistant aborted",
    };
  }

  function armRetry(ctx: ExtensionContext, state: LoopState, waitMs: number): void {
    clearRetryWait();
    const key = stateKey(ctx, state);
    const retryCount = state.retryCount ?? 0;
    const timer = setTimeout(() => {
      if (!retryWait || retryWait.timer !== timer || retryWait.key !== key) return;
      retryWait = undefined;
      const latest = currentState(ctx);
      if (!latest || !statusIsActive(latest) || stateKey(ctx, latest) !== key) return;
      if ((latest.retryCount ?? 0) !== retryCount || latest.phase !== "retrying") return;
      const {
        nextActionAt: _nextActionAt,
        settledAt: _settledAt,
        ...withoutSchedule
      } = latest;
      const running: LoopState = { ...withoutSchedule, phase: "running" };
      persist(pi, running);
      renderWidget(ctx, running);
      handledSettlementKey = undefined;
      continueCurrentIteration(ctx, running);
    }, waitMs);
    retryWait = { key, retryCount, timer };
  }

  function scheduleRetry(ctx: ExtensionContext, state: LoopState, failure: PendingFailure): void {
    const previousRetryCount = state.retryCount ?? 0;
    const retryCount = previousRetryCount + 1;
    const delay = DEFAULT_LOOP_RETRY_DELAY_MS * 2 ** previousRetryCount;
    const nextActionAt = Date.now() + delay;
    const { pauseReason: _pauseReason, pausedAt: _pausedAt, ...withoutPause } = state;
    const retrying: LoopState = {
      ...withoutPause,
      retryCount,
      status: "active",
      phase: "retrying",
      nextActionAt,
    };
    persist(pi, retrying);
    renderWidget(ctx, retrying);
    handledSettlementKey = stateKey(ctx, retrying);
    notify(
      ctx,
      `loop retrying iteration ${retrying.currentIteration} in ${formatLoopDelay(delay)} after ${failure.reason} (${retryCount}/${DEFAULT_LOOP_RETRIES})`,
      "warning",
    );
    armRetry(ctx, retrying, delay);
  }

  function scheduleStartupRecovery(ctx: ExtensionContext, state: LoopState): void {
    clearRecoveryTimer();
    const key = stateKey(ctx, state);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      const latest = currentState(ctx);
      if (!latest || !statusIsActive(latest) || stateKey(ctx, latest) !== key) return;
      handledSettlementKey = undefined;
      if (latest.phase === "waiting") {
        const settledAt = latest.settledAt ?? (latest.nextActionAt ?? Date.now()) - latest.delay;
        scheduleContinuation(ctx, latest, settledAt);
        return;
      }
      if (latest.phase === "retrying") {
        const waitMs = Math.max(0, (latest.nextActionAt ?? Date.now()) - Date.now());
        armRetry(ctx, latest, waitMs);
        return;
      }
      notify(ctx, `loop recovering interrupted iteration ${latest.currentIteration}`, "warning");
      continueCurrentIteration(ctx, latest);
    }, 0);
  }

  function transferState(state: LoopState, manager: SessionManager): LoopState {
    const transferred = stateForSession({ ...state, status: "active" }, sessionIdentity(manager));
    manager.appendCustomEntry(LOOP_STATE_ENTRY, transferred);
    return transferred;
  }

  async function sendIteration(
    replacement: ReplacementContext,
    state: LoopState,
  ): Promise<void> {
    // The new extension instance restores this entry in before_agent_start.
    // This callback still owns the command context, so it is the safe place to
    // start the turn after the replacement is complete.
    if (replacement.hasUI) showWidget(replacement, state);
    if (state.endsAt !== undefined && Date.now() >= state.endsAt) {
      await replacement.sendUserMessage(
        `/loop __continue ${state.runId} ${state.currentIteration}`,
        { expandPromptTemplates: true },
      );
      return;
    }
    await replacement.sendUserMessage(state.prompt, { expandPromptTemplates: true });
  }

  async function replaceForIteration(ctx: ExtensionCommandContext, next: LoopState): Promise<void> {
    clearContinuationWait();
    clearRetryWait();
    clearRecoveryTimer();
    const sourceIdentity = contextIdentity(ctx);
    const parentSession = sourceIdentity.file;
    const inactive = {
      ...next,
      status: "inactive" as const,
      ...(sourceIdentity.id ? { ownerSessionId: sourceIdentity.id } : {}),
      ...(sourceIdentity.file ? { ownerSessionFile: sourceIdentity.file } : {}),
    };
    transitionInFlight = true;
    // Persist the ownership handoff before invoking newSession. If the switch
    // is cancelled, this marker is replaced with paused state below.
    persist(pi, inactive);
    clearWidget(ctx);

    let transferred: LoopState | undefined;
    try {
      const result = await ctx.newSession({
        ...(parentSession ? { parentSession } : {}),
        setup: async (manager) => {
          transferred = transferState(next, manager);
        },
        withSession: async (replacement) => {
          if (!transferred) throw new Error("loop state was not transferred into the new session");
          transitionInFlight = false;
          try {
            await sendIteration(replacement, transferred);
          } catch (error) {
            // A prompt can fail before agent_end (for example when no model is
            // configured). Dispatch a private command in the replacement
            // runtime so its own pi.appendEntry remains current.
            try {
              await replacement.sendUserMessage(
                `/loop __pause ${transferred.runId} ${transferred.currentIteration}`,
                { expandPromptTemplates: true },
              );
            } catch {
              // The replacement may already be shutting down; its inactive
              // ownership marker still prevents an accidental continuation.
            }
            notify(
              replacement,
              `loop paused: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        },
      });

      if (result.cancelled) {
        transitionInFlight = false;
        const paused: LoopState = {
          ...next,
          status: "paused",
          pauseReason: "session replacement was cancelled",
          pausedAt: Date.now(),
          ...(sourceIdentity.id ? { ownerSessionId: sourceIdentity.id } : {}),
          ...(sourceIdentity.file ? { ownerSessionFile: sourceIdentity.file } : {}),
        };
        persist(pi, paused);
        runState = paused;
        renderWidget(ctx, paused);
        notify(ctx, "loop paused: session replacement was cancelled", "warning");
      }
    } catch (error) {
      transitionInFlight = false;
      // A replacement can invalidate ctx before throwing. In that case the
      // inactive marker remains authoritative and a later resume is required.
      try {
        const reason = error instanceof Error ? error.message : String(error);
        const paused: LoopState = {
          ...next,
          status: "paused",
          pauseReason: reason,
          pausedAt: Date.now(),
          ...(sourceIdentity.id ? { ownerSessionId: sourceIdentity.id } : {}),
          ...(sourceIdentity.file ? { ownerSessionFile: sourceIdentity.file } : {}),
        };
        persist(pi, paused);
        runState = paused;
        renderWidget(ctx, paused);
        notify(ctx, `loop paused: ${reason}`, "error");
      } catch {
        console.error(`[pi-loop] session replacement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function advanceAtBoundary(
    ctx: ExtensionCommandContext,
    expectedRunId: string,
    expectedIteration: number,
    allowPaused = false,
  ): Promise<void> {
    const state = currentState(ctx);
    if (!state || state.runId !== expectedRunId || state.currentIteration !== expectedIteration) return;
    const canAdvance = ACTIVE_STATUSES.has(state.status) || (allowPaused && state.status === "paused");
    if (!canAdvance || transitionInFlight) return;
    clearContinuationWait();
    clearRetryWait();

    if (state.status === "stopping") {
      const stopped = { ...state, status: "stopped" as const };
      persist(pi, stopped);
      clearWidget(ctx);
      runState = stopped;
      notify(ctx, "loop stopped", "info");
      return;
    }

    const nextBudget = state.pendingRetune ?? state.remainingBudget;
    if (state.endsAt !== undefined && Date.now() >= state.endsAt) {
      const completed = { ...state, status: "completed" as const, pendingRetune: null };
      persist(pi, completed);
      clearWidget(ctx);
      runState = completed;
      notify(ctx, `loop completed at its deadline after ${state.currentIteration} iteration${state.currentIteration === 1 ? "" : "s"}`, "info");
      return;
    }
    if (state.endsAt === undefined && nextBudget <= 0) {
      const completed = { ...state, status: "completed" as const, pendingRetune: null };
      persist(pi, completed);
      clearWidget(ctx);
      runState = completed;
      notify(ctx, `loop completed after ${state.currentIteration} iteration${state.currentIteration === 1 ? "" : "s"}`, "info");
      return;
    }

    const {
      pauseReason: _pauseReason,
      pausedAt: _pausedAt,
      nextActionAt: _nextActionAt,
      settledAt: _settledAt,
      ...withoutPause
    } = state;
    const next: LoopState = {
      ...withoutPause,
      currentIteration: state.currentIteration + 1,
      remainingBudget: state.endsAt === undefined ? nextBudget - 1 : 0,
      pendingRetune: null,
      retryCount: 0,
      phase: "running",
      status: "active",
    };
    await replaceForIteration(ctx, next);
  }

  function dispatchContinuation(ctx: ExtensionContext, state: LoopState): void {
    const command = `/loop __continue ${state.runId} ${state.currentIteration}`;
    try {
      const result = (pi.sendUserMessage as unknown as (
        content: string,
        options?: { expandPromptTemplates?: boolean },
      ) => unknown)(command, { expandPromptTemplates: true });
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).catch((error) => {
          const latest = currentState(ctx);
          if (!latest || latest.runId !== state.runId || latest.currentIteration !== state.currentIteration) return;
          const reason = error instanceof Error ? error.message : String(error);
          try {
            pauseLoop(ctx, latest, reason);
          } catch {
            // The runtime may already have replaced this session.
          }
          console.error(`[pi-loop] continuation failed: ${reason}`);
        });
      }
    } catch (error) {
      const latest = currentState(ctx);
      if (!latest || latest.runId !== state.runId || latest.currentIteration !== state.currentIteration) return;
      const reason = error instanceof Error ? error.message : String(error);
      try {
        pauseLoop(ctx, latest, reason);
      } catch {
        // The runtime may already have replaced this session.
      }
      notify(ctx, `loop paused: ${reason}`, "error");
    }
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = parseLoopCommand(args);

    if (parsed.kind === "continue") {
      await advanceAtBoundary(ctx, parsed.runId, parsed.iteration);
      return;
    }

    if (parsed.kind === "pause") {
      const state = currentState(ctx);
      if (!state || state.runId !== parsed.runId || state.currentIteration !== parsed.iteration || !statusIsActive(state)) return;
      pauseLoop(ctx, state, "iteration prompt failed to start");
      return;
    }

    const state = currentState(ctx);
    if (state && statusIsActive(state) && !ctx.isIdle()) {
      activeCommandKey = stateKey(ctx, state);
    }

    if (parsed.kind === "status") {
      notify(ctx, formatLoopStatus(state), "info");
      return;
    }

    if (parsed.kind === "delay") {
      if (!state || isTerminal(state)) {
        notify(ctx, "a loop must be active, stopping, or paused to update its delay", "error");
        return;
      }
      if (state.endsAt !== undefined && parsed.delay === 0) {
        notify(ctx, "timed loops require a non-zero delay", "error");
        return;
      }
      const nextActionAt = state.phase === "waiting" && state.nextActionAt !== undefined
        ? Math.min(
            (state.settledAt ?? state.nextActionAt - state.delay) + parsed.delay,
            state.endsAt ?? Number.MAX_SAFE_INTEGER,
          )
        : state.nextActionAt;
      const updated = {
        ...state,
        delay: parsed.delay,
        ...(nextActionAt !== undefined ? { nextActionAt } : {}),
      };
      persist(pi, updated);
      renderWidget(ctx, updated);
      if (state.status === "active") rescheduleContinuation(ctx, updated);
      if (state.status === "paused") {
        notify(ctx, `loop delay set to ${formatLoopDelay(parsed.delay)}; resume will use it`, "info");
      } else if (state.status === "stopping") {
        notify(ctx, `loop delay set to ${formatLoopDelay(parsed.delay)}; loop is still stopping`, "info");
      } else {
        notify(ctx, `loop delay set to ${formatLoopDelay(parsed.delay)}`, "info");
      }
      return;
    }

    if (parsed.kind === "end") {
      if (!state || state.status === "inactive" || state.status === "completed" || state.status === "stopped") {
        notify(ctx, "loop: no active run", "info");
        clearWidget(ctx);
        return;
      }
      if (isWaitingForContinuation(ctx, state)) {
        clearContinuationWait();
        clearRetryWait();
        clearRecoveryTimer();
        const stopped = { ...state, status: "stopped" as const };
        persist(pi, stopped);
        clearWidget(ctx);
        runState = stopped;
        notify(ctx, "loop stopped", "info");
        return;
      }
      if (state.status === "paused") {
        const stopped = { ...state, status: "stopped" as const };
        persist(pi, stopped);
        clearWidget(ctx);
        runState = stopped;
        notify(ctx, "loop stopped", "info");
        return;
      }
      if (state.status === "stopping") {
        notify(ctx, "loop is already stopping", "info");
        return;
      }
      const stopping = { ...state, status: "stopping" as const };
      persist(pi, stopping);
      renderWidget(ctx, stopping);
      notify(ctx, "loop will stop after the active iteration", "info");
      return;
    }

    if (parsed.kind === "resume") {
      if (state?.status === "stopping") {
        const resumed = { ...state, status: "active" as const };
        persist(pi, resumed);
        renderWidget(ctx, resumed);
        notify(ctx, "loop resumed", "info");
        return;
      }
      if (!state || state.status !== "paused") {
        notify(ctx, state && statusIsActive(state) ? "loop is already active" : "loop is not paused", "error");
        return;
      }
      if (state.endsAt !== undefined && Date.now() >= state.endsAt) {
        await advanceAtBoundary(ctx, state.runId, state.currentIteration, true);
        return;
      }
      const {
        pauseReason: _pauseReason,
        pausedAt: _pausedAt,
        nextActionAt: _nextActionAt,
        settledAt: _settledAt,
        ...withoutPause
      } = state;
      const resumed: LoopState = {
        ...withoutPause,
        status: "active",
        retryCount: 0,
        phase: "running",
      };
      persist(pi, resumed);
      renderWidget(ctx, resumed);
      handledSettlementKey = undefined;
      continueCurrentIteration(ctx, resumed);
      return;
    }

    if (parsed.kind === "next") {
      if (!state || state.status !== "paused") {
        notify(ctx, state && statusIsActive(state) ? "loop is active; /loop next is only available while paused" : "loop is not paused; /loop next is only available while paused", "error");
        return;
      }
      await advanceAtBoundary(ctx, state.runId, state.currentIteration, true);
      return;
    }

    if (parsed.kind === "replacePrompt" || parsed.kind === "appendPrompt") {
      if (!state || isTerminal(state)) {
        notify(ctx, "a loop must be active, stopping, or paused to update its prompt", "error");
        return;
      }
      const prompt = parsed.kind === "replacePrompt"
        ? parsed.prompt
        : `${state.prompt}\n\n${parsed.prompt}`;
      const updated = { ...state, prompt };
      persist(pi, updated);
      renderWidget(ctx, updated);
      const action = parsed.kind === "replacePrompt" ? "replaced" : "extended";
      if (state.status === "paused") {
        notify(ctx, `loop prompt ${action}; resume will use it`, "info");
      } else if (state.status === "stopping") {
        notify(ctx, `loop prompt ${action}; loop is still stopping`, "info");
      } else if (state.endsAt === undefined && (state.pendingRetune ?? state.remainingBudget) === 0) {
        notify(ctx, `future loop prompt ${action}; no future iteration is scheduled`, "info");
      } else {
        notify(ctx, `future loop prompt ${action}; active iteration unchanged`, "info");
      }
      return;
    }

    if (parsed.kind === "retune" || parsed.kind === "adjust") {
      if (!state || (state.status !== "active" && state.status !== "stopping")) {
        notify(ctx, "a loop must be active to retune its remaining budget", "error");
        return;
      }
      if (state.endsAt !== undefined) {
        notify(ctx, "a timed loop has no iteration budget to retune", "error");
        return;
      }
      const currentBudget = state.pendingRetune ?? state.remainingBudget;
      const nextBudget = parsed.kind === "retune" ? parsed.count : currentBudget + parsed.delta;
      if (nextBudget < 0) {
        notify(ctx, `cannot subtract more than the ${currentBudget} future iteration${currentBudget === 1 ? "" : "s"}`, "error");
        return;
      }
      const retuned = { ...state, pendingRetune: nextBudget, status: "active" as const };
      persist(pi, retuned);
      renderWidget(ctx, retuned);
      if (nextBudget <= 0) rescheduleContinuation(ctx, retuned);
      notify(ctx, `loop will run ${nextBudget} future iteration${nextBudget === 1 ? "" : "s"}`, "info");
      return;
    }

    if (state && !isTerminal(state)) {
      if (state.status === "paused") {
        notify(ctx, "loop is paused; use /loop resume or /loop end", "error");
      } else {
        notify(ctx, "a loop is already active; use /loop <positive-count> to retune it", "error");
      }
      return;
    }

    const timed = parsed.kind === "startTimed";
    const initial: LoopState = {
      version: 1,
      runId: randomUUID(),
      prompt: parsed.prompt,
      currentIteration: 1,
      remainingBudget: timed ? 0 : parsed.count - 1,
      pendingRetune: null,
      delay: parsed.delay,
      status: "active",
      retryCount: 0,
      phase: "running",
      ...(timed ? { endsAt: Date.now() + parsed.duration } : {}),
      ...(contextIdentity(ctx).id ? { ownerSessionId: contextIdentity(ctx).id } : {}),
      ...(contextIdentity(ctx).file ? { ownerSessionFile: contextIdentity(ctx).file } : {}),
    };
    await replaceForIteration(ctx, initial);
  }

  pi.registerTool({
    name: "loop_pause",
    label: "Pause Loop",
    description: "Pause the active /loop when useful work cannot continue because of a non-transient external blocker. Use only when the system prompt says this session is in an active loop.",
    executionMode: "sequential",
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Specific human input, credential, permission, or external dependency required to continue",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = currentState(ctx);
      if (!state || state.status !== "active") {
        return {
          content: [{ type: "text", text: "No active loop can be paused." }],
          details: { paused: false },
        };
      }
      const reason = params.reason.trim();
      if (!reason) throw new Error("A specific blocker reason is required");
      pauseLoop(ctx, state, reason);
      notify(ctx, `loop paused by agent: ${reason}`, "warning");
      ctx.abort();
      return {
        content: [{ type: "text", text: `Loop paused: ${reason}` }],
        details: { paused: true, reason },
        terminate: true,
      };
    },
  });

  pi.on("session_start", (event, ctx) => {
    clearContinuationWait();
    clearRetryWait();
    clearRecoveryTimer();
    clearCommandInterruption();
    pendingFailure = undefined;
    currentSessionManagerRef = ctx.sessionManager;
    transitionInFlight = false;
    handledSettlementKey = undefined;
    const loaded = latestStateFromContext(ctx);
    const owned = loaded && stateBelongsToContext(loaded, ctx) ? loaded : undefined;
    runState = owned;
    if (!owned || owned.status === "inactive") clearWidget(ctx);
    else renderWidget(ctx, owned);
    // New-session setup writes transferred state after this event and starts
    // its prompt explicitly. Existing active owners represent interrupted work.
    if (owned && statusIsActive(owned) && event.reason !== "new" && event.reason !== "fork") {
      scheduleStartupRecovery(ctx, owned);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    clearRecoveryTimer();
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded)) return;
    transitionInFlight = false;
    renderWidget(ctx, loaded);
    if (loaded.status !== "active") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${LOOP_AGENT_GUIDANCE}` };
  });

  pi.on("agent_start", (_event, ctx) => {
    const loaded = currentState(ctx);
    if (loaded && statusIsActive(loaded)) renderWidget(ctx, loaded);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    recordAssistantOutcome(ctx, event.message as { stopReason?: string; errorMessage?: string });
  });

  pi.on("agent_end", (event, ctx) => {
    const assistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant") as {
        stopReason?: string;
        errorMessage?: string;
      } | undefined;
    recordAssistantOutcome(ctx, assistant);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded) || transitionInFlight) return;
    const key = stateKey(ctx, loaded);
    if (commandInterruptedKey === key && loaded.status === "active") {
      clearCommandInterruption();
      pendingFailure = undefined;
      handledSettlementKey = undefined;
      continueCurrentIteration(ctx, loaded);
      return;
    }
    clearCommandInterruption();
    if (pendingFailure?.key === key) {
      const failure = pendingFailure;
      pendingFailure = undefined;
      if (failure.stopReason === "error" && (loaded.retryCount ?? 0) < DEFAULT_LOOP_RETRIES) {
        scheduleRetry(ctx, loaded, failure);
      } else {
        pauseLoop(ctx, loaded, failure.reason);
        notify(ctx, `loop paused: ${failure.reason}`, "error");
      }
      return;
    }
    if (handledSettlementKey === key) return;
    handledSettlementKey = key;
    scheduleContinuation(ctx, loaded);
  });

  pi.on("session_tree", (_event, ctx) => {
    clearContinuationWait();
    clearRetryWait();
    clearRecoveryTimer();
    clearCommandInterruption();
    pendingFailure = undefined;
    currentSessionManagerRef = ctx.sessionManager;
    handledSettlementKey = undefined;
    const loaded = latestStateFromContext(ctx);
    const owned = loaded && stateBelongsToContext(loaded, ctx) ? loaded : undefined;
    runState = owned;
    if (!owned || owned.status === "inactive") clearWidget(ctx);
    else renderWidget(ctx, owned);
    if (owned && statusIsActive(owned)) scheduleStartupRecovery(ctx, owned);
  });

  pi.on("session_shutdown", (event, ctx) => {
    clearContinuationWait();
    clearRetryWait();
    clearRecoveryTimer();
    clearCommandInterruption();
    pendingFailure = undefined;
    const loaded = currentState(ctx);
    if (event.reason !== "reload" && loaded && statusIsActive(loaded) && !transitionInFlight) {
      try {
        persist(pi, { ...loaded, status: "inactive" });
      } catch {
        // Shutdown may already have detached the runtime's append action.
      }
    }
    clearWidget(ctx);
    currentSessionManagerRef = undefined;
  });

  pi.registerCommand("loop", {
    description: "<count> [--delay <duration>] <prompt> | for <duration> --delay <duration> <prompt> | controls — Run a bounded fresh-session loop",
    getArgumentCompletions: (prefix) => completeLoopArguments(prefix),
    handler: async (args, ctx) => {
      try {
        await handleCommand(args, ctx);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
