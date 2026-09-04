import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIRMATION_ACKNOWLEDGED_PREFIX,
  CONFIRMATION_REQUESTED_EVENT,
  CONFIRMATION_RESOLVED_PREFIX,
  buildConfirmationRequest,
  ConfirmationBroker,
  type ConfirmationRequest,
  parseConfirmationResolution,
} from "../../extensions/workbench/confirmation.ts";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function harness(options: { mode?: "tui" | "print"; confirm?: (title: string, message: string) => Promise<boolean> } = {}) {
  const bus = new EventBus();
  const confirmations: Array<{ title: string; message: string }> = [];
  const pi = { events: bus } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    mode: options.mode ?? "print",
    hasUI: (options.mode ?? "print") === "tui",
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/session.jsonl",
    },
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return options.confirm?.(title, message) ?? false;
      },
    },
  } as unknown as ExtensionContext;
  return { bus, broker: new ConfirmationBroker(pi), ctx, confirmations };
}

const input = { action: "job.start" as const, command: ["git", "push"], focus: false };
const risk = { category: "git-mutation" as const, reason: "git push mutates a remote" };

function reply(request: ConfirmationRequest, decision?: "approved" | "denied") {
  return {
    version: 1,
    requestId: request.requestId,
    sessionId: request.sessionId,
    sessionFile: request.sessionFile,
    provider: request.provider,
    operationId: request.operationId,
    ...(decision ? { decision } : {}),
  };
}

describe("workbench confirmation broker", () => {
  test("resolution validation rejects expired and mismatched operations", () => {
    const request = buildConfirmationRequest(input, "/repo", risk, {
      sessionId: "session",
      sessionFile: "/session.jsonl",
    }, 1_000);
    expect(parseConfirmationResolution(reply(request, "approved"), request, request.expiresAt)).toBeUndefined();
    expect(parseConfirmationResolution({
      ...reply(request, "approved"),
      operationId: "sha256:forged",
    }, request, 1_001)).toBeUndefined();
    expect(parseConfirmationResolution(reply(request, "approved"), request, 1_001)?.decision).toBe("approved");
  });

  test("uses TUI fallback and displays the complete operation", async () => {
    const { broker, ctx, confirmations } = harness({ mode: "tui", confirm: async () => true });
    await broker.confirm(input, risk, ctx, new AbortController().signal);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.message).toContain('"command":["git","push"]');
    expect(confirmations[0]!.message).toContain('"cwd":"/repo"');
  });

  test("fails closed without live voice or interactive TUI", async () => {
    const { broker, ctx } = harness();
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("voice and interactive TUI confirmation are unavailable");
  });

  test("accepts one exact voice approval", async () => {
    const { bus, broker, ctx, confirmations } = harness();
    let resolutions = 0;
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      setImmediate(() => {
        resolutions += 1;
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, reply(request, "approved"));
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, reply(request, "approved"));
      });
    });
    await broker.confirm(input, risk, ctx, new AbortController().signal);
    expect(resolutions).toBe(1);
    expect(confirmations).toHaveLength(0);
  });

  test("ignores forged scope and operation approvals", async () => {
    const { bus, broker, ctx } = harness();
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      setImmediate(() => {
        const approved = reply(request, "approved");
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, { ...approved, sessionId: "wrong" });
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, { ...approved, operationId: "sha256:forged" });
        bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, reply(request, "denied"));
      });
    });
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("denied");
  });

  test("session shutdown rejects a pending voice confirmation", async () => {
    const { bus, broker, ctx } = harness();
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      setImmediate(() => broker.abortAll());
    });
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("Session shut down");
  });
});
