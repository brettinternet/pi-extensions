import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  LiveMedia,
  LiveMediaCallbacks,
} from "../../extensions/live-codex/media.ts";
import {
  connectVoiceRelay,
  startVoiceRelay,
} from "../../extensions/live-codex/relay.ts";

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

function clientCallbacks() {
  const received: string[] = [];
  const callbacks: LiveMediaCallbacks = {
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
  const client = await connectVoiceRelay(first.callbacks, path);
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
    connectVoiceRelay(clientCallbacks().callbacks, path),
    /in use by another Pi session/,
  );
  assert.equal(media.length, 1);

  await client.close();
  await settle();
  assert.equal(media[0]!.closed, true);
  assert.equal(relay.connected(), false);

  const next = await connectVoiceRelay(clientCallbacks().callbacks, path);
  assert.ok(next);
  await next.close();
  await relay.close();
});

test("reports a dropped relay and falls back when none listens", async () => {
  const { path, relay } = await startRelay();
  const { received, callbacks } = clientCallbacks();
  const client = await connectVoiceRelay(callbacks, path);
  assert.ok(client);

  await relay.close();
  await settle();

  assert.deepEqual(received, ["failure:Voice relay disconnected."]);
  await assert.rejects(client.createOffer(), /closed|disconnected/);
  assert.equal(await connectVoiceRelay(callbacks, path), undefined);
});
