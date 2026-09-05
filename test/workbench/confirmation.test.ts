import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIRMATION_ACKNOWLEDGED_PREFIX,
  CONFIRMATION_RELEASED_PREFIX,
  CONFIRMATION_REQUESTED_EVENT,
  CONFIRMATION_RESOLVED_PREFIX,
  buildConfirmationRequest,
  buildForceCloseConfirmationRequest,
  ConfirmationBroker,
  LIVE_ACK_WAIT_MS,
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
  test("canonicalizes job start operation identities", () => {
    const first = buildConfirmationRequest({
      action: "job.start",
      command: ["git", "push"],
      cwd: "/repo",
      placement: "down",
      focus: false,
      interactive: true,
    }, "/fallback", risk, { sessionId: "session" });
    const reordered = buildConfirmationRequest({
      interactive: true,
      focus: false,
      placement: "down",
      cwd: "/repo",
      command: ["git", "push"],
      action: "job.start",
    }, "/fallback", risk, { sessionId: "session" });
    expect(reordered.operationId).toBe(first.operationId);

    const differentCommand = buildConfirmationRequest({
      action: "job.start",
      command: ["git", "pull"],
      cwd: "/repo",
      placement: "down",
      focus: false,
      interactive: true,
    }, "/fallback", risk, { sessionId: "session" });
    const differentCwd = buildConfirmationRequest({
      action: "job.start",
      command: ["git", "push"],
      cwd: "/other",
      placement: "down",
      focus: false,
      interactive: true,
    }, "/fallback", risk, { sessionId: "session" });
    expect(differentCommand.operationId).not.toBe(first.operationId);
    expect(differentCwd.operationId).not.toBe(first.operationId);
  });

  test("canonicalizes force-close identities and includes force and target", () => {
    const first = buildForceCloseConfirmationRequest({
      action: "job.close",
      jobId: "job-1",
      force: true,
      cwd: "/display-only",
      focus: false,
    }, "/repo", { kind: "job", id: "job-1" }, { sessionId: "session" });
    const reordered = buildForceCloseConfirmationRequest({
      focus: false,
      force: true,
      jobId: "job-1",
      action: "job.close",
      cwd: "/another-display-only-value",
    }, "/different-fallback", { kind: "job", id: "job-1" }, { sessionId: "session" });
    expect(reordered.operationId).toBe(first.operationId);

    const differentForce = buildForceCloseConfirmationRequest({
      action: "job.close",
      jobId: "job-1",
      force: false,
    }, "/repo", { kind: "job", id: "job-1" }, { sessionId: "session" });
    const differentTarget = buildForceCloseConfirmationRequest({
      action: "job.close",
      jobId: "job-1",
      force: true,
    }, "/repo", { kind: "job", id: "job-2" }, { sessionId: "session" });
    expect(differentForce.operationId).not.toBe(first.operationId);
    expect(differentTarget.operationId).not.toBe(first.operationId);
  });

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

  test("serializes two released prompts and rechecks each expiry after the prior prompt", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    let promptCount = 0;
    const firstPrompt = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { broker, ctx, confirmations } = harness({
      mode: "tui",
      confirm: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        promptCount += 1;
        if (promptCount === 1) await firstPrompt;
        active -= 1;
        return true;
      },
    });
    const otherInput = { action: "job.start" as const, command: ["git", "pull"], focus: false };
    const first = broker.confirm(input, risk, ctx, new AbortController().signal);
    const second = broker.confirm(otherInput, risk, ctx, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, LIVE_ACK_WAIT_MS + 20));
    expect(confirmations).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(confirmations).toHaveLength(2);
    expect(maximumActive).toBe(1);
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

  test("hands a synchronously released voice request to TUI instead of denying it", async () => {
    const { bus, broker, ctx, confirmations } = harness({
      mode: "tui",
      confirm: async () => true,
    });
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      bus.emit(`${CONFIRMATION_RELEASED_PREFIX}${request.requestId}`, reply(request));
      bus.emit(`${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`, reply(request, "denied"));
    });

    await broker.confirm(input, risk, ctx, new AbortController().signal);
    expect(confirmations).toHaveLength(1);
  });

  test("locks a denied operation for the run but permits another digest and a reset run", async () => {
    const { bus, broker, ctx } = harness();
    const otherInput = { action: "job.start" as const, command: ["git", "pull"], focus: false };
    const requested: ConfirmationRequest[] = [];
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      requested.push(request);
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      setImmediate(() => bus.emit(
        `${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`,
        reply(request, requested.length === 1 ? "denied" : "approved"),
      ));
    });

    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("denied");
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("blocked until a new agent run");
    await broker.confirm(otherInput, risk, ctx, new AbortController().signal);
    expect(requested).toHaveLength(2);

    broker.resetRun();
    await broker.confirm(input, risk, ctx, new AbortController().signal);
    expect(requested).toHaveLength(3);
  });

  test("locks an expired confirmation before another request can be emitted", async () => {
    const { bus, broker, ctx } = harness();
    let requests = 0;
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      requests += 1;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      request.expiresAt = Date.now() - 1;
    });

    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("expired");
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("blocked until a new agent run");
    expect(requests).toBe(1);
  });

  test("locks an aborted confirmation until the next run", async () => {
    const { bus, broker, ctx } = harness();
    const abort = new AbortController();
    bus.on(CONFIRMATION_REQUESTED_EVENT, (value) => {
      const request = value as ConfirmationRequest;
      bus.emit(`${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`, reply(request));
      setImmediate(() => abort.abort(new Error("confirmation aborted by test")));
    });

    await expect(broker.confirm(input, risk, ctx, abort.signal))
      .rejects.toThrow("confirmation aborted by test");
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("blocked until a new agent run");
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
    await expect(broker.confirm(input, risk, ctx, new AbortController().signal))
      .rejects.toThrow("blocked until a new agent run");
  });
});
