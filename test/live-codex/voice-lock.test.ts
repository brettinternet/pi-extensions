import assert from "node:assert/strict";
import { connect } from "node:net";
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
  requestVoiceLockHandoff,
  VoiceLockHeldError,
  type VoiceLockOwner,
} from "../../extensions/live-codex/voice-lock.ts";

test("only one live session can hold the voice lock", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = await acquireVoiceLock("first", directory);

  await assert.rejects(
    acquireVoiceLock("second", directory),
    (error) => {
      assert.ok(error instanceof VoiceLockHeldError);
      assert.equal(error.owner?.sessionId, "first");
      assert.equal(error.owner?.pid, process.pid);
      assert.ok(error.owner?.controlPort);
      return true;
    },
  );

  first.release();
  const second = await acquireVoiceLock("second", directory);
  second.release();
  rmdirSync(parent);
});

test("release can be retried after cleanup fails", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const lock = await acquireVoiceLock("session", directory);
  const obstruction = join(directory, "unexpected");
  writeFileSync(obstruction, "content");

  assert.throws(() => lock.release());
  unlinkSync(obstruction);
  lock.release();
  rmdirSync(parent);
});

test("a stale incomplete lock is recovered", async () => {
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

  const lock = await acquireVoiceLock("replacement", directory);
  lock.release();
  rmdirSync(parent);
});

async function currentOwner(directory: string): Promise<VoiceLockOwner> {
  let owner: VoiceLockOwner | undefined;
  await assert.rejects(
    acquireVoiceLock("requester", directory),
    (error) => {
      assert.ok(error instanceof VoiceLockHeldError);
      owner = error.owner;
      return true;
    },
  );
  assert.ok(owner);
  return owner;
}

async function rawControlRequest(
  owner: VoiceLockOwner,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const port = owner.controlPort;
  assert.ok(port);
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = connect({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!data) reject(new Error("control connection closed"));
    });
  });
}

test("an authenticated handoff releases the old lock and allows acquisition", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = await acquireVoiceLock("first", directory);
  const owner = await currentOwner(directory);
  let requesterSessionId = "";
  first.setHandoffHandler((request) => {
    requesterSessionId = request.requesterSessionId;
    first.release();
    return { accepted: true };
  });

  const response = await requestVoiceLockHandoff(owner, "second");
  assert.deepEqual(response, { accepted: true });
  assert.equal(requesterSessionId, "second");

  const second = await acquireVoiceLock("second", directory);
  second.release();
  rmdirSync(parent);
});

test("the control server rejects an unauthenticated handoff", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = await acquireVoiceLock("first", directory);
  const owner = await currentOwner(directory);
  const response = await rawControlRequest(owner, {
    version: 1,
    type: "pi-live-codex.handoff.request",
    token: "wrong-token",
    requesterSessionId: "second",
  });
  assert.equal(response.accepted, false);
  assert.match(String(response.reason), /not authenticated/);
  first.release();
  rmdirSync(parent);
});

test("the current owner can refuse a handoff with an actionable blocker", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = await acquireVoiceLock("first", directory);
  const owner = await currentOwner(directory);
  first.setHandoffHandler(() => ({
    accepted: false,
    reason: "Resolve queued voice requests in the old session first.",
  }));

  const response = await requestVoiceLockHandoff(owner, "second");
  assert.equal(response.accepted, false);
  assert.match(response.reason ?? "", /queued voice requests/);
  await assert.rejects(acquireVoiceLock("second", directory), VoiceLockHeldError);
  first.release();
  rmdirSync(parent);
});

test("a handoff response is bounded by the requester timeout", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-live-codex-test-"));
  const directory = join(parent, "voice.lock");
  const first = await acquireVoiceLock("first", directory);
  const owner = await currentOwner(directory);
  first.setHandoffHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { accepted: true };
  });

  await assert.rejects(
    requestVoiceLockHandoff(owner, "second", {
      connectTimeoutMs: 500,
      responseTimeoutMs: 10,
    }),
    /response timed out/,
  );
  first.release();
  await new Promise((resolve) => setTimeout(resolve, 120));
  rmdirSync(parent);
});
