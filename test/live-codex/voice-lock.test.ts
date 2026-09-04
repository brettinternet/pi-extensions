import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireVoiceLock,
  VoiceLockHeldError,
} from "../../extensions/live-codex/voice-lock.ts";

test("only one live session can hold the voice lock", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = acquireVoiceLock("first", directory);

  assert.throws(
    () => acquireVoiceLock("second", directory),
    (error) => {
      assert.ok(error instanceof VoiceLockHeldError);
      assert.equal(error.owner?.sessionId, "first");
      assert.equal(error.owner?.pid, process.pid);
      return true;
    },
  );

  first.release();
  const second = acquireVoiceLock("second", directory);
  second.release();
  rmdirSync(parent);
});

test("release can be retried after cleanup fails", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const lock = acquireVoiceLock("session", directory);
  const obstruction = join(directory, "unexpected");
  writeFileSync(obstruction, "content");

  assert.throws(() => lock.release());
  unlinkSync(obstruction);
  lock.release();
  rmdirSync(parent);
});

test("a stale incomplete lock is recovered", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "owner.json"),
    `${JSON.stringify({
      pid: 0,
      sessionId: "stale",
      startedAt: new Date().toISOString(),
      token: "stale",
    })}\n`,
  );
  const staleTime = new Date(Date.now() - 10_000);
  utimesSync(directory, staleTime, staleTime);

  const lock = acquireVoiceLock("replacement", directory);
  lock.release();
  rmdirSync(parent);
});
