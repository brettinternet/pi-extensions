import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityTracker } from "../../extensions/live-codex/activity-tracker.ts";

test("delegations are activated and settled in FIFO order", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("first", "Run tests");
  tracker.enqueue("second", "Review the diff");

  assert.equal(tracker.activateNext()?.id, "first");
  tracker.setPendingFinal("Tests started");
  assert.equal(tracker.settleActive()?.pendingFinal, "Tests started");
  assert.equal(tracker.activateNext()?.id, "second");
});

test("a second delegation cannot replace the active delegation", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("first", "Run tests");
  tracker.activateNext();
  tracker.enqueue("second", "Review the diff");

  tracker.setPendingFinal("First result");
  assert.equal(tracker.active()?.id, "first");
  assert.equal(tracker.get("first")?.pendingFinal, "First result");
  assert.equal(tracker.get("second")?.pendingFinal, "");
});

test("background jobs keep an activity active after its Pi turn settles", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run the full test suite");
  tracker.activateNext();
  tracker.associateJob("job-1");

  assert.equal(tracker.settleActive()?.state, "running");
  assert.deepEqual(tracker.status(), { queued: 0, active: 1, failed: 0 });

  assert.equal(tracker.completeJob("job-1", "completed")?.state, "settled");
  assert.deepEqual(tracker.status(), { queued: 0, active: 0, failed: 0 });
});

test("duplicate job completions and unowned jobs are ignored", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run checks");
  tracker.activateNext();
  tracker.associateJob("job-1");
  tracker.settleActive();

  assert.ok(tracker.completeJob("job-1", "completed"));
  assert.equal(tracker.completeJob("job-1", "completed"), undefined);
  assert.equal(tracker.completeJob("other", "completed"), undefined);
});

test("a failed background job marks its activity failed", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run checks");
  tracker.activateNext();
  tracker.associateJob("job-1");
  tracker.settleActive();

  assert.equal(tracker.completeJob("job-1", "failed")?.state, "failed");
  assert.deepEqual(tracker.status(), { queued: 0, active: 0, failed: 1 });
});

test("one failed sibling keeps the activity failed", () => {
  const tracker = new ActivityTracker();
  tracker.enqueue("delegation", "Run checks in parallel");
  tracker.activateNext();
  tracker.associateJob("job-1");
  tracker.associateJob("job-2");
  tracker.settleActive();

  assert.equal(tracker.completeJob("job-1", "failed")?.state, "running");
  assert.equal(tracker.completeJob("job-2", "completed")?.state, "failed");
});
