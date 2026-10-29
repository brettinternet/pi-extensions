import { generateCodexAttestation } from "./attestation.ts";
import { AudioCapture, LiveWebRtcPeer } from "./native.cjs";

export const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const SAMPLE_RATE = 16_000;
const DEFAULT_MICROPHONE_STALL_TIMEOUT_MS = 5_000;

/** Microphone, speaker, and WebRTC media for one live call. */
export interface LiveMedia {
  attestation(): Promise<string | undefined>;
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(): Promise<void>;
  startCapture(): Promise<void>;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

export interface LiveMediaCallbacks {
  onPeerEvent(payload: string): void;
  onInputLevel(level: number): void;
  onOutputLevel(level: number): void;
  onMicrophoneRestarted(): void;
  onFailure(error: Error): void;
}

export interface LivePeer {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

export interface LiveAudioCapture {
  stop(): void;
}

export interface LocalLiveMediaOptions {
  createPeer?: (callbacks: {
    onEvent(payload: string): void;
    onLevel(level: number): void;
    onFailure(message: string): void;
  }) => LivePeer;
  createAudioCapture?: (
    onAudio: (error: Error | null, samples: Float32Array) => void,
  ) => LiveAudioCapture;
  microphoneStallTimeoutMs?: number;
  /** Appended to microphone startup errors. */
  captureErrorHint?: string;
}

function microphoneLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.min(1, Math.sqrt(squares / samples.length));
}

function nativePeer(
  callbacks: Parameters<NonNullable<LocalLiveMediaOptions["createPeer"]>>[0],
): LivePeer {
  return new LiveWebRtcPeer(
    (error, payload) => {
      if (error) callbacks.onFailure(error.message);
      else callbacks.onEvent(payload);
    },
    (error, level) => {
      if (error) callbacks.onFailure(error.message);
      else callbacks.onLevel(level);
    },
    (error, message) => callbacks.onFailure(error?.message ?? message),
  );
}

/** Media on this machine's default microphone and speaker. */
export class LocalLiveMedia implements LiveMedia {
  readonly #callbacks: LiveMediaCallbacks;
  readonly #peer: LivePeer;
  readonly #createAudioCapture: NonNullable<LocalLiveMediaOptions["createAudioCapture"]>;
  readonly #stallTimeoutMs: number;
  readonly #captureErrorHint: string | undefined;
  #recorder: LiveAudioCapture | undefined;
  #watchdog: NodeJS.Timeout | undefined;
  #lastFrameAt = 0;
  #recoveryAttempted = false;
  #outputLevel = 0;
  #muted = false;
  #closed = false;
  #failed = false;

  constructor(callbacks: LiveMediaCallbacks, options: LocalLiveMediaOptions = {}) {
    this.#callbacks = callbacks;
    this.#createAudioCapture = options.createAudioCapture ??
      ((onAudio) => new AudioCapture(SAMPLE_RATE, onAudio));
    this.#stallTimeoutMs = options.microphoneStallTimeoutMs ??
      DEFAULT_MICROPHONE_STALL_TIMEOUT_MS;
    this.#captureErrorHint = options.captureErrorHint;
    this.#peer = (options.createPeer ?? nativePeer)({
      onEvent: (payload) => {
        if (!this.#closed) this.#callbacks.onPeerEvent(payload);
      },
      onLevel: (level) => {
        if (this.#closed || !Number.isFinite(level)) return;
        this.#outputLevel = Math.min(1, Math.max(0, level));
        this.#callbacks.onOutputLevel(this.#outputLevel);
      },
      onFailure: (message) => this.#fail(new Error(message)),
    });
  }

  attestation(): Promise<string | undefined> {
    return generateCodexAttestation();
  }

  createOffer(): Promise<string> {
    return this.#peer.createOffer();
  }

  acceptAnswer(sdp: string): Promise<void> {
    return this.#peer.acceptAnswer(sdp);
  }

  waitForOpen(): Promise<void> {
    return this.#peer.waitForOpen();
  }

  async startCapture(): Promise<void> {
    if (this.#closed || this.#recorder) return;
    try {
      this.#startRecorder();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.#captureErrorHint) throw error;
      throw new Error(`${error.message} ${this.#captureErrorHint}`, {
        cause: error,
      });
    }
    const checkIntervalMs = Math.min(
      1_000,
      Math.max(10, Math.floor(this.#stallTimeoutMs / 2)),
    );
    this.#watchdog = setInterval(() => this.#checkStall(), checkIntervalMs);
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#peer.setMuted(muted);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopCapture();
    await this.#peer.close();
  }

  #startRecorder(): void {
    let recorder: LiveAudioCapture | undefined;
    let synchronousError: Error | undefined;
    let installed = false;
    recorder = this.#createAudioCapture((error, samples) => {
      if (!installed) {
        synchronousError = error ?? undefined;
        return;
      }
      if (recorder !== this.#recorder || this.#closed) return;
      if (error) {
        this.#fail(error);
        return;
      }
      this.#lastFrameAt = Date.now();
      this.#handleAudio(samples);
    });
    if (synchronousError || this.#closed) {
      try {
        recorder.stop();
      } catch {}
      if (synchronousError) throw synchronousError;
      return;
    }
    this.#recorder = recorder;
    this.#lastFrameAt = Date.now();
    installed = true;
  }

  #checkStall(): void {
    if (this.#closed || !this.#recorder) return;
    if (Date.now() - this.#lastFrameAt < this.#stallTimeoutMs) return;
    if (this.#recoveryAttempted) {
      this.#fail(new Error(
        "Microphone capture stopped responding after automatic recovery. Restart Pi to reset its audio process.",
      ));
      return;
    }
    this.#recoveryAttempted = true;
    this.#callbacks.onMicrophoneRestarted();
    const recorder = this.#recorder;
    this.#recorder = undefined;
    try {
      recorder.stop();
    } catch {}
    try {
      this.#startRecorder();
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  #stopCapture(): void {
    clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    const recorder = this.#recorder;
    this.#recorder = undefined;
    try {
      recorder?.stop();
    } catch {}
  }

  #handleAudio(samples: Float32Array): void {
    if (this.#muted || samples.length === 0) return;
    const inputLevel = microphoneLevel(samples);
    this.#callbacks.onInputLevel(inputLevel);
    const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
    const echoThreshold = Math.max(
      MIN_BARGE_IN_LEVEL,
      this.#outputLevel * OUTPUT_ECHO_RATIO,
    );
    if (!outputActive || inputLevel >= echoThreshold) {
      this.#peer.pushAudio(samples);
    }
  }

  #fail(error: Error): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#stopCapture();
    this.#callbacks.onFailure(error);
  }
}
