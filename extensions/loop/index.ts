import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const LOOP_STATE_ENTRY = "pi-loop-state-v1";
export const LOOP_WIDGET_KEY = "pi-loop";
export const LOOP_USAGE =
  "usage: /loop <positive-count> [--delay <duration>] <prompt> | /loop <positive-count> | /loop <+|-><count> | /loop delay <duration> | /loop prompt <text> | /loop append <text> | /loop status | /loop resume | /loop stop";

export const MIN_LOOP_DELAY_MS = 1_000;
export const MAX_LOOP_DELAY_MS = 24 * 60 * 60 * 1_000;

export type LoopStatus = "active" | "stopping" | "paused" | "completed" | "stopped" | "inactive";

export interface LoopState {
  version: 1;
  runId: string;
  prompt: string;
  currentIteration: number;
  remainingBudget: number;
  pendingRetune: number | null;
  delay: number;
  status: LoopStatus;
  ownerSessionId?: string;
  ownerSessionFile?: string;
}

export type ParsedLoopCommand =
  | { kind: "start"; count: number; delay: number; prompt: string }
  | { kind: "retune"; count: number }
  | { kind: "adjust"; delta: number }
  | { kind: "delay"; delay: number }
  | { kind: "replacePrompt"; prompt: string }
  | { kind: "appendPrompt"; prompt: string }
  | { kind: "status" }
  | { kind: "resume" }
  | { kind: "stop" }
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

const COMMON_LOOP_DELAYS = ["1000ms", "1s", "5s", "10s", "30s", "1m", "5m", "1h", "24h"] as const;

function delayCompletions(prefix: string, command: string): ArgumentCompletion[] | null {
  return completeArguments(prefix, COMMON_LOOP_DELAYS.map((value) => ({
    value: `${command} ${value}`,
    label: `${command} ${value}`,
    description: "Set the delay between settled iterations",
  })));
}

function completeLoopArguments(prefix: string): ArgumentCompletion[] | null {
  const input = prefix.trimStart();
  const delayCommand = /^(delay|--delay)(?:\s+(.*))?$/.exec(input);
  if (delayCommand?.[2] !== undefined) return delayCompletions(prefix, delayCommand[1]);

  const countDelay = /^(\d+)\s+--delay(?:\s+(.*))?$/.exec(input);
  if (countDelay) {
    if (countDelay[2] !== undefined) {
      return delayCompletions(prefix, `${countDelay[1]} --delay`);
    }
    return completeArguments(prefix, [{
      value: `${countDelay[1]} --delay `,
      label: `${countDelay[1]} --delay <duration>`,
      description: "Set the delay between settled iterations for this loop",
    }]);
  }

  const countPrefix = /^(\d+)\s+$/.exec(input);
  if (countPrefix) {
    return completeArguments(prefix, [
      { value: `${countPrefix[1]} `, label: `${countPrefix[1]} <prompt>`, description: `Run a prompt ${countPrefix[1]} time${countPrefix[1] === "1" ? "" : "s"}` },
      { value: `${countPrefix[1]} --delay `, label: `${countPrefix[1]} --delay <duration>`, description: "Set the delay between settled iterations for this loop" },
    ]);
  }

  return completeArguments(prefix, [
    { value: "status", label: "status", description: "Show the current loop state" },
    { value: "resume", label: "resume", description: "Retry a paused iteration" },
    { value: "stop", label: "stop", description: "Stop gracefully" },
    { value: "delay ", label: "delay <duration>", description: "Set the delay between settled iterations" },
    { value: "--delay ", label: "--delay <duration>", description: "Set the delay when starting a loop" },
    { value: "prompt ", label: "prompt <text>", description: "Replace the future loop prompt" },
    { value: "append ", label: "append <text>", description: "Append to the future loop prompt" },
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

const LOOP_DURATION_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h)$/;
const LOOP_DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

export function parseLoopDuration(value: string): number {
  const input = value.trim();
  const match = LOOP_DURATION_PATTERN.exec(input);
  if (!match) {
    throw new Error("delay must be a duration such as 1s, 5000ms, 1m, or 1h");
  }
  const milliseconds = Number(match[1]) * LOOP_DURATION_MULTIPLIERS[match[2]];
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_LOOP_DELAY_MS) {
    throw new Error("delay must be at least 1s");
  }
  if (milliseconds > MAX_LOOP_DELAY_MS) {
    throw new Error("delay must not exceed 24h");
  }
  return Math.round(milliseconds);
}

export function formatLoopDelay(delay: number): string {
  if (delay === 0) return "0ms";
  if (delay % 3_600_000 === 0) return `${delay / 3_600_000}h`;
  if (delay % 60_000 === 0) return `${delay / 60_000}m`;
  if (delay % 1_000 === 0) return `${delay / 1_000}s`;
  return `${delay}ms`;
}

/** Parse public and internal /loop arguments without consulting current run state. */
export function parseLoopCommand(args: string): ParsedLoopCommand {
  const input = args.trim();
  if (!input) return { kind: "stop" };

  const firstSpace = input.search(/\s/);
  const first = firstSpace < 0 ? input : input.slice(0, firstSpace);
  const rest = firstSpace < 0 ? "" : input.slice(firstSpace).trim();

  if (first === "status") {
    if (rest) throw new Error(`status does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "status" };
  }
  if (first === "stop") {
    if (rest) throw new Error(`stop does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "stop" };
  }
  if (first === "resume") {
    if (rest) throw new Error(`resume does not accept arguments; ${LOOP_USAGE}`);
    return { kind: "resume" };
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
    !isValidLoopDelay(delay)
  ) {
    return undefined;
  }
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
    `remaining: ${state.remainingBudget}`,
    `pending retune: ${pending}`,
    `delay: ${formatLoopDelay(state.delay ?? 0)}`,
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

export function formatLoopWidget(state: LoopState, width: number): string {
  const prompt = state.prompt.replace(/\s+/g, " ").trim();
  const delay = formatLoopDelay(state.delay ?? 0);
  if (state.status === "stopping") {
    return truncateToWidth(`loop stopping · delay ${delay} · ${prompt}`, width, "…");
  }
  const futureIterations = state.pendingRetune ?? state.remainingBudget;
  const remainingIterations = futureIterations + 1;
  const totalIterations = state.currentIteration + futureIterations;
  return truncateToWidth(
    `loop ${state.status} ${remainingIterations}/${totalIterations} · delay ${delay} · ${prompt}`,
    width,
    "…",
  );
}

type ContinuationWait = {
  key: string;
  settledAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export default function loopExtension(pi: ExtensionAPI): void {
  let runState: LoopState | undefined;
  let transitionInFlight = false;
  let handledSettlementKey: string | undefined;
  let continuationWait: ContinuationWait | undefined;
  let currentSessionManagerRef: unknown;

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
    if (ctx.hasUI) ctx.ui.setWidget(LOOP_WIDGET_KEY, undefined);
  }

  function showWidget(ctx: ExtensionContext, state: LoopState): void {
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(LOOP_WIDGET_KEY, [formatLoopWidget(state, Number.MAX_SAFE_INTEGER)], { placement: "belowEditor" });
      return;
    }
    ctx.ui.setWidget(LOOP_WIDGET_KEY, (_tui, _theme) => ({
      render: (width) => [formatLoopWidget(state, width)],
      invalidate: () => {},
    }), { placement: "belowEditor" });
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

  function scheduleContinuation(
    ctx: ExtensionContext,
    state: LoopState,
    settledAt = Date.now(),
  ): void {
    if (!statusIsActive(state) || transitionInFlight) return;
    const nextBudget = state.pendingRetune ?? state.remainingBudget;
    if (state.status === "stopping" || nextBudget <= 0 || state.delay === 0) {
      clearContinuationWait();
      dispatchContinuation(ctx, state);
      return;
    }

    const key = stateKey(ctx, state);
    if (continuationWait?.key === key) return;
    clearContinuationWait();
    const waitMs = Math.max(0, settledAt + state.delay - Date.now());
    if (waitMs === 0) {
      dispatchContinuation(ctx, state);
      return;
    }

    const timer = setTimeout(() => {
      if (!continuationWait || continuationWait.key !== key || continuationWait.timer !== timer) return;
      continuationWait = undefined;
      const latest = currentState(ctx);
      if (!latest || latest.runId !== state.runId || latest.currentIteration !== state.currentIteration) return;
      if (!statusIsActive(latest)) return;
      dispatchContinuation(ctx, latest);
    }, waitMs);
    continuationWait = { key, settledAt, timer };
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function rescheduleContinuation(ctx: ExtensionContext, state: LoopState): void {
    if (!continuationWait || continuationWait.key !== stateKey(ctx, state)) return;
    const settledAt = continuationWait.settledAt;
    clearContinuationWait();
    scheduleContinuation(ctx, state, settledAt);
  }

  function isWaitingForContinuation(ctx: ContextWithSession, state: LoopState): boolean {
    return continuationWait?.key === stateKey(ctx, state);
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
    await replacement.sendUserMessage(state.prompt);
  }

  async function replaceForIteration(ctx: ExtensionCommandContext, next: LoopState): Promise<void> {
    clearContinuationWait();
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
        const paused: LoopState = {
          ...next,
          status: "paused",
          ...(sourceIdentity.id ? { ownerSessionId: sourceIdentity.id } : {}),
          ...(sourceIdentity.file ? { ownerSessionFile: sourceIdentity.file } : {}),
        };
        persist(pi, paused);
        runState = paused;
        renderWidget(ctx, paused);
        notify(ctx, `loop paused: ${error instanceof Error ? error.message : String(error)}`, "error");
      } catch {
        console.error(`[pi-loop] session replacement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function advanceAtBoundary(ctx: ExtensionCommandContext, expectedRunId: string, expectedIteration: number): Promise<void> {
    const state = currentState(ctx);
    if (!state || state.runId !== expectedRunId || state.currentIteration !== expectedIteration) return;
    if (!statusIsActive(state) || transitionInFlight) return;
    clearContinuationWait();

    if (state.status === "stopping") {
      const stopped = { ...state, status: "stopped" as const };
      persist(pi, stopped);
      clearWidget(ctx);
      runState = stopped;
      notify(ctx, "loop stopped", "info");
      return;
    }

    const nextBudget = state.pendingRetune ?? state.remainingBudget;
    if (nextBudget <= 0) {
      const completed = { ...state, status: "completed" as const, pendingRetune: null };
      persist(pi, completed);
      clearWidget(ctx);
      runState = completed;
      notify(ctx, `loop completed after ${state.currentIteration} iteration${state.currentIteration === 1 ? "" : "s"}`, "info");
      return;
    }

    const next: LoopState = {
      ...state,
      currentIteration: state.currentIteration + 1,
      remainingBudget: nextBudget - 1,
      pendingRetune: null,
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
          const paused = { ...latest, status: "paused" as const };
          try {
            persist(pi, paused);
            renderWidget(ctx, paused);
          } catch {
            // The runtime may already have replaced this session.
          }
          console.error(`[pi-loop] continuation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      const latest = currentState(ctx);
      if (!latest || latest.runId !== state.runId || latest.currentIteration !== state.currentIteration) return;
      const paused = { ...latest, status: "paused" as const };
      try {
        persist(pi, paused);
        renderWidget(ctx, paused);
      } catch {
        // The runtime may already have replaced this session.
      }
      notify(ctx, `loop paused: ${error instanceof Error ? error.message : String(error)}`, "error");
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
      clearContinuationWait();
      const paused = { ...state, status: "paused" as const };
      persist(pi, paused);
      renderWidget(ctx, paused);
      return;
    }

    const state = currentState(ctx);

    if (parsed.kind === "status") {
      notify(ctx, formatLoopStatus(state), "info");
      return;
    }

    if (parsed.kind === "delay") {
      if (!state || isTerminal(state)) {
        notify(ctx, "a loop must be active, stopping, or paused to update its delay", "error");
        return;
      }
      const updated = { ...state, delay: parsed.delay };
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

    if (parsed.kind === "stop") {
      if (!state || state.status === "inactive" || state.status === "completed" || state.status === "stopped") {
        notify(ctx, "loop: no active run", "info");
        clearWidget(ctx);
        return;
      }
      if (isWaitingForContinuation(ctx, state)) {
        clearContinuationWait();
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
      await replaceForIteration(ctx, { ...state, status: "active" });
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
      } else if ((state.pendingRetune ?? state.remainingBudget) === 0) {
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
        notify(ctx, "loop is paused; use /loop resume or /loop stop", "error");
      } else {
        notify(ctx, "a loop is already active; use /loop <positive-count> to retune it", "error");
      }
      return;
    }

    const initial: LoopState = {
      version: 1,
      runId: randomUUID(),
      prompt: parsed.prompt,
      currentIteration: 1,
      remainingBudget: parsed.count - 1,
      pendingRetune: null,
      delay: parsed.delay,
      status: "active",
      ...(contextIdentity(ctx).id ? { ownerSessionId: contextIdentity(ctx).id } : {}),
      ...(contextIdentity(ctx).file ? { ownerSessionFile: contextIdentity(ctx).file } : {}),
    };
    await replaceForIteration(ctx, initial);
  }

  pi.on("session_start", (event, ctx) => {
    clearContinuationWait();
    currentSessionManagerRef = ctx.sessionManager;
    transitionInFlight = false;
    handledSettlementKey = undefined;
    const loaded = latestStateFromContext(ctx);
    const owned = loaded && stateBelongsToContext(loaded, ctx) ? loaded : undefined;
    runState = owned;
    if (!owned || owned.status === "inactive") clearWidget(ctx);
    else renderWidget(ctx, owned);
    // `event` is intentionally accepted so this handler is safe for all
    // startup/new/resume reasons. New-session setup writes the transferred
    // state just after this event; before_agent_start restores it lazily.
    void event;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded)) return;
    transitionInFlight = false;
    renderWidget(ctx, loaded);
  });

  pi.on("agent_start", (_event, ctx) => {
    const loaded = currentState(ctx);
    if (loaded && statusIsActive(loaded)) renderWidget(ctx, loaded);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const stopReason = (event.message as { stopReason?: string }).stopReason;
    if (stopReason !== "aborted" && stopReason !== "error") return;
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded) || transitionInFlight) return;
    clearContinuationWait();
    const paused = { ...loaded, status: "paused" as const };
    persist(pi, paused);
    renderWidget(ctx, paused);
  });

  pi.on("agent_end", (event, ctx) => {
    const assistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant") as { stopReason?: string } | undefined;
    if (!assistant || (assistant.stopReason !== "aborted" && assistant.stopReason !== "error")) return;
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded) || transitionInFlight) return;
    clearContinuationWait();
    const paused = { ...loaded, status: "paused" as const };
    persist(pi, paused);
    renderWidget(ctx, paused);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const loaded = currentState(ctx);
    if (!loaded || !statusIsActive(loaded) || transitionInFlight) return;
    const key = stateKey(ctx, loaded);
    if (handledSettlementKey === key) return;
    handledSettlementKey = key;
    scheduleContinuation(ctx, loaded);
  });

  pi.on("session_tree", (_event, ctx) => {
    clearContinuationWait();
    currentSessionManagerRef = ctx.sessionManager;
    handledSettlementKey = undefined;
    const loaded = latestStateFromContext(ctx);
    const owned = loaded && stateBelongsToContext(loaded, ctx) ? loaded : undefined;
    runState = owned;
    if (!owned || owned.status === "inactive") clearWidget(ctx);
    else renderWidget(ctx, owned);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearContinuationWait();
    const loaded = currentState(ctx);
    if (loaded && statusIsActive(loaded) && !transitionInFlight) {
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
    description: "<count> [--delay <duration>] <prompt> | <count> | ±<count> | delay | prompt | append | status | resume | stop — Run a bounded fresh-session loop",
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
