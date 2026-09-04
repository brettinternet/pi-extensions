import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_ACTIVITY_CANCEL_EVENT,
  BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX,
  BACKGROUND_ACTIVITY_SNAPSHOT_EVENT,
  BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX,
  type BackgroundActivityStarted,
  cancelBackgroundActivity,
  parseBackgroundActivityFinished,
  parseBackgroundActivityStarted,
  parseLegacySubagentFinished,
  parseLegacySubagentStarted,
  requestBackgroundActivitySnapshot,
  SUBAGENT_PROVIDER,
  SUBAGENT_RPC_REPLY_PREFIX,
  SUBAGENT_RPC_REQUEST_EVENT,
} from "../../extensions/live-codex/background-activity.ts";

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

const scope = { sessionId: "session", sessionFile: "/session.jsonl" };

function activity(provider = "provider", activityId = "activity"): BackgroundActivityStarted {
  return {
    version: 1,
    provider,
    activityId,
    kind: "job",
    ...scope,
    workspaceId: "workspace",
    originId: "tool-call",
    label: "Run checks",
    cancellable: true,
  };
}

test("generic wire validation requires exact session scope", () => {
  assert.ok(parseBackgroundActivityStarted(activity(), scope));
  assert.equal(parseBackgroundActivityStarted({ ...activity(), sessionId: "other" }, scope), undefined);
  assert.equal(parseBackgroundActivityStarted({ ...activity(), sessionId: undefined }, scope), undefined);
  assert.equal(parseBackgroundActivityStarted({ ...activity(), sessionFile: "/other" }, scope), undefined);
  assert.equal(parseBackgroundActivityStarted({ ...activity(), originId: undefined }, scope), undefined);
  assert.ok(parseBackgroundActivityStarted({ ...activity(), originId: undefined, resumed: true }, scope));

  const terminal = {
    version: 1,
    provider: "provider",
    activityId: "activity",
    kind: "job",
    ...scope,
    workspaceId: "workspace",
    outcome: "failed",
    exitCode: 2,
    summary: "exit 2",
  };
  assert.deepEqual(parseBackgroundActivityFinished(terminal, scope), terminal);
  assert.equal(parseBackgroundActivityFinished({ ...terminal, sessionId: "other" }, scope), undefined);
});

test("legacy subagent lifecycle remains structurally compatible", () => {
  assert.deepEqual(
    parseLegacySubagentStarted({ id: "run-1", task: "Review" }, scope, "legacy-origin"),
    {
      version: 1,
      provider: SUBAGENT_PROVIDER,
      activityId: "run-1",
      kind: "subagent",
      ...scope,
      originId: "legacy-origin",
      label: "Review",
      cancellable: true,
    },
  );
  assert.equal(parseLegacySubagentFinished({ runId: "run-1", success: true }, scope)?.outcome, "succeeded");
  assert.equal(parseLegacySubagentFinished({ runId: "run-1", state: "stopped" }, scope)?.outcome, "cancelled");
  assert.equal(parseLegacySubagentFinished({ runId: "run-1", success: false }, scope)?.outcome, "failed");
  assert.equal(parseLegacySubagentStarted({ id: "run-1", sessionId: "other" }, scope, "origin"), undefined);
});

test("generic cancellation routes by provider and waits for its request-specific reply", async () => {
  const bus = new EventBus();
  const pi = { events: bus } as unknown as ExtensionAPI;
  bus.on(BACKGROUND_ACTIVITY_CANCEL_EVENT, (value) => {
    const request = value as { requestId: string };
    bus.emit(`${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
    });
  });

  assert.equal(await cancelBackgroundActivity(pi, activity("provider-a", "same-id"), 50), true);
  const request = bus.emitted.find(({ name }) => name === BACKGROUND_ACTIVITY_CANCEL_EVENT)!.value;
  assert.deepEqual(request, {
    version: 1,
    requestId: (request as { requestId: string }).requestId,
    provider: "provider-a",
    activityId: "same-id",
    ...scope,
    workspaceId: "workspace",
  });
});

test("legacy subagent cancellation preserves stop RPC", async () => {
  const bus = new EventBus();
  const pi = { events: bus } as unknown as ExtensionAPI;
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
    const request = value as { requestId: string };
    bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
    });
  });

  assert.equal(await cancelBackgroundActivity(pi, activity(SUBAGENT_PROVIDER, "run-1"), 50), true);
  assert.equal(bus.emitted.some(({ name }) => name === BACKGROUND_ACTIVITY_CANCEL_EVENT), false);
  assert.deepEqual(
    bus.emitted.find(({ name }) => name === SUBAGENT_RPC_REQUEST_EVENT)!.value,
    {
      version: 1,
      requestId: (bus.emitted[0]!.value as { requestId: string }).requestId,
      method: "stop",
      params: { id: "run-1" },
    },
  );
});

test("snapshot discovery accepts bounded replies from multiple producers", () => {
  const bus = new EventBus();
  const pi = { events: bus } as unknown as ExtensionAPI;
  for (const provider of ["provider-a", "provider-b"]) {
    bus.on(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, (value) => {
      const request = value as { requestId: string };
      bus.emit(`${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        provider,
        activities: [{ ...activity(provider), originId: undefined, resumed: true }],
      });
    });
  }
  const discovered: BackgroundActivityStarted[] = [];
  const stop = requestBackgroundActivitySnapshot(pi, scope, (item) => discovered.push(item), 50);
  stop();
  assert.deepEqual(discovered.map(({ provider }) => provider), ["provider-a", "provider-b"]);
  const request = bus.emitted.find(({ name }) => name === BACKGROUND_ACTIVITY_SNAPSHOT_EVENT)!.value;
  assert.equal((request as { limit: number }).limit, 100);
});

test("snapshot quota ignores malformed and unaccepted entries", () => {
  const bus = new EventBus();
  const pi = { events: bus } as unknown as ExtensionAPI;
  bus.on(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, (value) => {
    const requestId = (value as { requestId: string }).requestId;
    const replyEvent = `${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${requestId}`;
    bus.emit(replyEvent, {
      version: 1,
      requestId,
      provider: "noise",
      activities: Array.from({ length: 100 }, () => ({ nope: true })),
    });
    bus.emit(replyEvent, {
      version: 1,
      requestId,
      provider: "workbench",
      activities: [
        { ...activity("other", "wrong-provider"), originId: undefined, resumed: true },
        { ...activity("workbench", "wrong-session"), sessionId: "other", originId: undefined, resumed: true },
        { ...activity("workbench", "not-resumed"), originId: "tool-call", resumed: undefined },
        { ...activity("workbench", "valid"), originId: undefined, resumed: true },
        { ...activity("workbench", "valid"), originId: undefined, resumed: true },
      ],
    });
  });

  const discovered: BackgroundActivityStarted[] = [];
  const stop = requestBackgroundActivitySnapshot(pi, scope, (item) => discovered.push(item), 50);
  stop();
  assert.deepEqual(discovered.map(({ provider, activityId }) => [provider, activityId]), [
    ["workbench", "valid"],
  ]);
});

test("snapshot quota counts only 100 accepted unique provider/activity tuples", () => {
  const bus = new EventBus();
  const pi = { events: bus } as unknown as ExtensionAPI;
  bus.on(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, (value) => {
    const requestId = (value as { requestId: string }).requestId;
    const replyEvent = `${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${requestId}`;
    const resumed = (provider: string, activityId: string) => ({
      ...activity(provider, activityId),
      originId: undefined,
      resumed: true,
    });
    bus.emit(replyEvent, {
      version: 1,
      requestId,
      provider: "provider-a",
      activities: [resumed("provider-a", "duplicate"), resumed("provider-a", "duplicate")],
    });
    bus.emit(replyEvent, {
      version: 1,
      requestId,
      provider: "provider-b",
      activities: Array.from({ length: 99 }, (_, index) => resumed("provider-b", `job-${index}`)),
    });
    bus.emit(replyEvent, {
      version: 1,
      requestId,
      provider: "provider-c",
      activities: [resumed("provider-c", "over-limit")],
    });
  });

  const discovered: BackgroundActivityStarted[] = [];
  requestBackgroundActivitySnapshot(pi, scope, (item) => discovered.push(item), 50)();
  assert.equal(discovered.length, 100);
  assert.equal(discovered.some(({ activityId }) => activityId === "over-limit"), false);
});
