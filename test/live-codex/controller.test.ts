import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_ACTIVITY_CANCEL_EVENT,
  BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX,
  BACKGROUND_ACTIVITY_SNAPSHOT_EVENT,
  BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX,
  type BackgroundActivityFinished,
  type BackgroundActivityStarted,
} from "../../extensions/live-codex/background-activity.ts";
import {
  CONFIRMATION_ACKNOWLEDGED_PREFIX,
  CONFIRMATION_RESOLVED_PREFIX,
  type ConfirmationRequest,
} from "../../extensions/live-codex/confirmation.ts";
import {
  LiveSession,
  type LiveSessionCallbacks,
  type LiveTransport,
  OutputActivityLatch,
} from "../../extensions/live-codex/controller.ts";
import type {
  LiveClientMessage,
  LiveServerEvent,
} from "../../extensions/live-codex/protocol.ts";
import type { LiveTransportOptions } from "../../extensions/live-codex/transport.ts";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  readonly emitted: Array<{ name: string; value: unknown }> = [];

  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, value: unknown): void {
    this.emitted.push({ name, value });
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

class FakeTransport implements LiveTransport {
  readonly sent: LiveClientMessage[] = [];
  readonly options: LiveTransportOptions;
  readonly connectPromise: Promise<void>;
  closed = false;
  sendError: Error | undefined;

  constructor(options: LiveTransportOptions, connectPromise = Promise.resolve()) {
    this.options = options;
    this.connectPromise = connectPromise;
  }

  connect(): Promise<void> {
    return this.connectPromise;
  }

  async send(message: LiveClientMessage): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }

  pushAudio(_samples: Float32Array): void {}
  setMuted(_muted: boolean): void {}

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(event: LiveServerEvent): void {
    this.options.callbacks.onEvent(event);
  }
}

interface Harness {
  session: LiveSession;
  bus: EventBus;
  transport(): FakeTransport;
  phases: string[];
  userTranscripts: string[];
  agentTranscripts: string[];
  terminal: Array<Error | undefined>;
  sentToAgent: unknown[];
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function started(
  provider = "workbench",
  activityId = "job-1",
  overrides: Partial<BackgroundActivityStarted> = {},
): BackgroundActivityStarted {
  return {
    version: 1,
    provider,
    activityId,
    kind: "command",
    sessionId: "session",
    sessionFile: "/session.jsonl",
    workspaceId: "workspace",
    originId: "tool-call",
    label: "Run checks",
    cancellable: true,
    ...overrides,
  };
}

function finished(
  provider = "workbench",
  activityId = "job-1",
): BackgroundActivityFinished {
  return {
    version: 1,
    provider,
    activityId,
    kind: "command",
    sessionId: "session",
    sessionFile: "/session.jsonl",
    workspaceId: "workspace",
    outcome: "succeeded",
    summary: "Checks passed",
  };
}

function confirmationRequest(
  requestId = "request-1",
  overrides: Partial<ConfirmationRequest> = {},
): ConfirmationRequest {
  return {
    version: 1,
    requestId,
    sessionId: "session",
    sessionFile: "/session.jsonl",
    provider: "herdr-workbench",
    operationId: "sha256:abc123",
    riskCategory: "git-mutation",
    title: "Approve git push?",
    summary: 'Operation: {"command":["git","push"],"cwd":"/repo"}',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function delegation(id: string, text: string): LiveServerEvent {
  return {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id,
      content: [{ type: "input_text", text }],
    },
  };
}

function createHarness(connectPromise?: Promise<void>): Harness {
  const bus = new EventBus();
  const phases: string[] = [];
  const userTranscripts: string[] = [];
  const agentTranscripts: string[] = [];
  const terminal: Array<Error | undefined> = [];
  const sentToAgent: unknown[] = [];
  let transport: FakeTransport | undefined;
  const pi = {
    events: bus,
    sendMessage: (message: unknown) => sentToAgent.push(message),
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/session.jsonl",
    },
    modelRegistry: { getProviderAuth: async () => undefined },
    isIdle: () => true,
    abort: () => {},
  } as unknown as ExtensionContext;
  const callbacks: LiveSessionCallbacks = {
    onPhase: (phase) => phases.push(phase),
    onInputLevel: () => {},
    onUserTranscript: (text) => userTranscripts.push(text),
    onAgentTranscript: (text) => agentTranscripts.push(text),
    onAttachmentsChanged: () => {},
    onWorkStatus: () => {},
    onTerminal: (error) => terminal.push(error),
  };
  const session = new LiveSession({
    pi,
    context,
    callbacks,
    createTransport: (options) => {
      transport = new FakeTransport(options, connectPromise);
      return transport;
    },
    createAudioCapture: () => ({ stop: () => {} }),
  });
  return {
    session,
    bus,
    transport: () => transport!,
    phases,
    userTranscripts,
    agentTranscripts,
    terminal,
    sentToAgent,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function contextText(message: LiveClientMessage): string {
  return "content" in message
    ? message.content.map(({ text }) => text).join("\n")
    : "";
}

test("output activity stays active across brief level drops", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const changes: boolean[] = [];
  const activity = new OutputActivityLatch((active) => changes.push(active), 250);

  activity.update(true);
  activity.update(false);
  context.mock.timers.tick(249);
  assert.deepEqual(changes, [true]);

  activity.update(true);
  context.mock.timers.tick(1);
  assert.deepEqual(changes, [true]);

  activity.update(false);
  context.mock.timers.tick(250);
  assert.deepEqual(changes, [true, false]);
});

test("agent transcript survives user interruption until the next agent response", async () => {
  const harness = createHarness();
  await harness.session.start();

  harness.transport().emit({
    type: "output_transcript.added",
    item: { text: "The checks are still running." },
  });
  harness.transport().emit({
    type: "input_transcript.added",
    item: { text: "Wait" },
  });
  harness.transport().emit({
    type: "turn.done",
    turn: { role: "user", transcript: "Wait" },
  });

  assert.deepEqual(harness.agentTranscripts, ["The checks are still running."]);
  assert.deepEqual(harness.userTranscripts, ["Wait", ""]);

  harness.transport().emit({
    type: "output_transcript.added",
    item: { text: "Okay," },
  });
  harness.transport().emit({
    type: "turn.done",
    turn: { role: "assistant", transcript: "Okay, I paused." },
  });
  assert.deepEqual(harness.agentTranscripts, [
    "The checks are still running.",
    "Okay,",
    "Okay, I paused.",
  ]);

  await harness.session.stop();
});

test("background context is buffered until transport connection succeeds", async () => {
  const connection = deferred();
  const harness = createHarness(connection.promise);
  const startPromise = harness.session.start();

  harness.session.handleBackgroundActivityStarted(started("workbench", "early", {
    originId: undefined,
    resumed: true,
  }));
  await flush();
  assert.deepEqual(harness.transport().sent, []);
  assert.equal(harness.phases.includes("error"), false);
  assert.deepEqual(harness.terminal, []);

  connection.resolve();
  await startPromise;
  await flush();
  assert.match(contextText(harness.transport().sent[0]!), /workbench early/);
  assert.equal(harness.phases.includes("error"), false);
  await harness.session.stop();
});

test("failed connection discards buffered context and reports the connection error", async () => {
  const connection = deferred();
  const harness = createHarness(connection.promise);
  const connectionError = new Error("connection failed");
  const startPromise = harness.session.start();
  harness.session.handleBackgroundActivityStarted(started("workbench", "early", {
    originId: undefined,
    resumed: true,
  }));
  await flush();

  connection.reject(connectionError);
  await assert.rejects(startPromise, connectionError);
  await flush();
  assert.equal(harness.transport().sent.some((message) => contextText(message).includes("early")), false);
  assert.equal(harness.terminal[0], connectionError);
});

test("post-connect context send failures remain terminal", async () => {
  const harness = createHarness();
  await harness.session.start();
  const sendError = new Error("send failed");
  harness.transport().sendError = sendError;
  harness.session.handleBackgroundActivityStarted(started("workbench", "late", {
    originId: undefined,
    resumed: true,
  }));
  await flush();

  assert.equal(harness.phases.includes("error"), true);
  assert.equal(harness.terminal[0], sendError);
});

test("controller correlates a tool call with its background activity", async () => {
  const harness = createHarness();
  await harness.session.start();
  harness.transport().emit(delegation("delegation-1", "Run the checks"));
  await flush();
  harness.session.handleToolCallStarted("tool-call");
  harness.session.handleBackgroundActivityStarted(started());
  await flush();

  assert.equal(harness.sentToAgent.length, 1);
  assert.match(contextText(harness.transport().sent.at(-1)!), /Run the checks/);
  await harness.session.stop();
});

test("controller replays a buffered finish after its start", async () => {
  const harness = createHarness();
  await harness.session.start();
  harness.transport().emit(delegation("delegation-1", "Run the checks"));
  await flush();
  harness.session.handleToolCallStarted("tool-call");
  harness.session.handleBackgroundActivityFinished(finished());
  harness.session.handleBackgroundActivityStarted(started());
  await flush();

  const contexts = harness.transport().sent.map(contextText);
  const startIndex = contexts.findIndex((text) => text.startsWith("Background Activity Started:"));
  const finishIndex = contexts.findIndex((text) => text.startsWith("Background Activity Final:"));
  assert.ok(startIndex >= 0);
  assert.ok(finishIndex > startIndex);
  assert.match(contexts[finishIndex]!, /Checks passed/);
  await harness.session.stop();
});

test("controller replays workbench activity from snapshot discovery", async () => {
  const harness = createHarness();
  harness.bus.on(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, (value) => {
    const requestId = (value as { requestId: string }).requestId;
    harness.bus.emit(`${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${requestId}`, {
      version: 1,
      requestId,
      provider: "workbench",
      activities: [started("workbench", "resumed", { originId: undefined, resumed: true })],
    });
  });

  await harness.session.start();
  await flush();
  assert.match(contextText(harness.transport().sent[0]!), /workbench resumed/);
  await harness.session.stop();
});

test("controller routes cancellation to the activity provider", async () => {
  const harness = createHarness();
  harness.bus.on(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, (value) => {
    const requestId = (value as { requestId: string }).requestId;
    harness.bus.emit(`${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${requestId}`, {
      version: 1,
      requestId,
      provider: "workbench",
      activities: [started("workbench", "job-1", { originId: undefined, resumed: true })],
    });
  });
  harness.bus.on(BACKGROUND_ACTIVITY_CANCEL_EVENT, (value) => {
    const request = value as { requestId: string };
    harness.bus.emit(`${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
    });
  });

  await harness.session.start();
  await flush();
  harness.transport().emit(delegation("cancel-1", "[[live:cancel-activity workbench job-1]]"));
  await flush();

  const request = harness.bus.emitted.find(({ name }) => name === BACKGROUND_ACTIVITY_CANCEL_EVENT)!.value;
  assert.equal((request as { provider: string }).provider, "workbench");
  assert.match(contextText(harness.transport().sent.at(-1)!), /asked that background activity to stop/);
  await harness.session.stop();
});

test("voice confirmation resolves once without starting a coding turn", async () => {
  const harness = createHarness();
  await harness.session.start();
  const request = confirmationRequest();
  harness.session.handleConfirmationRequested(request);
  await flush();

  assert.ok(harness.bus.emitted.some(({ name, value }) =>
    name === `${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}` &&
    (value as { operationId?: string }).operationId === request.operationId
  ));
  assert.match(contextText(harness.transport().sent.at(-1)!), /Approve git push/);
  assert.match(contextText(harness.transport().sent.at(-1)!), /git.*push/);

  harness.transport().emit(delegation("confirmation-1", `[[live:confirmation ${request.requestId} approve]]`));
  harness.transport().emit(delegation("confirmation-2", `[[live:confirmation ${request.requestId} approve]]`));
  await flush();
  const resolutions = harness.bus.emitted.filter(({ name }) =>
    name === `${CONFIRMATION_RESOLVED_PREFIX}${request.requestId}`
  );
  assert.equal(resolutions.length, 1);
  assert.equal((resolutions[0]!.value as { decision: string }).decision, "approved");
  harness.session.handleConfirmationRequested(request);
  assert.equal(harness.bus.emitted.filter(({ name }) =>
    name === `${CONFIRMATION_ACKNOWLEDGED_PREFIX}${request.requestId}`
  ).length, 1);
  assert.equal(harness.sentToAgent.length, 0);
  await harness.session.stop();
});

test("voice denial and ambiguous confirmation controls never approve", async () => {
  const harness = createHarness();
  await harness.session.start();
  const denied = confirmationRequest("request-denied");
  const ambiguous = confirmationRequest("request-ambiguous");
  harness.session.handleConfirmationRequested(denied);
  harness.session.handleConfirmationRequested(ambiguous);
  harness.transport().emit(delegation("denial", `[[live:confirmation ${denied.requestId} deny]]`));
  harness.transport().emit(delegation("ambiguous", `[[live:confirmation ${ambiguous.requestId} maybe]]`));
  await flush();

  const deniedResolution = harness.bus.emitted.find(({ name }) =>
    name === `${CONFIRMATION_RESOLVED_PREFIX}${denied.requestId}`
  );
  assert.equal((deniedResolution!.value as { decision: string }).decision, "denied");
  assert.equal(harness.bus.emitted.some(({ name }) =>
    name === `${CONFIRMATION_RESOLVED_PREFIX}${ambiguous.requestId}`
  ), false);
  assert.equal(harness.sentToAgent.length, 0);
  await harness.session.stop();
});

test("confirmation requests reject wrong session, expiry, and duplicates", async () => {
  const harness = createHarness();
  await harness.session.start();
  const valid = confirmationRequest("request-valid");
  harness.session.handleConfirmationRequested(confirmationRequest("wrong-session", { sessionId: "other" }));
  harness.session.handleConfirmationRequested(confirmationRequest("expired", { expiresAt: Date.now() - 1 }));
  harness.session.handleConfirmationRequested(valid);
  harness.session.handleConfirmationRequested(valid);
  await flush();

  assert.equal(harness.bus.emitted.filter(({ name }) => name.startsWith(CONFIRMATION_ACKNOWLEDGED_PREFIX)).length, 1);
  await harness.session.stop();
  const resolutions = harness.bus.emitted.filter(({ name }) =>
    name === `${CONFIRMATION_RESOLVED_PREFIX}${valid.requestId}`
  );
  assert.equal(resolutions.length, 1);
  assert.equal((resolutions[0]!.value as { decision: string }).decision, "denied");
});

test("teardown discards pending discovery and cancellation results", async () => {
  const harness = createHarness();
  await harness.session.start();
  harness.session.handleBackgroundActivityStarted(started("workbench", "job-1", {
    originId: undefined,
    resumed: true,
  }));
  await flush();
  harness.transport().emit(delegation("cancel-1", "[[live:cancel-activity workbench job-1]]"));
  await flush();

  const snapshotRequest = harness.bus.emitted.find(({ name }) => name === BACKGROUND_ACTIVITY_SNAPSHOT_EVENT)!.value as { requestId: string };
  const cancelRequest = harness.bus.emitted.find(({ name }) => name === BACKGROUND_ACTIVITY_CANCEL_EVENT)!.value as { requestId: string };
  const beforeStop = harness.transport().sent.length;
  await harness.session.stop();
  assert.equal(harness.bus.handlers.get(`${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${snapshotRequest.requestId}`)?.size, 0);

  harness.bus.emit(`${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${snapshotRequest.requestId}`, {
    version: 1,
    requestId: snapshotRequest.requestId,
    provider: "workbench",
    activities: [started("workbench", "late", { originId: undefined, resumed: true })],
  });
  harness.bus.emit(`${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}${cancelRequest.requestId}`, {
    version: 1,
    requestId: cancelRequest.requestId,
    success: true,
  });
  await flush();
  assert.equal(harness.transport().sent.length, beforeStop + 1);
  assert.equal(harness.transport().sent.at(-1)?.type, "session.close");
  assert.equal(harness.terminal.length, 1);
});
