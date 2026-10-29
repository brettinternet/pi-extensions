import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  type LiveMedia,
  type LiveMediaCallbacks,
  LocalLiveMedia,
} from "./media.ts";
import { isObject } from "./type-guards.ts";
import type { VoiceLockHandoffResponse } from "./voice-lock.ts";

// Each connection is either one call's media (after "hello") or a short
// status/handoff probe. Messages are newline-delimited JSON in both
// directions: {id?, method, params?} and {id, result | error}.
export const RELAY_SOCKET_PATH = join(homedir(), ".pi", "live-codex-relay.sock");
export const RELAY_SOCKET_DISPLAY_PATH = "~/.pi/live-codex-relay.sock";
const PROTOCOL_VERSION = 1;
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_FIELD_CHARS = 512;
const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const HANDOFF_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

type Message = Record<string, unknown>;

export interface VoiceRelayOwner {
  sessionId: string;
  host: string;
}

class RelayDisconnectedError extends Error {
  constructor() {
    super("Voice relay disconnected.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function params(message: Message): Message {
  return isObject(message.params) ? message.params : {};
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, MAX_FIELD_CHARS)
    : undefined;
}

function handoffResponse(value: unknown): VoiceLockHandoffResponse {
  if (!isObject(value) || typeof value.accepted !== "boolean") {
    return { accepted: false, reason: "Voice relay handoff response was invalid." };
  }
  const reason = boundedString(value.reason);
  return { accepted: value.accepted, ...(reason ? { reason } : {}) };
}

/** Bidirectional newline-delimited JSON RPC over one socket. */
class RelayConnection {
  readonly #socket: Socket;
  readonly #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  #nextId = 1;
  #closed = false;
  onMessage: (message: Message) => unknown = () => {
    throw new Error("Unsupported voice relay request.");
  };
  onDisconnect: () => void = () => {};

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      this.#closed = true;
      this.#rejectPending();
      this.onDisconnect();
    });
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (isObject(value)) this.#receive(value);
        } catch {}
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) {
        socket.destroy(new Error("Voice relay message is too large."));
      }
    });
  }

  call(method: string, args?: Message, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RelayDisconnectedError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Voice relay did not answer ${method}.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(args ? { id, method, params: args } : { id, method });
    });
  }

  notify(method: string, args?: Message): void {
    this.#write(args ? { method, params: args } : { method });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending();
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #write(message: Message): void {
    if (!this.#closed && this.#socket.writable) {
      this.#socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  #receive(message: Message): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    if (typeof message.method !== "string") {
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id!);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    Promise.resolve()
      .then(() => this.onMessage(message))
      .then(
        (result) => {
          if (id !== undefined) this.#write({ id, result: result ?? null });
        },
        (error: unknown) => {
          if (id !== undefined) this.#write({ id, error: errorMessage(error) });
        },
      );
  }

  #rejectPending(): void {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new RelayDisconnectedError());
    }
    this.#pending.clear();
  }
}

export interface VoiceRelay {
  readonly path: string;
  ownerHost(): string | undefined;
  close(): Promise<void>;
}

export interface VoiceRelayOptions {
  path?: string;
  createMedia?: (callbacks: LiveMediaCallbacks) => LiveMedia;
  onConnectionChange?: () => void;
}

/** Serve this machine's microphone and speaker to one Pi session at a time. */
export async function startVoiceRelay(
  options: VoiceRelayOptions = {},
): Promise<VoiceRelay> {
  const path = options.path ?? RELAY_SOCKET_PATH;
  const createMedia = options.createMedia ??
    ((callbacks) => new LocalLiveMedia(callbacks));
  mkdirSync(dirname(path), { recursive: true });
  const existing = await openSocket(path);
  if (existing) {
    existing.destroy();
    throw new Error(`A voice relay is already running at ${path}.`);
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let owner: (VoiceRelayOwner & {
    connection: RelayConnection;
    release(): Promise<void>;
  }) | undefined;
  const connections = new Set<RelayConnection>();
  const setOwner = (next: typeof owner): void => {
    owner = next;
    options.onConnectionChange?.();
  };

  const handoff = async (
    connection: RelayConnection,
    requesterSessionId: string,
  ): Promise<VoiceLockHandoffResponse> => {
    const current = owner;
    if (!current || current.connection === connection) return { accepted: true };
    let response: VoiceLockHandoffResponse;
    try {
      response = handoffResponse(await current.connection.call(
        "handoff",
        { requesterSessionId },
        HANDOFF_TIMEOUT_MS,
      ));
    } catch (error) {
      if (!(error instanceof RelayDisconnectedError)) {
        return { accepted: false, reason: errorMessage(error) };
      }
      // The owner went away, which frees the relay just the same.
      response = { accepted: true };
    }
    // Free the relay before replying so the requester's hello succeeds.
    if (response.accepted) await current.release();
    return response;
  };

  const server = createServer((socket) => {
    const connection = new RelayConnection(socket);
    connections.add(connection);
    let media: LiveMedia | undefined;
    const release = async (): Promise<void> => {
      if (owner?.connection === connection) setOwner(undefined);
      const released = media;
      media = undefined;
      connection.destroy();
      await released?.close().catch(() => {});
    };
    connection.onDisconnect = () => {
      connections.delete(connection);
      void release();
    };
    connection.onMessage = async (message) => {
      const args = params(message);
      switch (message.method) {
        case "status":
          return { owner: owner ? { sessionId: owner.sessionId, host: owner.host } : null };
        case "handoff":
          return handoff(
            connection,
            boundedString(args.requesterSessionId) ?? "unknown",
          );
        case "hello": {
          if (args.version !== PROTOCOL_VERSION) {
            throw new Error(
              `Voice relay protocol mismatch (relay ${PROTOCOL_VERSION}, client ${String(args.version)}). Update pi-live-codex on both machines.`,
            );
          }
          if (media) return { version: PROTOCOL_VERSION };
          if (owner) {
            throw new Error(
              "The voice relay is in use by another Pi session. Pause voice there first.",
            );
          }
          media = createMedia({
            onPeerEvent: (payload) => connection.notify("event", { payload }),
            onInputLevel: (level) => connection.notify("input-level", { level }),
            onOutputLevel: (level) => connection.notify("output-level", { level }),
            onMicrophoneRestarted: () => connection.notify("microphone-restarted"),
            onFailure: (error) =>
              connection.notify("failure", { message: error.message }),
          });
          setOwner({
            connection,
            sessionId: boundedString(args.sessionId) ?? "unknown",
            host: boundedString(args.host) ?? "unknown host",
            release,
          });
          return { version: PROTOCOL_VERSION };
        }
      }
      if (!media) throw new Error("The voice relay session has not started.");
      switch (message.method) {
        case "attestation":
          return (await media.attestation()) ?? null;
        case "offer":
          return media.createOffer();
        case "answer":
          if (typeof args.sdp !== "string") throw new Error("Missing SDP answer.");
          return media.acceptAnswer(args.sdp);
        case "open":
          return media.waitForOpen();
        case "capture":
          return media.startCapture();
        case "mute":
          media.setMuted(args.muted === true);
          return;
      }
      throw new Error(`Unknown voice relay method: ${String(message.method)}`);
    };
  });

  await listen(server, path);
  server.on("error", () => {});
  chmodSync(path, 0o600);

  return {
    path,
    ownerHost: () => owner?.host,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(path);
      } catch {}
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Resolve undefined when nothing listens at `path`. */
function openSocket(path: string): Promise<Socket | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to the voice relay at ${path}.`));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        resolve(undefined);
      } else {
        reject(error);
      }
    });
  });
}

class RelayLiveMedia implements LiveMedia {
  readonly #connection: RelayConnection;
  readonly #callbacks: LiveMediaCallbacks;
  #ready = false;
  #closed = false;
  #handoff: Promise<unknown> | undefined;

  constructor(connection: RelayConnection, callbacks: LiveMediaCallbacks) {
    this.#connection = connection;
    this.#callbacks = callbacks;
    connection.onMessage = (message) => this.#receive(message);
    connection.onDisconnect = () => {
      const expected = this.#closed;
      this.#closed = true;
      if (!expected && this.#ready) {
        this.#callbacks.onFailure(new RelayDisconnectedError());
      }
    };
  }

  async hello(sessionId: string): Promise<void> {
    const result = await this.#connection.call(
      "hello",
      { version: PROTOCOL_VERSION, sessionId, host: hostname() },
      PROBE_TIMEOUT_MS,
    );
    if (!isObject(result) || result.version !== PROTOCOL_VERSION) {
      throw new Error("The voice relay returned an invalid handshake.");
    }
    this.#ready = true;
  }

  async attestation(): Promise<string | undefined> {
    const result = await this.#connection.call("attestation");
    return typeof result === "string" ? result : undefined;
  }

  async createOffer(): Promise<string> {
    const result = await this.#connection.call("offer");
    if (typeof result !== "string") {
      throw new Error("The voice relay returned an invalid SDP offer.");
    }
    return result;
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.#connection.call("answer", { sdp });
  }

  async waitForOpen(): Promise<void> {
    await this.#connection.call("open");
  }

  async startCapture(): Promise<void> {
    await this.#connection.call("capture");
  }

  setMuted(muted: boolean): void {
    this.#connection.notify("mute", { muted });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const handoff = this.#handoff;
    if (!handoff) {
      this.#connection.close();
      return;
    }
    // Pausing for a handoff closes media first; reply once the session has
    // finished pausing, then disconnect.
    void handoff.then(() => {
      setImmediate(() => this.#connection.close());
    });
  }

  #receive(message: Message): unknown {
    if (this.#closed) return;
    const args = params(message);
    switch (message.method) {
      case "handoff": {
        // Register before the handler runs; it may close media synchronously.
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        this.#handoff = settled;
        const response = Promise.resolve().then(() =>
          this.#callbacks.onHandoffRequest?.() ?? { accepted: true }
        );
        void response.finally(() => {
          settle();
          if (this.#handoff === settled) this.#handoff = undefined;
        }).catch(() => {});
        return response;
      }
      case "event":
        if (typeof args.payload === "string") this.#callbacks.onPeerEvent(args.payload);
        return;
      case "input-level":
        if (typeof args.level === "number") this.#callbacks.onInputLevel(args.level);
        return;
      case "output-level":
        if (typeof args.level === "number") this.#callbacks.onOutputLevel(args.level);
        return;
      case "microphone-restarted":
        this.#callbacks.onMicrophoneRestarted();
        return;
      case "failure":
        this.#callbacks.onFailure(new Error(
          boundedString(args.message) ?? "Voice relay media failed.",
        ));
        return;
    }
  }
}

/**
 * Connect to a voice relay at `path`, or resolve undefined when none listens.
 * Over SSH the path is a forwarded Unix socket.
 */
export async function connectVoiceRelay(
  callbacks: LiveMediaCallbacks,
  sessionId: string,
  path = RELAY_SOCKET_PATH,
): Promise<LiveMedia | undefined> {
  const socket = await openSocket(path);
  if (!socket) return undefined;
  const media = new RelayLiveMedia(new RelayConnection(socket), callbacks);
  try {
    await media.hello(sessionId);
  } catch (error) {
    await media.close();
    throw error instanceof RelayDisconnectedError
      ? new Error(
        `${path} accepted the connection but no voice relay answered. Run /live-relay on the machine with your microphone, or stop the stale forward.`,
      )
      : error;
  }
  return media;
}

async function probeRelay(
  path: string,
  method: string,
  args: Message | undefined,
  timeoutMs: number,
): Promise<{ result: unknown } | undefined> {
  const socket = await openSocket(path);
  if (!socket) return undefined;
  const connection = new RelayConnection(socket);
  try {
    return { result: await connection.call(method, args, timeoutMs) };
  } finally {
    connection.close();
  }
}

/** The session using the relay at `path`, if any. */
export async function voiceRelayOwner(
  path = RELAY_SOCKET_PATH,
): Promise<VoiceRelayOwner | undefined> {
  try {
    const probe = await probeRelay(path, "status", undefined, PROBE_TIMEOUT_MS);
    const owner = isObject(probe?.result) ? probe.result.owner : undefined;
    if (!isObject(owner)) return undefined;
    return {
      sessionId: boundedString(owner.sessionId) ?? "unknown",
      host: boundedString(owner.host) ?? "unknown host",
    };
  } catch {
    // An unreachable relay surfaces a specific error when voice connects.
    return undefined;
  }
}

/** Ask the relay's current session to pause so `sessionId` can take over. */
export async function requestVoiceRelayHandoff(
  sessionId: string,
  path = RELAY_SOCKET_PATH,
): Promise<VoiceLockHandoffResponse> {
  const probe = await probeRelay(
    path,
    "handoff",
    { requesterSessionId: sessionId },
    HANDOFF_TIMEOUT_MS + PROBE_TIMEOUT_MS,
  );
  return probe ? handoffResponse(probe.result) : { accepted: true };
}

/** Prefer a reachable voice relay; otherwise use this machine's audio. */
export async function openLiveMedia(
  callbacks: LiveMediaCallbacks,
  sessionId: string,
): Promise<LiveMedia> {
  const relayed = await connectVoiceRelay(callbacks, sessionId);
  if (relayed) return relayed;
  return new LocalLiveMedia(callbacks, {
    captureErrorHint: process.env.SSH_CONNECTION
      ? `Pi is running over SSH. To use your local microphone, run /live-relay locally and forward ${RELAY_SOCKET_DISPLAY_PATH} to this machine.`
      : undefined,
  });
}
