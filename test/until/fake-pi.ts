import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { vi } from "bun:test";

import piUntil from "../../extensions/until/index.ts";
import type { PiUntilOptions, WatchReceipt } from "../../extensions/until/index.ts";
import type { UntilParameters } from "../../extensions/until/command.ts";
import type { TelemetryEventInput } from "../../extensions/until/telemetry.ts";

export type UntilToolParams = UntilParameters;

export interface UntilToolResult {
  content: { type: "text"; text: string }[];
  details?: WatchReceipt | { watches: WatchReceipt[] };
}

/** The single-watch receipt from start/status/cancel results. */
export const receiptOf = (result: UntilToolResult): WatchReceipt => {
  if (result.details === undefined || "watches" in result.details) {
    throw new Error("expected a single watch receipt");
  }
  return result.details;
};

export type UntilToolExecute = (
  toolCallId: string,
  params: UntilToolParams,
  signal: AbortSignal,
  onUpdate: undefined,
  context: ExtensionContext
) => Promise<UntilToolResult>;

export interface SentMessage {
  readonly message: {
    customType: string;
    content: string;
    details?: unknown;
    display?: boolean;
  };
  readonly options?: { deliverAs?: string; triggerTurn?: boolean };
}

export interface EmittedEvent {
  readonly channel: string;
  readonly data: unknown;
}

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionEvent =
  | { type: "session_start"; reason: StartReason }
  | { type: "session_shutdown"; reason: ShutdownReason }
  | { type: "agent_start" }
  | { type: "agent_settled" }
  | MessageStartEvent;

type SessionHandler = (
  event: SessionEvent,
  ctx: ExtensionContext
) => Promise<void> | void;

/**
 * A fake Pi session that persists custom entries the way the real
 * SessionManager does, so several extension instances can share one session
 * across a simulated `/reload`.
 */
export class FakeSession {
  readonly entries: SessionEntry[] = [];
  readonly id = `session-${Math.random().toString(36).slice(2, 8)}`;

  appendCustom(customType: string, data: CustomEntry["data"]): void {
    this.entries.push({
      customType,
      data,
      id: `e${this.entries.length + 1}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
    });
  }

  context(
    overrides: Partial<{
      idle: boolean;
      mode: string;
      notify: ReturnType<typeof vi.fn>;
    }> = {}
  ) {
    const notify = overrides.notify ?? vi.fn();
    const setWidget = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      isIdle: () => overrides.idle ?? true,
      mode: overrides.mode ?? "tui",
      sessionManager: {
        getBranch: () => [...this.entries],
        getLeafId: () => this.entries.at(-1)?.id ?? "origin-entry",
        getSessionId: () => this.id,
      },
      ui: { notify, setWidget },
    };
    // SAFETY: the extension only touches cwd, mode, sessionManager.getBranch,
    // sessionManager.getSessionId, ui.notify, and ui.setWidget. Test doubles
    // for the rest of ExtensionContext would be dead weight.
    return { ctx: ctx as unknown as ExtensionContext, notify, setWidget };
  }
}

export interface FakeCommand {
  readonly getArgumentCompletions?: (
    prefix: string
  ) => readonly { value: string; label: string; description?: string }[] | null;
  readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

export interface FakeExtension {
  readonly acknowledgeMessage: (
    index: number,
    ctx: ExtensionContext
  ) => Promise<void>;
  readonly agentSettled: (ctx: ExtensionContext) => Promise<void>;
  readonly agentStart: (ctx: ExtensionContext) => Promise<void>;
  readonly appendEntry: (customType: string, data: CustomEntry["data"]) => void;
  readonly commands: Map<string, FakeCommand>;
  readonly emitted: EmittedEvent[];
  readonly entries: { customType: string; data: CustomEntry["data"] }[];
  readonly messageStart: (
    message: SentMessage["message"],
    ctx: ExtensionContext
  ) => Promise<void>;
  readonly messages: SentMessage[];
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly sessionStart: (
    reason: StartReason,
    ctx: ExtensionContext
  ) => Promise<void>;
  readonly shutdown: (reason: ShutdownReason) => Promise<void>;
  readonly telemetry: TelemetryEventInput[];
  readonly tool: UntilToolExecute;
  readonly toolGuidance: { readonly description: string; readonly promptGuidelines: readonly string[] };
}

/** Instantiate the extension against a fake Pi bound to `session`. */
interface FakeExtensionOptions extends PiUntilOptions {
  readonly acknowledgeMessages?: boolean;
  readonly appendEntryFailure?: (customType: string) => Error | undefined;
  readonly sendMessageFailure?: Error;
}

export const loadExtension = (
  session: FakeSession,
  options: FakeExtensionOptions = {}
): FakeExtension => {
  const messages: SentMessage[] = [];
  const entries: { customType: string; data: CustomEntry["data"] }[] = [];
  const telemetry: TelemetryEventInput[] = [];
  const commands = new Map<string, FakeCommand>();
  const handlers = new Map<string, SessionHandler>();
  let tool: UntilToolExecute | undefined;
  let toolGuidance: FakeExtension["toolGuidance"] | undefined;
  let lastContext = session.context().ctx;

  const appendEntry = (customType: string, data: CustomEntry["data"]): void => {
    const failure = options.appendEntryFailure?.(customType);
    if (failure !== undefined) throw failure;
    const persisted = JSON.parse(JSON.stringify(data)) as CustomEntry["data"];
    entries.push({ customType, data: persisted });
    session.appendCustom(customType, persisted);
  };
  const sendMessage = vi.fn(
    (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
      if (options.sendMessageFailure !== undefined) {
        throw options.sendMessageFailure;
      }
      messages.push({ message, options: sendOptions });
      if (options.acknowledgeMessages !== false) {
        queueMicrotask(() => {
          void handlers.get("message_start")?.(
            {
              message: {
                ...message,
                display: message.display ?? true,
                role: "custom",
                timestamp: Date.now(),
              },
              type: "message_start",
            },
            lastContext
          );
        });
      }
    }
  );

  const emitted: EmittedEvent[] = [];

  const pi = {
    appendEntry,
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
    },
    on: vi.fn((event: string, handler: SessionHandler) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn(
      (
        name: string,
        definition: FakeCommand
      ) => {
        commands.set(name, definition);
      }
    ),
    registerTool: vi.fn((definition: { execute: UntilToolExecute; description: string; promptGuidelines: readonly string[] }) => {
      toolGuidance = { description: definition.description, promptGuidelines: definition.promptGuidelines };
      tool = async (toolCallId, params, signal, onUpdate, context) => {
        lastContext = context;
        return definition.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          context
        );
      };
    }),
    sendMessage,
  };

  // SAFETY: the extension uses only appendEntry, events.emit, on,
  // registerCommand, registerTool, and sendMessage from ExtensionAPI.
  piUntil(pi as unknown as ExtensionAPI, {
    clock: options.clock,
    followUpDispatchAckMs: options.followUpDispatchAckMs,
    telemetry: options.telemetry ?? {
      enabled: true,
      filePath: "memory",
      record: async (_sessionId, event) => {
        telemetry.push(event);
      },
    },
  });

  if (!tool || !toolGuidance) {
    throw new Error("until tool was not registered");
  }

  const emit = async (event: SessionEvent, ctx: ExtensionContext) => {
    lastContext = ctx;
    await handlers.get(event.type)?.(event, ctx);
  };
  const shutdownContext = session.context().ctx;

  return {
    acknowledgeMessage: async (index, ctx) => {
      const sent = messages[index];
      if (sent === undefined) throw new Error(`unknown sent message: ${index}`);
      await emit(
        {
          message: {
            ...sent.message,
            display: sent.message.display ?? true,
            role: "custom",
            timestamp: Date.now(),
          },
          type: "message_start",
        },
        ctx
      );
    },
    agentSettled: (ctx) => emit({ type: "agent_settled" }, ctx),
    agentStart: (ctx) => emit({ type: "agent_start" }, ctx),
    appendEntry,
    commands,
    emitted,
    entries,
    messageStart: (message, ctx) =>
      emit(
        {
          message: {
            ...message,
            display: message.display ?? true,
            role: "custom",
            timestamp: Date.now(),
          },
          type: "message_start",
        },
        ctx
      ),
    messages,
    sendMessage,
    sessionStart: (reason, ctx) => emit({ reason, type: "session_start" }, ctx),
    shutdown: (reason) =>
      emit({ reason, type: "session_shutdown" }, shutdownContext),
    telemetry,
    tool,
    toolGuidance,
  };
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
