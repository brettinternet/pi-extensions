import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputActivityLatch } from "../extensions/controller.ts";

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
