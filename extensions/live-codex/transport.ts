// Adapted from Oh My Pi's MIT-licensed Codex live transport.
import WebSocket from "ws";
import { LiveWebRtcPeer } from "./native.cjs";
import { generateCodexAttestation } from "./attestation.ts";
import {
  buildLiveSessionPayload,
  type LiveClientMessage,
  type LiveServerEvent,
  parseLiveServerEvent,
} from "./protocol.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_CLIENT_VERSION = "0.144.1";
const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

export interface LiveAccess {
  accessToken: string;
  accountId?: string;
}

export interface LiveTransportCallbacks {
  onEvent(event: LiveServerEvent): void;
  onOutputLevel(level: number): void;
}

export interface LiveTransportOptions {
  getAccess(): Promise<LiveAccess>;
  sessionId: string;
  instructions: string;
  voice: string;
  callbacks: LiveTransportCallbacks;
  signal?: AbortSignal;
}

export function getCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    return auth?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

export function parseLiveCallId(location: string | null): string | undefined {
  if (!location) return undefined;
  return location
    .split("?", 1)[0]
    ?.split("/")
    .find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

export function buildLiveSidebandUrl(callId: string): string {
  return `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;
}

function liveHeaders(
  access: LiveAccess,
  sessionId: string,
  realtimeSessionId: string,
  attestation: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: LIVE_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "session-id": sessionId,
    "thread-id": sessionId,
  };
  const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  if (attestation) headers["x-oai-attestation"] = attestation;
  return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
  const normalized = body.trim().replaceAll(/\s+/g, " ");
  if (!normalized) return statusText || "empty response body";
  return normalized.length <= MAX_ERROR_BODY_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Live connection aborted", "AbortError");
}

export class CodexLiveTransport {
  readonly #options: LiveTransportOptions;
  readonly #realtimeSessionId = crypto.randomUUID();
  #peer: LiveWebRtcPeer | undefined;
  #sideband: WebSocket | undefined;
  #state: Lifecycle = "idle";
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #muted = false;
  #reportedFailure = false;
  readonly #abortListener: () => void;

  constructor(options: LiveTransportOptions) {
    this.#options = options;
    this.#abortListener = () => void this.close();
    if (!options.signal?.aborted) {
      options.signal?.addEventListener("abort", this.#abortListener, {
        once: true,
      });
    }
  }

  connect(): Promise<void> {
    if (this.#state === "connected") return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("Live transport is closed"));
    }
    if (this.#options.signal?.aborted) {
      return Promise.reject(abortError(this.#options.signal));
    }
    this.#state = "connecting";
    this.#connectPromise = this.#connect().catch(async (error) => {
      await this.close();
      throw error;
    });
    return this.#connectPromise;
  }

  async #connect(): Promise<void> {
    const peer = new LiveWebRtcPeer(
      (error, payload) => {
        if (error) this.#reportFailure(error.message);
        else this.#handlePeerEvent(payload);
      },
      (error, level) => {
        if (error) this.#reportFailure(error.message);
        else this.#handleOutputLevel(level);
      },
      (error, message) => this.#reportFailure(error?.message ?? message),
    );
    this.#peer = peer;
    const offer = await peer.createOffer();
    if (this.#state !== "connecting") throw abortError(this.#options.signal);
    const { answer, callId, access, attestation } = await this.#signal(offer);
    await peer.acceptAnswer(answer);
    peer.setMuted(this.#muted);
    await peer.waitForOpen();
    if (this.#state !== "connecting") throw abortError(this.#options.signal);
    await this.#connectSideband(callId, access, attestation);
    if (this.#state !== "connecting") throw abortError(this.#options.signal);
    this.#state = "connected";
  }

  async #signal(offer: string): Promise<{
    answer: string;
    callId: string;
    access: LiveAccess;
    attestation: string | undefined;
  }> {
    const [access, attestation] = await Promise.all([
      this.#options.getAccess(),
      generateCodexAttestation(),
    ]);
    const response = await fetch(SIGNALING_URL, {
      method: "POST",
      headers: {
        ...liveHeaders(
          access,
          this.#options.sessionId,
          this.#realtimeSessionId,
          attestation,
        ),
        Accept: "*/*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sdp: offer,
        session: buildLiveSessionPayload(
          this.#options.instructions,
          this.#options.voice,
        ),
      }),
      signal: this.#options.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Codex live signaling failed (${response.status}): ${boundedErrorBody(responseBody, response.statusText)}`,
      );
    }
    if (!responseBody.trim()) {
      throw new Error("Codex live signaling returned an empty SDP answer");
    }
    const callId = parseLiveCallId(response.headers.get("location"));
    if (!callId) {
      throw new Error("Codex live signaling returned no valid call ID");
    }
    return { answer: responseBody, callId, access, attestation };
  }

  async #connectSideband(
    callId: string,
    access: LiveAccess,
    attestation: string | undefined,
  ): Promise<void> {
    let failure = new Error("Codex live sideband connection failed");
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.#openSideband(callId, access, attestation);
        return;
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause));
        if (this.#options.signal?.aborted) throw abortError(this.#options.signal);
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200 * 2 ** attempt);
          });
        }
      }
    }
    throw failure;
  }

  async #openSideband(
    callId: string,
    access: LiveAccess,
    attestation: string | undefined,
  ): Promise<void> {
    const socket = new WebSocket(buildLiveSidebandUrl(callId), {
      headers: liveHeaders(
        access,
        this.#options.sessionId,
        this.#realtimeSessionId,
        attestation,
      ),
    });

    let resolveConnect: () => void;
    let rejectConnectPromise: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnectPromise = reject;
    });
    let opened = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      timeout = undefined;
      this.#options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectConnect = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectConnectPromise(error);
    };
    const onAbort = () => {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "aborted");
      rejectConnect(abortError(this.#options.signal));
    };

    socket.once("open", () => {
      if (settled) {
        socket.close(1000, "stale");
        return;
      }
      opened = true;
      settled = true;
      cleanup();
      this.#sideband = socket;
      resolveConnect();
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#reportFailure("Codex live sideband returned a binary frame");
      } else {
        this.#handleSidebandEvent(data.toString("utf8"));
      }
    });
    socket.on("error", (error) => {
      const detail = error.message ? `: ${error.message}` : "";
      if (!opened) {
        rejectConnect(new Error(`Codex live sideband connection failed${detail}`));
        socket.terminate();
      } else {
        this.#reportFailure(`Codex live sideband failed${detail}`);
      }
    });
    socket.on("close", (code, reason) => {
      if (!opened) {
        rejectConnect(
          new Error(`Codex live sideband closed before connecting (${code})`),
        );
        return;
      }
      if (this.#sideband !== socket) return;
      this.#sideband = undefined;
      if (this.#state === "connecting" || this.#state === "connected") {
        const detail = reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
        this.#reportFailure(`Codex live sideband closed (${code})${detail}`);
      }
    });

    if (this.#options.signal?.aborted) onAbort();
    else {
      this.#options.signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        socket.terminate();
        rejectConnect(new Error("Codex live sideband connection timed out"));
      }, SIDEBAND_CONNECT_TIMEOUT_MS);
      timeout.unref();
    }
    await promise;
  }

  #handleSidebandEvent(payload: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    const event = parseLiveServerEvent(payload);
    if (event) this.#options.callbacks.onEvent(event);
  }

  #handlePeerEvent(payload: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    const event = parseLiveServerEvent(payload);
    if (!event) return;
    if (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error") return;
    this.#options.callbacks.onEvent(event);
  }

  #handleOutputLevel(level: number): void {
    if (this.#state !== "connected" || !Number.isFinite(level)) return;
    this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
  }

  #reportFailure(message: string): void {
    if (
      (this.#state !== "connecting" && this.#state !== "connected") ||
      this.#reportedFailure
    ) {
      return;
    }
    this.#reportedFailure = true;
    this.#options.callbacks.onEvent({ type: "error", message });
  }

  send(message: LiveClientMessage): Promise<void> {
    const operation = this.#sendTail.then(() => {
      if (this.#state !== "connected") {
        throw new Error("Live transport is not connected");
      }
      const sideband = this.#sideband;
      if (!sideband || sideband.readyState !== WebSocket.OPEN) {
        throw new Error("Codex live sideband is not connected");
      }
      sideband.send(JSON.stringify(message));
    });
    this.#sendTail = operation.catch(() => {});
    return operation;
  }

  pushAudio(samples: Float32Array): void {
    if (this.#state !== "connected" || this.#muted || samples.length === 0) {
      return;
    }
    this.#peer?.pushAudio(samples);
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#state === "connected") this.#peer?.setMuted(muted);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#options.signal?.removeEventListener("abort", this.#abortListener);
    const sideband = this.#sideband;
    const peer = this.#peer;
    this.#sideband = undefined;
    this.#peer = undefined;
    if (
      sideband &&
      (sideband.readyState === WebSocket.OPEN ||
        sideband.readyState === WebSocket.CONNECTING)
    ) {
      sideband.close(1000, "done");
    }
    if (peer) {
      try {
        await peer.close();
      } catch {}
    }
    this.#state = "closed";
  }
}
