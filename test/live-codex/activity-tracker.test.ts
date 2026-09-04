import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityTracker } from "../../extensions/live-codex/activity-tracker.ts";
import type {
  BackgroundActivityFinished,
  BackgroundActivityStarted,
} from "../../extensions/live-codex/background-activity.ts";

function started(
  provider: string,
  activityId: string,
  originId: string,
): BackgroundActivityStarted {
  return {
    version: 1,
    provider,
    activityId,
    kind: "job",
    sessionId: "session",
    sessionFile: "/session.jsonl",
    workspaceId: "workspace",
    originId,
    label: `${provider} ${activityId}`,
    cancellable: true,
  };
}

function finished(
  provider: string,
  activityId: string,
  outcome: BackgroundActivityFinished["outcome"] = "succeeded",
): BackgroundActivityFinished {
  return {
    version: 1,
    provider,
    activityId,
    kind: "job",
    sessionId: "session",
    sessionFile: "/session.jsonl",
    workspaceId: "workspace",
    outcome,
    summary: `${activityId} ${outcome}`,
  };
}

test("a settled turn with running activity does not block the next spoken request", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("first", "Run tests");
  tracker.enqueue("second", "Review the diff");
  assert.equal(tracker.activateNext()?.id, "first");
  assert.equal(tracker.correlateToolCall("tool-first"), true);
  assert.equal(tracker.startActivity(started("provider", "job", "tool-first"))?.owner?.id, "first");

  assert.equal(tracker.settleActive()?.state, "running");
  assert.equal(tracker.activateNext()?.id, "second");
  tracker.setPendingFinal("Review done");
  assert.equal(tracker.settleActive()?.pendingFinal, "Review done");
  assert.equal(tracker.finishActivity(finished("provider", "job"))?.owner?.state, "settled");
});

test("tool-call correlation cannot be stolen by whichever delegation is active later", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("first", "First");
  tracker.enqueue("second", "Second");
  tracker.activateNext();
  tracker.correlateToolCall("tool-first");
  tracker.settleActive();
  tracker.activateNext();

  assert.equal(
    tracker.startActivity(started("provider", "job", "tool-first"))?.owner?.id,
    "first",
  );
  assert.equal(tracker.get("first")?.state, "running");
  assert.equal(tracker.get("second")?.activities.size, 0);
  assert.equal(
    tracker.startActivity(started("provider", "unmapped", "unknown")),
    undefined,
  );
});

test("provider is part of identity and raw collisions are ambiguous", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run both");
  tracker.activateNext();
  tracker.correlateToolCall("tool-a");
  tracker.correlateToolCall("tool-b");
  tracker.startActivity(started("provider-a", "same-id", "tool-a"));
  tracker.startActivity(started("provider-b", "same-id", "tool-b"));

  assert.equal(tracker.findRunningActivity("same-id"), undefined);
  assert.equal(tracker.findRunningActivity("same-id", "provider-a")?.provider, "provider-a");
  tracker.finishActivity(finished("provider-a", "same-id"));
  assert.equal(tracker.getActivity("provider-b", "same-id")?.state, "running");
});

test("NUL-containing provider and activity IDs remain independent", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run both");
  tracker.activateNext();
  tracker.correlateToolCall("tool-a");
  tracker.correlateToolCall("tool-b");

  assert.ok(tracker.startActivity(started("a\0b", "c", "tool-a")));
  assert.ok(tracker.startActivity(started("a", "b\0c", "tool-b")));
  assert.equal(tracker.finishActivity(finished("a\0b", "c"))?.activity.state, "succeeded");
  assert.equal(tracker.getActivity("a", "b\0c")?.state, "running");
  assert.equal(
    tracker.finishActivity(finished("a", "b\0c", "cancelled"))?.activity.state,
    "cancelled",
  );
  assert.equal(tracker.getActivity("a\0b", "c")?.state, "succeeded");
});

test("duplicate and finish-before-start events are deduplicated", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run checks");
  tracker.activateNext();
  tracker.correlateToolCall("tool");

  assert.equal(tracker.finishActivity(finished("provider", "job")), undefined);
  const start = tracker.startActivity(started("provider", "job", "tool"));
  assert.equal(start?.bufferedFinish?.outcome, "succeeded");
  assert.ok(tracker.finishActivity(start!.bufferedFinish!));
  assert.equal(tracker.startActivity(started("provider", "job", "tool")), undefined);
  assert.equal(tracker.finishActivity(finished("provider", "job")), undefined);
});

test("failed and cancelled outcomes fail the owning delegation", () => {
  for (const outcome of ["failed", "cancelled"] as const) {
    const tracker = new ActivityTracker();
    tracker.enqueue("delegation", "Run checks");
    tracker.activateNext();
    tracker.correlateToolCall("tool");
    tracker.startActivity(started("provider", "job", "tool"));
    tracker.settleActive();
    assert.equal(tracker.finishActivity(finished("provider", "job", outcome))?.owner?.state, "failed");
  }
});

test("resumed provider-neutral activities need no delegation", () => {
  const tracker = new ActivityTracker();
  const resumed: BackgroundActivityStarted = {
    ...started("provider", "resumed", "unused"),
    originId: undefined,
    resumed: true,
  };
  assert.equal(tracker.startActivity(resumed)?.owner, undefined);
  assert.deepEqual(tracker.status(), { queued: 0, active: 1, failed: 0 });
  assert.equal(tracker.finishActivity(finished("provider", "resumed"))?.activity.summary, "resumed succeeded");
  assert.deepEqual(tracker.status(), { queued: 0, active: 0, failed: 0 });
});

test("terminal scope mismatches do not settle an activity", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run checks");
  tracker.activateNext();
  tracker.correlateToolCall("tool");
  tracker.startActivity(started("provider", "job", "tool"));
  tracker.settleActive();

  assert.equal(tracker.finishActivity({ ...finished("provider", "job"), workspaceId: "other" }), undefined);
  assert.equal(tracker.getActivity("provider", "job")?.state, "running");
});
