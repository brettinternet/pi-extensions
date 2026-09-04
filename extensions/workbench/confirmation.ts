import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkbenchInput } from "./client.ts";
import type { CommandRisk } from "./command-policy.ts";

// This module intentionally owns a local copy of the wire contract. Producers and
// consumers may be installed as unrelated packages and communicate only via pi.events.
export const CONFIRMATION_REQUESTED_EVENT = "pi:confirmation:v1:requested";
export const CONFIRMATION_ACKNOWLEDGED_PREFIX = "pi:confirmation:v1:acknowledged:";
export const CONFIRMATION_RESOLVED_PREFIX = "pi:confirmation:v1:resolved:";
export const CONFIRMATION_CANCELLED_EVENT = "pi:confirmation:v1:cancelled";

export const CONFIRMATION_PROVIDER = "herdr-workbench";
export const MAX_PENDING_CONFIRMATIONS = 32;
export const MAX_CONFIRMATION_TITLE_CHARS = 160;
export const MAX_CONFIRMATION_SUMMARY_CHARS = 4_000;
export const CONFIRMATION_EXPIRY_MS = 120_000;
export const LIVE_ACK_WAIT_MS = 250;

export interface ConfirmationRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  sessionFile?: string;
  provider: string;
  operationId: string;
  riskCategory: string;
  title: string;
  summary: string;
  expiresAt: number;
}

interface ConfirmationReply {
  version: 1;
  requestId: string;
  sessionId: string;
  sessionFile?: string;
  provider: string;
  operationId: string;
}

interface ConfirmationResolution extends ConfirmationReply {
  decision: "approved" | "denied";
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function sameScope(reply: ConfirmationReply, request: ConfirmationRequest): boolean {
  return reply.sessionId === request.sessionId && reply.sessionFile === request.sessionFile;
}

function parseReply(
  value: unknown,
  request: ConfirmationRequest,
  now = Date.now(),
): ConfirmationReply | undefined {
  if (now >= request.expiresAt || typeof value !== "object" || value === null) return undefined;
  const reply = value as Partial<ConfirmationReply>;
  if (reply.version !== 1 || reply.requestId !== request.requestId ||
    reply.provider !== request.provider || reply.operationId !== request.operationId ||
    typeof reply.sessionId !== "string" || !sameScope(reply as ConfirmationReply, request)) return undefined;
  return reply as ConfirmationReply;
}

export function parseConfirmationResolution(
  value: unknown,
  request: ConfirmationRequest,
  now = Date.now(),
): ConfirmationResolution | undefined {
  const reply = parseReply(value, request, now);
  if (!reply || typeof value !== "object" || value === null) return undefined;
  const decision = (value as { decision?: unknown }).decision;
  return decision === "approved" || decision === "denied"
    ? { ...reply, decision }
    : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Confirmation aborted");
}

function waitForEvent<T>(
  pi: ExtensionAPI,
  event: string,
  parse: (value: unknown) => T | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const unsubscribe = pi.events.on(event, (value) => {
      const parsed = parse(value);
      if (parsed !== undefined) finish(parsed);
    });
    const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
    const onAbort = (): void => finish(undefined, abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function buildConfirmationRequest(
  input: WorkbenchInput,
  cwd: string,
  risk: CommandRisk,
  scope: { sessionId: string; sessionFile?: string },
  now = Date.now(),
): ConfirmationRequest {
  const operation = JSON.stringify({ ...input, cwd });
  const summary = `Operation: ${operation}`;
  if (!boundedText(summary, MAX_CONFIRMATION_SUMMARY_CHARS)) {
    throw new Error(`Command confirmation summary exceeds ${MAX_CONFIRMATION_SUMMARY_CHARS} characters`);
  }
  return {
    version: 1,
    requestId: randomUUID(),
    ...scope,
    provider: CONFIRMATION_PROVIDER,
    operationId: `sha256:${createHash("sha256").update(operation).digest("hex")}`,
    riskCategory: risk.category,
    title: `Approve ${risk.category} command?`.slice(0, MAX_CONFIRMATION_TITLE_CHARS),
    summary,
    expiresAt: now + CONFIRMATION_EXPIRY_MS,
  };
}

export class ConfirmationBroker {
  readonly #pi: ExtensionAPI;
  readonly #pending = new Map<string, AbortController>();

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  async confirm(
    input: WorkbenchInput,
    risk: CommandRisk,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#pending.size >= MAX_PENDING_CONFIRMATIONS) {
      throw new Error("Too many pending confirmations");
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    const request = buildConfirmationRequest(input, input.cwd ?? ctx.cwd, risk, {
      sessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile ? { sessionFile } : {}),
    });

    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this.#pending.set(request.requestId, controller);
    try {
      const acknowledgement = waitForEvent(
        this.#pi,
        `${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`,
        (value) => parseReply(value, request),
        combined,
        LIVE_ACK_WAIT_MS,
      );
      this.#pi.events.emit(CONFIRMATION_REQUESTED_EVENT, request);
      if (await acknowledgement) {
        const remaining = request.expiresAt - Date.now();
        if (remaining <= 0) throw new Error("Confirmation request expired");
        const resolution = await waitForEvent(
          this.#pi,
          `${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`,
          (value) => parseConfirmationResolution(value, request),
          combined,
          remaining,
        );
        if (!resolution) throw new Error("Confirmation request expired without a decision");
        if (resolution.decision !== "approved") throw new Error("Command was denied by the user");
        return;
      }

      this.#pi.events.emit(CONFIRMATION_CANCELLED_EVENT, request);
      if (!ctx.hasUI || ctx.mode !== "tui") {
        throw new Error(`Confirmation required for ${risk.category}, but voice and interactive TUI confirmation are unavailable`);
      }
      const approved = await ctx.ui.confirm(request.title, `${request.summary}\n\nReason: ${risk.reason}`, {
        signal: combined,
        timeout: Math.max(0, request.expiresAt - Date.now()),
      });
      if (combined.aborted) throw abortError(combined);
      if (Date.now() >= request.expiresAt) throw new Error("Confirmation request expired");
      if (!approved) throw new Error("Command was denied by the user");
    } finally {
      this.#pending.delete(request.requestId);
      try {
        this.#pi.events.emit(CONFIRMATION_CANCELLED_EVENT, request);
      } catch {}
      controller.abort(new Error("Confirmation completed"));
    }
  }

  abortAll(reason = "Session shut down"): void {
    for (const controller of this.#pending.values()) controller.abort(new Error(reason));
    this.#pending.clear();
  }
}
