import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const WAIT_WIDGET_KEY = "pi-wait";
export const WAIT_STATE_ENTRY = "pi-wait-state-v1";
export const WAIT_USAGE = "usage: /wait <duration> [prompt] | /wait now | /wait pause | /wait resume | /wait status | /wait cancel";
export const MAX_WAIT_MS = 24 * 24 * 60 * 60 * 1_000;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h|d)$/;
const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export type ParsedWaitCommand =
  | { kind: "schedule"; delay: number; prompt?: string }
  | { kind: "now" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "cancel" };

export type PendingWait =
  | { prompt: string; dueAt: number; paused?: undefined }
  | { prompt: string; delay: number; dueAt?: undefined; paused?: undefined }
  | { prompt: string; remaining: number; paused: true; dueAt?: undefined };

export type WaitState = { version: 1; pending: PendingWait | null };

type WaitEntry = { type?: string; customType?: string; data?: unknown };
type ArgumentCompletion = { value: string; label: string; description?: string };
export type WidgetTheme = Pick<Theme, "fg" | "bold">;

const PLAIN_THEME: WidgetTheme = { fg: (_color, text) => text, bold: (text) => text };

export function parseWaitDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error("duration must look like 30s, 5m, 1h, or 1d");

  const milliseconds = Math.round(Number(match[1]) * DURATION_MULTIPLIERS[match[2]]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("duration must be at least 1ms");
  }
  if (milliseconds > MAX_WAIT_MS) {
    throw new Error("duration must not exceed 24d");
  }
  return milliseconds;
}

export function parseWaitCommand(args: string): ParsedWaitCommand {
  const input = args.trim();
  if (!input || input === "status") return { kind: "status" };
  if (input === "cancel") return { kind: "cancel" };
  if (input === "now") return { kind: "now" };
  if (input === "pause") return { kind: "pause" };
  if (input === "resume") return { kind: "resume" };

  const separator = input.search(/\s/);
  if (separator < 0) return { kind: "schedule", delay: parseWaitDuration(input) };

  const delay = parseWaitDuration(input.slice(0, separator));
  const prompt = input.slice(separator).trim();
  return { kind: "schedule", delay, ...(prompt ? { prompt } : {}) };
}

export function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseWaitState(value: unknown): WaitState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (value.pending === null) return { version: 1, pending: null };
  if (!isRecord(value.pending) || typeof value.pending.prompt !== "string" || !value.pending.prompt.trim()) {
    return undefined;
  }

  const prompt = value.pending.prompt;
  if (value.pending.paused === true) {
    const remaining = value.pending.remaining;
    if (!Number.isSafeInteger(remaining) || (remaining as number) < 1 || (remaining as number) > MAX_WAIT_MS) {
      return undefined;
    }
    return { version: 1, pending: { prompt, remaining: remaining as number, paused: true } };
  }
  if (value.pending.paused !== undefined) return undefined;

  if (value.pending.dueAt !== undefined) {
    const dueAt = value.pending.dueAt;
    if (!Number.isSafeInteger(dueAt) || (dueAt as number) < 0) return undefined;
    return { version: 1, pending: { prompt, dueAt: dueAt as number } };
  }

  const delay = value.pending.delay;
  if (!Number.isSafeInteger(delay) || (delay as number) < 1 || (delay as number) > MAX_WAIT_MS) return undefined;
  return { version: 1, pending: { prompt, delay: delay as number } };
}

export function readWaitState(entries: readonly WaitEntry[] | readonly unknown[]): WaitState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WAIT_STATE_ENTRY) continue;
    return parseWaitState(entry.data);
  }
  return undefined;
}

export function formatWaitWidget(
  wait: PendingWait,
  width: number,
  now = Date.now(),
  theme: WidgetTheme = PLAIN_THEME,
): string {
  const prompt = wait.prompt.replace(/\s+/g, " ").trim();
  const [icon, state, hints] = wait.paused
    ? [theme.fg("muted", "⏸"), `paused ${formatRemaining(wait.remaining)}`, "/wait resume · /wait cancel"]
    : wait.dueAt === undefined
      ? [theme.fg("muted", "◌"), "queued", "/wait cancel"]
      : [theme.fg("warning", "◷"), formatRemaining(wait.dueAt - now), "/wait pause · /wait cancel"];
  const separator = theme.fg("dim", " · ");
  return truncateToWidth(
    `${icon} ${theme.fg("accent", theme.bold("WAIT"))} ${theme.fg("muted", state)}${separator}`
      + `${theme.fg("text", prompt)}${separator}${theme.fg("dim", hints)}`,
    width,
    "…",
  );
}

function completeWaitArguments(prefix: string): ArgumentCompletion[] | null {
  const query = prefix.trimStart().toLowerCase();
  const candidates: ArgumentCompletion[] = [
    { value: "now", label: "now", description: "Send the queued message now" },
    { value: "pause", label: "pause", description: "Pause the active countdown" },
    { value: "resume", label: "resume", description: "Resume the paused countdown" },
    { value: "cancel", label: "cancel", description: "Cancel the queued message" },
    { value: "status", label: "status", description: "Show the queued message and remaining time" },
    ...["30s", "1m", "5m", "15m", "1h"].map((duration) => ({
      value: `${duration} `,
      label: `${duration} <prompt>`,
      description: `Send a message after ${duration}`,
    })),
  ];
  const matches = candidates.filter(({ value }) => value.toLowerCase().startsWith(query));
  return matches.length > 0 ? matches : null;
}

function createWaitAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const commandMatch = /^\/(\w*)$/.exec(beforeCursor);
      if (commandMatch && "wait".startsWith(commandMatch[1].toLowerCase())) {
        const existing = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const wait = {
          value: "/wait ",
          label: "/wait",
          description: "Send a queued message after a timeout",
        };
        if (existing?.prefix === commandMatch[0]) {
          return {
            ...existing,
            items: [wait, ...existing.items.filter(({ value }) => value !== wait.value)],
          };
        }
        return { prefix: commandMatch[0], items: [wait] };
      }

      const argumentMatch = /^\/wait\s+(\S*)$/.exec(beforeCursor);
      if (argumentMatch) {
        const items = completeWaitArguments(argumentMatch[1]);
        if (items) return { prefix: argumentMatch[1], items };
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function waitExtension(pi: ExtensionAPI): void {
  let pending: PendingWait | undefined;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let widgetVisible = false;
  let delivering = false;
  let deliveryStarted = false;
  let lastBusy: boolean | undefined;
  let busyQueued = false;
  function emitBusy(): void {
    if (busyQueued) return;
    busyQueued = true;
    queueMicrotask(() => {
      busyQueued = false;
      if (!sessionContext) return;
      const busy = pending !== undefined || delivering;
      if (lastBusy === busy) return;
      lastBusy = busy;
      pi.events.emit("pi-wait:busy", busy);
    });
  }
  let requestWidgetRender: (() => void) | undefined;

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }
    const output = `[pi-wait] ${message}`;
    if (type === "error") console.error(output);
    else console.warn(output);
  }

  function clearTimers(): void {
    if (deliveryTimer) clearTimeout(deliveryTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    deliveryTimer = undefined;
    countdownTimer = undefined;
  }

  function clearWidget(ctx = sessionContext): void {
    if (!ctx?.hasUI || !widgetVisible) return;
    widgetVisible = false;
    requestWidgetRender = undefined;
    ctx.ui.setWidget(WAIT_WIDGET_KEY, undefined);
  }

  function renderWidget(ctx = sessionContext): void {
    if (!ctx?.hasUI || !pending) {
      clearWidget(ctx);
      return;
    }
    if (widgetVisible) {
      requestWidgetRender?.();
      return;
    }
    ctx.ui.setWidget(WAIT_WIDGET_KEY, (tui, theme) => {
      requestWidgetRender = () => tui.requestRender();
      return {
        render: (width) => pending ? [formatWaitWidget(pending, width, Date.now(), theme)] : [],
        invalidate: () => {},
        dispose: () => { requestWidgetRender = undefined; },
      };
    });
    widgetVisible = true;
  }

  function persist(wait: PendingWait | undefined): void {
    pi.appendEntry(WAIT_STATE_ENTRY, { version: 1, pending: wait ?? null } satisfies WaitState);
    emitBusy();
  }

  function cancel(ctx: ExtensionContext, announce: boolean, save = true): boolean {
    if (!pending) {
      clearWidget(ctx);
      if (announce) notify(ctx, "wait: no queued message");
      return false;
    }
    pending = undefined;
    clearTimers();
    clearWidget(ctx);
    if (save) persist(undefined);
    if (announce) notify(ctx, "queued message cancelled");
    return true;
  }

  function deliver(ctx: ExtensionContext, expected: PendingWait): void {
    if (pending !== expected) return;
    pending = undefined;
    delivering = true;
    deliveryStarted = false;
    clearTimers();
    clearWidget(ctx);
    persist(undefined);
    try {
      if (ctx.isIdle()) pi.sendUserMessage(expected.prompt, { expandPromptTemplates: true });
      else {
        pi.sendUserMessage(expected.prompt, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
      }
    } catch (error) {
      delivering = false;
      emitBusy();
      notify(ctx, `could not send queued message: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function arm(ctx: ExtensionContext, wait: PendingWait, delay: number): void {
    const armed: PendingWait = { prompt: wait.prompt, dueAt: Date.now() + delay };
    pending = armed;
    persist(armed);
    deliveryTimer = setTimeout(() => deliver(ctx, armed), delay);
    countdownTimer = setInterval(() => renderWidget(ctx), 1_000);
    renderWidget(ctx);
  }

  function restore(ctx: ExtensionContext, wait: PendingWait): void {
    if (wait.paused) {
      pending = wait;
      renderWidget(ctx);
      return;
    }
    if (wait.dueAt === undefined) {
      arm(ctx, wait, wait.delay);
      return;
    }

    pending = wait;
    const delay = Math.max(0, wait.dueAt - Date.now());
    deliveryTimer = setTimeout(() => deliver(ctx, wait), delay);
    countdownTimer = setInterval(() => renderWidget(ctx), 1_000);
    renderWidget(ctx);
  }

  function schedule(ctx: ExtensionContext, delay: number, prompt: string, afterAgent: boolean): void {
    const replaced = cancel(ctx, false, false);
    if (afterAgent) {
      pending = { prompt, delay };
      persist(pending);
      renderWidget(ctx);
      notify(ctx, replaced
        ? "replaced queued message; timer starts after the agent settles"
        : "wait queued; timer starts after the agent settles");
      return;
    }

    arm(ctx, { prompt, delay }, delay);
    const message = replaced
      ? `replaced queued message; waiting ${formatRemaining(delay)}`
      : `waiting ${formatRemaining(delay)}`;
    notify(ctx, message);
  }

  function pause(ctx: ExtensionContext): void {
    if (!pending) {
      notify(ctx, "wait: no queued message");
      return;
    }
    if (pending.paused) {
      notify(ctx, "wait: already paused");
      return;
    }
    if (pending.dueAt === undefined) {
      notify(ctx, "wait: timer has not started yet");
      return;
    }

    const remaining = Math.max(1, pending.dueAt - Date.now());
    pending = { prompt: pending.prompt, remaining, paused: true };
    persist(pending);
    clearTimers();
    renderWidget(ctx);
    notify(ctx, `wait paused with ${formatRemaining(remaining)} remaining`);
  }

  function resume(ctx: ExtensionContext): void {
    if (!pending) {
      notify(ctx, "wait: no queued message");
      return;
    }
    if (!pending.paused) {
      notify(ctx, "wait: not paused");
      return;
    }

    const wait = pending;
    arm(ctx, wait, wait.remaining);
    notify(ctx, `wait resumed; waiting ${formatRemaining(wait.remaining)}`);
  }

  function reschedule(ctx: ExtensionContext, delay: number): void {
    if (!pending) {
      notify(ctx, "wait: no queued message; provide a prompt", "error");
      return;
    }

    const wait = pending;
    clearTimers();
    if (wait.paused) {
      pending = { prompt: wait.prompt, remaining: delay, paused: true };
      persist(pending);
      renderWidget(ctx);
      notify(ctx, `updated paused wait; ${formatRemaining(delay)} remaining`);
      return;
    }
    if (wait.dueAt === undefined) {
      pending = { prompt: wait.prompt, delay };
      persist(pending);
      renderWidget(ctx);
      notify(ctx, "updated queued message; timer starts after the agent settles");
      return;
    }

    arm(ctx, wait, delay);
    notify(ctx, `updated wait; waiting ${formatRemaining(delay)}`);
  }

  function handleCommand(args: string, ctx: ExtensionContext, afterAgent: boolean): void {
    try {
      const command = parseWaitCommand(args);
      if (command.kind === "cancel") {
        cancel(ctx, true);
        return;
      }
      if (command.kind === "now") {
        if (!pending) notify(ctx, "wait: no queued message");
        else deliver(ctx, pending);
        return;
      }
      if (command.kind === "pause") {
        pause(ctx);
        return;
      }
      if (command.kind === "resume") {
        resume(ctx);
        return;
      }
      if (command.kind === "status") {
        if (!pending) notify(ctx, "wait: no queued message");
        else if (pending.paused) notify(ctx, `wait: paused with ${formatRemaining(pending.remaining)} remaining\n${pending.prompt}`);
        else if (pending.dueAt === undefined) notify(ctx, `wait: timer starts after the agent settles\n${pending.prompt}`);
        else notify(ctx, `wait: ${formatRemaining(pending.dueAt - Date.now())}\n${pending.prompt}`);
        return;
      }
      if (command.prompt === undefined) reschedule(ctx, command.delay);
      else schedule(ctx, command.delay, command.prompt, afterAgent);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.registerTool({
    name: "wait_then_continue",
    label: "Wait Then Continue",
    description: "Schedule a prompt after a delay and end the current turn. During an active /loop, the iteration stays in this session until the wait and its follow-up turn finish.",
    executionMode: "sequential",
    parameters: Type.Object({
      duration: Type.String({
        description: "Delay such as 30s, 5m, 1h, or 1d",
      }),
      prompt: Type.String({
        minLength: 1,
        description: "Prompt to send when the delay expires",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const delay = parseWaitDuration(params.duration);
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("a continuation prompt is required");
      schedule(ctx, delay, prompt, true);
      return {
        content: [{ type: "text", text: `Continuation scheduled in ${formatRemaining(delay)}.` }],
        details: { duration: params.duration, delay, prompt },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "cancel_wait",
    label: "Cancel Wait",
    description: "Cancel the queued wait and prevent its continuation prompt from being sent. Does not end the current turn.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cancelled = cancel(ctx, false);
      return {
        content: [{ type: "text", text: cancelled ? "Queued wait cancelled." : "No wait is queued." }],
        details: { cancelled },
      };
    },
  });

  pi.on("session_start", (event, ctx) => {
    sessionContext = ctx;
    pending = undefined;
    clearTimers();
    clearWidget(ctx);
    delivering = false;
    deliveryStarted = false;
    lastBusy = undefined;
    if (event.reason === "reload") {
      const state = readWaitState(ctx.sessionManager.getBranch());
      if (state?.pending) restore(ctx, state.pending);
    }
    emitBusy();
    if (ctx.hasUI) ctx.ui.addAutocompleteProvider((current) => createWaitAutocompleteProvider(current));
  });

  pi.on("before_agent_start", () => {
    if (delivering) deliveryStarted = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (delivering && deliveryStarted) {
      delivering = false;
      emitBusy();
    }
    if (!pending || pending.dueAt !== undefined || pending.paused) return;
    const wait = pending;
    arm(ctx, wait, wait.delay);
    notify(ctx, `waiting ${formatRemaining(wait.delay)}`);
  });

  // Registered extension commands execute immediately and do not receive the
  // selected streaming behavior. Handle /wait as input so follow-ups can defer
  // the timer while steering submissions still start it immediately.
  pi.on("input", (event, ctx) => {
    const match = /^\/wait(?:\s+(.*))?$/s.exec(event.text.trim());
    if (!match) return { action: "continue" };
    handleCommand(match[1] ?? "", ctx, event.streamingBehavior === "followUp");
    return { action: "handled" };
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "reload") {
      clearTimers();
      clearWidget(ctx);
      pending = undefined;
    } else {
      cancel(ctx, false);
    }
    sessionContext = undefined;
    delivering = false;
    deliveryStarted = false;
    lastBusy = undefined;
  });
}
