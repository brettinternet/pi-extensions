import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type LiveMedia,
  type LiveMediaCallbacks,
  LocalLiveMedia,
} from "./media.ts";
import { isObject } from "./type-guards.ts";

// One connection carries one call's media. Requests and notifications are
// newline-delimited JSON: {id?, method, params?} and {id, result | error}.
export const RELAY_SOCKET_PATH = join(homedir(), ".pi", "live-codex-relay.sock");
export const RELAY_SOCKET_DISPLAY_PATH = "~/.pi/live-codex-relay.sock";
const PROTOCOL_VERSION = 1;
const MAX_LINE_CHARS = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 60_000;

type Message = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLines(socket: Socket, onMessage: (message: Message) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (isObject(value)) onMessage(value);
      } catch {}
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_CHARS) {
      socket.destroy(new Error("Voice relay message is too large."));
    }
  });
}

function write(socket: Socket, message: Message): void {
  if (!socket.destroyed && socket.writable) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

function params(message: Message): Message {
  return isObject(message.params) ? message.params : {};
}

export interface VoiceRelay {
  readonly path: string;
  connected(): boolean;
  close(): Promise<void>;
}

export interface VoiceRelayOptions {
  path?: string;
  createMedia?: (callbacks: LiveMediaCallbacks) => LiveMedia;
  onConnectionChange?: (connected: boolean) => void;
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

  let owner: Socket | undefined;
  const sockets = new Set<Socket>();
  const setOwner = (socket: Socket | undefined): void => {
    if (owner === socket) return;
    owner = socket;
    options.onConnectionChange?.(socket !== undefined);
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    let media: LiveMedia | undefined;
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (owner === socket) setOwner(undefined);
      void media?.close().catch(() => {});
      media = undefined;
    });
    const notify = (method: string, params?: Message): void =>
      write(socket, params ? { method, params } : { method });

    const handle = async (message: Message): Promise<unknown> => {
      const args = params(message);
      if (message.method === "hello") {
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
          onPeerEvent: (payload) => notify("event", { payload }),
          onInputLevel: (level) => notify("input-level", { level }),
          onOutputLevel: (level) => notify("output-level", { level }),
          onMicrophoneRestarted: () => notify("microphone-restarted"),
          onFailure: (error) => notify("failure", { message: error.message }),
        });
        setOwner(socket);
        return { version: PROTOCOL_VERSION };
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

    readLines(socket, (message) => {
      const id = typeof message.id === "number" ? message.id : undefined;
      handle(message).then(
        (result) => {
          if (id !== undefined) write(socket, { id, result: result ?? null });
        },
        (error: unknown) => {
          if (id !== undefined) write(socket, { id, error: errorMessage(error) });
        },
      );
    });
  });

  await listen(server, path);
  server.on("error", () => {});
  chmodSync(path, 0o600);

  return {
    path,
    connected: () => owner !== undefined,
    close: async () => {
      for (const socket of sockets) socket.destroy();
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
  readonly #socket: Socket;
  readonly #callbacks: LiveMediaCallbacks;
  readonly #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  #nextId = 1;
  #ready = false;
  #closed = false;

  constructor(socket: Socket, callbacks: LiveMediaCallbacks) {
    this.#socket = socket;
    this.#callbacks = callbacks;
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.on("close", () => this.#disconnected());
    readLines(socket, (message) => this.#receive(message));
  }

  async hello(): Promise<void> {
    const result = await this.#call(
      "hello",
      { version: PROTOCOL_VERSION },
      HELLO_TIMEOUT_MS,
    );
    if (!isObject(result) || result.version !== PROTOCOL_VERSION) {
      throw new Error("The voice relay returned an invalid handshake.");
    }
    this.#ready = true;
  }

  async attestation(): Promise<string | undefined> {
    const result = await this.#call("attestation");
    return typeof result === "string" ? result : undefined;
  }

  async createOffer(): Promise<string> {
    const result = await this.#call("offer");
    if (typeof result !== "string") {
      throw new Error("The voice relay returned an invalid SDP offer.");
    }
    return result;
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.#call("answer", { sdp });
  }

  async waitForOpen(): Promise<void> {
    await this.#call("open");
  }

  async startCapture(): Promise<void> {
    await this.#call("capture");
  }

  setMuted(muted: boolean): void {
    if (!this.#closed) write(this.#socket, { method: "mute", params: { muted } });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("Voice relay connection closed."));
    this.#socket.end();
  }

  #call(method: string, args?: Message, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Voice relay connection closed."));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Voice relay did not answer ${method}.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      write(this.#socket, args ? { id, method, params: args } : { id, method });
    });
  }

  #receive(message: Message): void {
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (!this.#ready || this.#closed) return;
    const args = params(message);
    switch (message.method) {
      case "event":
        if (typeof args.payload === "string") this.#callbacks.onPeerEvent(args.payload);
        break;
      case "input-level":
        if (typeof args.level === "number") this.#callbacks.onInputLevel(args.level);
        break;
      case "output-level":
        if (typeof args.level === "number") this.#callbacks.onOutputLevel(args.level);
        break;
      case "microphone-restarted":
        this.#callbacks.onMicrophoneRestarted();
        break;
      case "failure":
        this.#callbacks.onFailure(new Error(
          typeof args.message === "string" ? args.message : "Voice relay media failed.",
        ));
        break;
    }
  }

  #disconnected(): void {
    const expected = this.#closed;
    this.#closed = true;
    this.#rejectPending(new Error("Voice relay disconnected."));
    if (!expected && this.#ready) {
      this.#callbacks.onFailure(new Error("Voice relay disconnected."));
    }
  }

  #rejectPending(error: Error): void {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * Connect to a voice relay at `path`, or resolve undefined when none listens.
 * Over SSH the path is a forwarded Unix socket.
 */
export async function connectVoiceRelay(
  callbacks: LiveMediaCallbacks,
  path = RELAY_SOCKET_PATH,
): Promise<LiveMedia | undefined> {
  const socket = await openSocket(path);
  if (!socket) return undefined;
  const media = new RelayLiveMedia(socket, callbacks);
  try {
    await media.hello();
  } catch (error) {
    await media.close();
    const message = errorMessage(error);
    throw new Error(
      message === "Voice relay disconnected."
        ? `${path} accepted the connection but no voice relay answered. Run /live-relay on the machine with your microphone, or stop the stale forward.`
        : message,
    );
  }
  return media;
}

/** Prefer a reachable voice relay; otherwise use this machine's audio. */
export async function openLiveMedia(
  callbacks: LiveMediaCallbacks,
): Promise<LiveMedia> {
  const relayed = await connectVoiceRelay(callbacks);
  if (relayed) return relayed;
  return new LocalLiveMedia(callbacks, {
    captureErrorHint: process.env.SSH_CONNECTION
      ? `Pi is running over SSH. To use your local microphone, run /live-relay locally and forward ${RELAY_SOCKET_DISPLAY_PATH} to this machine.`
      : undefined,
  });
}
