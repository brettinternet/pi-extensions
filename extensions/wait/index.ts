import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const WAIT_WIDGET_KEY = "pi-wait";
export const WAIT_USAGE = "usage: /wait <duration> <prompt> | /wait status | /wait cancel";
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
  | { kind: "schedule"; delay: number; prompt: string }
  | { kind: "status" }
  | { kind: "cancel" };

export type PendingWait =
  | { prompt: string; dueAt: number }
  | { prompt: string; delay: number; dueAt?: undefined };

type ArgumentCompletion = { value: string; label: string; description?: string };

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

  const separator = input.search(/\s/);
  if (separator < 0) throw new Error(`a prompt is required; ${WAIT_USAGE}`);

  const delay = parseWaitDuration(input.slice(0, separator));
  const prompt = input.slice(separator).trim();
  if (!prompt) throw new Error(`a prompt is required; ${WAIT_USAGE}`);
  return { kind: "schedule", delay, prompt };
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

export function formatWaitWidget(wait: PendingWait, width: number, now = Date.now()): string {
  const prompt = wait.prompt.replace(/\s+/g, " ").trim();
  const state = wait.dueAt === undefined ? "queued" : formatRemaining(wait.dueAt - now);
  return truncateToWidth(
    `wait ${state} · /wait cancel · ${prompt}`,
    width,
    "…",
  );
}

function completeWaitArguments(prefix: string): ArgumentCompletion[] | null {
  const query = prefix.trimStart().toLowerCase();
  const candidates: ArgumentCompletion[] = [
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
    if (ctx?.hasUI) ctx.ui.setWidget(WAIT_WIDGET_KEY, undefined);
  }

  function renderWidget(ctx = sessionContext): void {
    if (!ctx?.hasUI || !pending) {
      clearWidget(ctx);
      return;
    }
    const wait = pending;
    ctx.ui.setWidget(WAIT_WIDGET_KEY, (_tui, _theme) => ({
      render: (width) => [formatWaitWidget(wait, width)],
      invalidate: () => {},
    }));
  }

  function cancel(ctx: ExtensionContext, announce: boolean): boolean {
    if (!pending) {
      clearWidget(ctx);
      if (announce) notify(ctx, "wait: no queued message");
      return false;
    }
    pending = undefined;
    clearTimers();
    clearWidget(ctx);
    if (announce) notify(ctx, "queued message cancelled");
    return true;
  }

  function deliver(ctx: ExtensionContext, expected: PendingWait): void {
    if (pending !== expected) return;
    pending = undefined;
    clearTimers();
    clearWidget(ctx);
    try {
      if (ctx.isIdle()) pi.sendUserMessage(expected.prompt, { expandPromptTemplates: true });
      else {
        pi.sendUserMessage(expected.prompt, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
      }
    } catch (error) {
      notify(ctx, `could not send queued message: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function arm(ctx: ExtensionContext, wait: PendingWait, delay: number): void {
    const armed: PendingWait = { prompt: wait.prompt, dueAt: Date.now() + delay };
    pending = armed;
    deliveryTimer = setTimeout(() => deliver(ctx, armed), delay);
    countdownTimer = setInterval(() => renderWidget(ctx), 1_000);
    renderWidget(ctx);
  }

  function schedule(ctx: ExtensionContext, delay: number, prompt: string, afterAgent: boolean): void {
    const replaced = cancel(ctx, false);
    if (afterAgent) {
      pending = { prompt, delay };
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

  function handleCommand(args: string, ctx: ExtensionContext, afterAgent: boolean): void {
    try {
      const command = parseWaitCommand(args);
      if (command.kind === "cancel") {
        cancel(ctx, true);
        return;
      }
      if (command.kind === "status") {
        if (!pending) notify(ctx, "wait: no queued message");
        else if (pending.dueAt === undefined) notify(ctx, `wait: timer starts after the agent settles\n${pending.prompt}`);
        else notify(ctx, `wait: ${formatRemaining(pending.dueAt - Date.now())}\n${pending.prompt}`);
        return;
      }
      schedule(ctx, command.delay, command.prompt, afterAgent);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.registerTool({
    name: "wait_then_continue",
    label: "Wait Then Continue",
    description: "Schedule a prompt after a delay and end the current turn. Use for standalone, same-session polling; do not use during an active /loop, which replaces the session after the agent settles.",
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

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    pending = undefined;
    clearTimers();
    clearWidget(ctx);
    if (ctx.hasUI) ctx.ui.addAutocompleteProvider((current) => createWaitAutocompleteProvider(current));
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!pending || pending.dueAt !== undefined) return;
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

  pi.on("session_shutdown", (_event, ctx) => {
    cancel(ctx, false);
    sessionContext = undefined;
  });
}
