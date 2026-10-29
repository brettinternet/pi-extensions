import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  LiveMedia,
  LiveMediaCallbacks,
} from "../../extensions/live-codex/media.ts";
import {
  connectVoiceRelay,
  requestVoiceRelayHandoff,
  startVoiceRelay,
  voiceRelayOwner,
} from "../../extensions/live-codex/relay.ts";
import type { VoiceLockHandoffResponse } from "../../extensions/live-codex/voice-lock.ts";

class FakeMedia implements LiveMedia {
  readonly calls: string[] = [];
  readonly callbacks: LiveMediaCallbacks;
  closed = false;

  constructor(callbacks: LiveMediaCallbacks) {
    this.callbacks = callbacks;
  }

  async attestation() {
    return "attestation";
  }
  async createOffer() {
    return "offer-sdp";
  }
  async acceptAnswer(sdp: string) {
    this.calls.push(`answer:${sdp}`);
  }
  async waitForOpen() {
    this.calls.push("open");
  }
  async startCapture() {
    this.calls.push("capture");
  }
  setMuted(muted: boolean) {
    this.calls.push(`muted:${muted}`);
  }
  async close() {
    this.closed = true;
  }
}

function clientCallbacks(
  onHandoffRequest?: () => Promise<VoiceLockHandoffResponse>,
) {
  const received: string[] = [];
  const callbacks: LiveMediaCallbacks = {
    onHandoffRequest,
    onPeerEvent: (payload) => received.push(`event:${payload}`),
    onInputLevel: (level) => received.push(`input:${level}`),
    onOutputLevel: (level) => received.push(`output:${level}`),
    onMicrophoneRestarted: () => received.push("restarted"),
    onFailure: (error) => received.push(`failure:${error.message}`),
  };
  return { received, callbacks };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function startRelay() {
  const path = join(mkdtempSync(join(tmpdir(), "pi-live-relay-")), "relay.sock");
  const media: FakeMedia[] = [];
  const relay = await startVoiceRelay({
    path,
    createMedia: (callbacks) => {
      const created = new FakeMedia(callbacks);
      media.push(created);
      return created;
    },
  });
  return { path, relay, media };
}

test("relays one session's media and refuses a concurrent session", async () => {
  const { path, relay, media } = await startRelay();
  const first = clientCallbacks();
  const client = await connectVoiceRelay(first.callbacks, "first", path);
  assert.ok(client);
  assert.equal(relay.connected(), true);

  assert.equal(await client.attestation(), "attestation");
  assert.equal(await client.createOffer(), "offer-sdp");
  await client.acceptAnswer("answer-sdp");
  await client.waitForOpen();
  await client.startCapture();
  client.setMuted(true);
  media[0]!.callbacks.onOutputLevel(0.5);
  media[0]!.callbacks.onPeerEvent('{"type":"session.started"}');
  media[0]!.callbacks.onFailure(new Error("speaker lost"));
  await settle();

  assert.deepEqual(media[0]!.calls, [
    "answer:answer-sdp",
    "open",
    "capture",
    "muted:true",
  ]);
  assert.deepEqual(first.received, [
    "output:0.5",
    'event:{"type":"session.started"}',
    "failure:speaker lost",
  ]);

  await assert.rejects(
    connectVoiceRelay(clientCallbacks().callbacks, "second", path),
    /in use by another Pi session/,
  );
  assert.equal(media.length, 1);

  await client.close();
  await settle();
  assert.equal(media[0]!.closed, true);
  assert.equal(relay.connected(), false);

  const next = await connectVoiceRelay(clientCallbacks().callbacks, "next", path);
  assert.ok(next);
  await next.close();
  await relay.close();
});

test("moves voice to another session only when the owner pauses", async () => {
  const { path, relay, media } = await startRelay();
  let answer = async (): Promise<VoiceLockHandoffResponse> => ({
    accepted: false,
    reason: "Confirmation pending",
  });
  const owner = await connectVoiceRelay(
    clientCallbacks(() => answer()).callbacks,
    "owner",
    path,
  );
  assert.ok(owner);
  assert.deepEqual(await voiceRelayOwner(path), {
    sessionId: "owner",
    host: hostname(),
  });

  assert.deepEqual(await requestVoiceRelayHandoff("next", path), {
    accepted: false,
    reason: "Confirmation pending",
  });
  assert.equal(relay.connected(), true);

  // Pausing closes media before the owner releases its local voice lock.
  let paused = false;
  answer = async () => {
    await owner.close();
    await settle();
    paused = true;
    return { accepted: true };
  };
  assert.deepEqual(await requestVoiceRelayHandoff("next", path), { accepted: true });
  assert.equal(paused, true);
  assert.equal(media[0]!.closed, true);
  assert.equal(await voiceRelayOwner(path), undefined);

  const next = await connectVoiceRelay(clientCallbacks().callbacks, "next", path);
  assert.ok(next);
  assert.equal((await voiceRelayOwner(path))?.sessionId, "next");
  await next.close();
  await relay.close();
});

test("reports a dropped relay and falls back when none listens", async () => {
  const { path, relay } = await startRelay();
  const { received, callbacks } = clientCallbacks();
  const client = await connectVoiceRelay(callbacks, "session", path);
  assert.ok(client);

  await relay.close();
  await settle();

  assert.deepEqual(received, ["failure:Voice relay disconnected."]);
  await assert.rejects(client.createOffer(), /closed|disconnected/);
  assert.equal(await connectVoiceRelay(callbacks, "session", path), undefined);
  assert.equal(await voiceRelayOwner(path), undefined);
  assert.deepEqual(await requestVoiceRelayHandoff("session", path), { accepted: true });
});
