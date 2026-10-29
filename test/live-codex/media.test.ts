import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type LiveAudioCapture,
  LocalLiveMedia,
  type LivePeer,
} from "../../extensions/live-codex/media.ts";

type OnAudio = (error: Error | null, samples: Float32Array) => void;

function createMedia(create: (onAudio: OnAudio) => LiveAudioCapture) {
  const failures: Error[] = [];
  let restarts = 0;
  const peer: LivePeer = {
    createOffer: async () => "offer",
    acceptAnswer: async () => {},
    waitForOpen: async () => {},
    pushAudio: () => {},
    setMuted: () => {},
    close: async () => {},
  };
  const media = new LocalLiveMedia(
    {
      onPeerEvent: () => {},
      onInputLevel: () => {},
      onOutputLevel: () => {},
      onMicrophoneRestarted: () => restarts++,
      onFailure: (error) => failures.push(error),
    },
    {
      createPeer: () => peer,
      createAudioCapture: create,
      microphoneStallTimeoutMs: 20,
    },
  );
  return { media, failures, restarts: () => restarts };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("restarts microphone capture when audio callbacks stall", async () => {
  const callbacks: OnAudio[] = [];
  let stops = 0;
  const { media, restarts } = createMedia((onAudio) => {
    callbacks.push(onAudio);
    return { stop: () => stops++ };
  });
  await media.startCapture();

  await wait(35);

  assert.equal(callbacks.length, 2);
  assert.equal(stops, 1);
  assert.equal(restarts(), 1);
  callbacks[1]!(null, new Float32Array([0.1]));
  await media.close();
});

test("fails clearly when restarted microphone capture also stalls", async () => {
  const { media, failures } = createMedia(() => ({ stop: () => {} }));
  await media.startCapture();

  await wait(60);

  assert.match(
    failures[0]?.message ?? "",
    /Microphone capture stopped responding.*Restart Pi/,
  );
  await media.close();
});

test("a replacement frame does not permit an unbounded restart loop", async () => {
  const callbacks: OnAudio[] = [];
  const { media, failures } = createMedia((onAudio) => {
    callbacks.push(onAudio);
    return { stop: () => {} };
  });
  await media.startCapture();
  await wait(35);
  callbacks[1]!(null, new Float32Array([0.1]));

  await wait(35);

  assert.equal(callbacks.length, 2);
  assert.match(failures[0]?.message ?? "", /Restart Pi/);
  await media.close();
});

test("capture startup time is excluded from the stall window", async () => {
  const callbacks: OnAudio[] = [];
  const { media } = createMedia((onAudio) => {
    const deadline = Date.now() + 30;
    while (Date.now() < deadline) {}
    callbacks.push(onAudio);
    return { stop: () => {} };
  });
  await media.startCapture();
  await wait(12);

  assert.equal(callbacks.length, 1);
  callbacks[0]!(null, new Float32Array([0.1]));
  await media.close();
});

test("a synchronous capture error does not retain the returned recorder", async () => {
  let captures = 0;
  let stops = 0;
  const { media, failures } = createMedia((onAudio) => {
    captures++;
    onAudio(new Error("capture failed"), new Float32Array());
    return { stop: () => stops++ };
  });

  await assert.rejects(media.startCapture(), /capture failed/);
  await wait(25);

  assert.equal(captures, 1);
  assert.equal(stops, 1);
  assert.deepEqual(failures, []);
  await media.close();
});
