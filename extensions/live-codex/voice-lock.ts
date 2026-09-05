import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  connect,
  createServer,
  type Server,
  type Socket,
} from "node:net";

const LOCK_DIRECTORY = join(homedir(), ".pi", "pi-live-codex.lock");
const OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_STALE_MS = 5_000;
const CONTROL_VERSION = 1;
const CONTROL_REQUEST_TYPE = "pi-live-codex.handoff.request";
const CONTROL_RESPONSE_TYPE = "pi-live-codex.handoff.response";
const MAX_CONTROL_PAYLOAD_BYTES = 16 * 1024;
const MAX_CONTROL_REASON_CHARS = 2_000;
const MAX_SESSION_ID_CHARS = 512;
const CONTROL_SERVER_TIMEOUT_MS = 2_000;
const CONTROL_CONNECT_TIMEOUT_MS = 1_000;
const CONTROL_RESPONSE_TIMEOUT_MS = 10_000;
const MAX_CLIENT_TIMEOUT_MS = 30_000;

export interface VoiceLockOwner {
  pid: number;
  sessionId: string;
  startedAt: string;
  token: string;
  controlPort?: number;
}

export interface VoiceLockHandoffRequest {
  requesterSessionId: string;
}

export interface VoiceLockHandoffResponse {
  accepted: boolean;
  reason?: string;
}

export type VoiceLockHandoffHandler = (
  request: VoiceLockHandoffRequest,
) => VoiceLockHandoffResponse | Promise<VoiceLockHandoffResponse>;

export interface VoiceLockHandoffClientOptions {
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export class VoiceLockHeldError extends Error {
  readonly owner: VoiceLockOwner | undefined;

  constructor(owner?: VoiceLockOwner) {
    const detail = owner
      ? ` (PID ${owner.pid}, session ${owner.sessionId})`
      : "";
    super(
      `Voice mode is already active in another Pi session${detail}. Stop it there before starting /live here.`,
    );
    this.name = "VoiceLockHeldError";
    this.owner = owner;
  }
}

export class VoiceLock {
  readonly #directory: string;
  readonly #token: string;
  readonly #server: Server;
  readonly #setControlHandler: (handler: VoiceLockHandoffHandler | undefined) => void;
  #serverClosed = false;
  #ownerFileRemoved = false;
  #released = false;

  constructor(
    directory: string,
    token: string,
    server: Server,
    setControlHandler: (handler: VoiceLockHandoffHandler | undefined) => void,
  ) {
    this.#directory = directory;
    this.#token = token;
    this.#server = server;
    this.#setControlHandler = setControlHandler;
  }

  setHandoffHandler(handler: VoiceLockHandoffHandler | undefined): void {
    if (this.#released) return;
    this.#setControlHandler(handler);
  }

  release(): void {
    if (this.#released) return;

    if (!this.#ownerFileRemoved) {
      const owner = readOwner(this.#directory);
      if (!owner || owner.token !== this.#token) {
        this.#setControlHandler(undefined);
        this.#closeControlServer();
        this.#released = true;
        return;
      }
      this.#setControlHandler(undefined);
      this.#closeControlServer();
      try {
        unlinkSync(join(this.#directory, OWNER_FILE));
        this.#ownerFileRemoved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.#released = true;
          return;
        }
        throw error;
      }
    } else if (existsSync(join(this.#directory, OWNER_FILE))) {
      // A retry after partial cleanup must not remove a replacement owner.
      const owner = readOwner(this.#directory);
      if (owner && owner.token !== this.#token) {
        this.#released = true;
        return;
      }
      if (!owner) {
        this.#released = true;
        return;
      }
    }

    try {
      rmdirSync(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#released = true;
  }

  #closeControlServer(): void {
    if (this.#serverClosed) return;
    try {
      this.#server.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        throw error;
      }
    }
    this.#serverClosed = true;
  }
}

function readOwner(directory: string): VoiceLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(directory, OWNER_FILE), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !("sessionId" in value) ||
      typeof value.sessionId !== "string" ||
      !("startedAt" in value) ||
      typeof value.startedAt !== "string" ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return undefined;
    }
    const controlPort = "controlPort" in value ? value.controlPort : undefined;
    if (
      controlPort !== undefined &&
      (typeof controlPort !== "number" ||
        !Number.isSafeInteger(controlPort) ||
        controlPort < 1 ||
        controlPort > 65_535)
    ) {
      return undefined;
    }
    return {
      pid: value.pid,
      sessionId: value.sessionId,
      startedAt: value.startedAt,
      token: value.token,
      ...(controlPort === undefined ? {} : { controlPort }),
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function incompleteLockIsRecent(directory: string): boolean {
  try {
    return Date.now() - statSync(directory).mtimeMs < INCOMPLETE_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function discardStaleLock(directory: string, token: string): boolean {
  const staleDirectory = `${directory}.stale-${token}`;
  try {
    renameSync(directory, staleDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    unlinkSync(join(staleDirectory, OWNER_FILE));
  } catch {}
  try {
    rmdirSync(staleDirectory);
  } catch {}
  return true;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, MAX_CLIENT_TIMEOUT_MS);
}

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_CONTROL_REASON_CHARS);
}

function responsePayload(response: VoiceLockHandoffResponse): string {
  const payload = {
    version: CONTROL_VERSION,
    type: CONTROL_RESPONSE_TYPE,
    accepted: response.accepted,
    ...(response.reason ? { reason: boundedReason(response.reason) } : {}),
  };
  return `${JSON.stringify(payload)}\n`;
}

function sendControlResponse(
  socket: Socket,
  response: VoiceLockHandoffResponse,
): void {
  try {
    socket.end(responsePayload(response));
  } catch {}
}

function invalidRequestResponse(reason: string): VoiceLockHandoffResponse {
  return { accepted: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function installControlServer(
  server: Server,
  token: string,
  getHandler: () => VoiceLockHandoffHandler | undefined,
): void {
  server.on("connection", (socket) => {
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      sendControlResponse(
        socket,
        invalidRequestResponse("Voice handoff request timed out."),
      );
    }, CONTROL_SERVER_TIMEOUT_MS);

    const respond = (response: VoiceLockHandoffResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sendControlResponse(socket, response);
    };

    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("error", () => {
      settled = true;
      clearTimeout(timeout);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
    });
    socket.on("data", (chunk: string) => {
      if (settled) return;
      if (
        Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(chunk, "utf8") >
        MAX_CONTROL_PAYLOAD_BYTES
      ) {
        respond(invalidRequestResponse("Voice handoff request is too large."));
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      if (buffer.slice(newline + 1).trim()) {
        respond(invalidRequestResponse("Voice handoff request has extra data."));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        respond(invalidRequestResponse("Voice handoff request is not valid JSON."));
        return;
      }
      if (!isRecord(value) ||
        value.version !== CONTROL_VERSION ||
        value.type !== CONTROL_REQUEST_TYPE ||
        typeof value.token !== "string" ||
        !tokensMatch(value.token, token)) {
        respond(invalidRequestResponse("Voice handoff request was not authenticated."));
        return;
      }
      const requesterSessionId = value.requesterSessionId;
      if (typeof requesterSessionId !== "string" ||
        requesterSessionId.trim().length === 0 ||
        requesterSessionId.length > MAX_SESSION_ID_CHARS) {
        respond(invalidRequestResponse("Voice handoff requester identity is invalid."));
        return;
      }
      clearTimeout(timeout);
      const handler = getHandler();
      if (!handler) {
        respond(invalidRequestResponse(
          "The current voice session is not ready to hand off; try again.",
        ));
        return;
      }
      Promise.resolve(handler({ requesterSessionId: requesterSessionId.trim() }))
        .then((response) => {
          if (!isRecord(response) || typeof response.accepted !== "boolean") {
            respond(invalidRequestResponse("Voice handoff response was invalid."));
            return;
          }
          respond({
            accepted: response.accepted,
            ...(typeof response.reason === "string" && response.reason
              ? { reason: response.reason }
              : {}),
          });
        })
        .catch((error: unknown) => {
          respond(invalidRequestResponse(
            error instanceof Error ? error.message : "Voice handoff failed.",
          ));
        });
    });
  });
}

async function listenForControl(
  token: string,
): Promise<{
  server: Server;
  port: number;
  setHandler(handler: VoiceLockHandoffHandler | undefined): void;
}> {
  const server = createServer({ allowHalfOpen: true });
  let handler: VoiceLockHandoffHandler | undefined;
  installControlServer(server, token, () => handler);
  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port: 0 });
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  // Keep later server errors from becoming uncaught process errors after the
  // initial listen has completed.
  server.on("error", () => {});
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Voice handoff control server did not expose a port.");
  }
  return {
    server,
    port: address.port,
    setHandler: (value) => {
      handler = value;
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function acquireVoiceLock(
  sessionId: string,
  directory = LOCK_DIRECTORY,
): Promise<VoiceLock> {
  const token = randomUUID();
  mkdirSync(dirname(directory), { recursive: true });

  for (;;) {
    try {
      mkdirSync(directory);
      let control: Awaited<ReturnType<typeof listenForControl>> | undefined;
      try {
        control = await listenForControl(token);
        const owner: VoiceLockOwner = {
          pid: process.pid,
          sessionId,
          startedAt: new Date().toISOString(),
          token,
          controlPort: control.port,
        };
        writeFileSync(
          join(directory, OWNER_FILE),
          `${JSON.stringify(owner)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        const lock = new VoiceLock(
          directory,
          token,
          control.server,
          control.setHandler,
        );
        return lock;
      } catch (error) {
        if (control) await closeServer(control.server);
        try {
          unlinkSync(join(directory, OWNER_FILE));
        } catch {}
        try {
          rmdirSync(directory);
        } catch {}
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = readOwner(directory);
    if (
      (owner && processIsAlive(owner.pid)) ||
      (!owner && incompleteLockIsRecent(directory))
    ) {
      throw new VoiceLockHeldError(owner);
    }
    discardStaleLock(directory, token);
  }
}

export function requestVoiceLockHandoff(
  owner: VoiceLockOwner,
  requesterSessionId: string,
  options: VoiceLockHandoffClientOptions = {},
): Promise<VoiceLockHandoffResponse> {
  const controlPort = owner.controlPort;
  if (!controlPort) {
    return Promise.reject(
      new Error(
        "The current voice owner does not support cooperative handoff; stop voice mode there first.",
      ),
    );
  }
  if (!requesterSessionId.trim() || requesterSessionId.length > MAX_SESSION_ID_CHARS) {
    return Promise.reject(new Error("Voice handoff requester identity is invalid."));
  }
  const connectTimeout = boundedTimeout(
    options.connectTimeoutMs,
    CONTROL_CONNECT_TIMEOUT_MS,
  );
  const responseTimeout = boundedTimeout(
    options.responseTimeoutMs,
    CONTROL_RESPONSE_TIMEOUT_MS,
  );
  const payload = `${JSON.stringify({
    version: CONTROL_VERSION,
    type: CONTROL_REQUEST_TYPE,
    token: owner.token,
    requesterSessionId: requesterSessionId.trim(),
  })}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_CONTROL_PAYLOAD_BYTES) {
    return Promise.reject(new Error("Voice handoff request is too large."));
  }

  return new Promise<VoiceLockHandoffResponse>((resolve, reject) => {
    let settled = false;
    let responseBuffer = "";
    let responseTimer: NodeJS.Timeout | undefined;
    const socket = connect({
      host: "127.0.0.1",
      port: controlPort,
    });
    const connectTimer = setTimeout(() => {
      finishError(new Error("Voice handoff connection timed out."));
    }, connectTimeout);

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket?.destroy();
      reject(error);
    };

    const finishResponse = (response: VoiceLockHandoffResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket?.destroy();
      resolve(response);
    };

    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => {
        finishError(new Error("Voice handoff response timed out."));
      }, responseTimeout);
      socket.write(payload);
    });
    socket.on("data", (chunk: string) => {
      if (settled) return;
      if (
        Buffer.byteLength(responseBuffer, "utf8") + Buffer.byteLength(chunk, "utf8") >
        MAX_CONTROL_PAYLOAD_BYTES
      ) {
        finishError(new Error("Voice handoff response is too large."));
        return;
      }
      responseBuffer += chunk;
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) return;
      if (responseBuffer.slice(newline + 1).trim()) {
        finishError(new Error("Voice handoff response has extra data."));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(responseBuffer.slice(0, newline).trim());
      } catch {
        finishError(new Error("Voice handoff response is not valid JSON."));
        return;
      }
      if (!isRecord(value) ||
        value.version !== CONTROL_VERSION ||
        value.type !== CONTROL_RESPONSE_TYPE ||
        typeof value.accepted !== "boolean") {
        finishError(new Error("Voice handoff response was invalid."));
        return;
      }
      finishResponse({
        accepted: value.accepted,
        ...(typeof value.reason === "string" && value.reason
          ? { reason: value.reason }
          : {}),
      });
    });
    socket.once("error", (error) => {
      finishError(error instanceof Error ? error : new Error(String(error)));
    });
    socket.once("close", () => {
      if (!settled) finishError(new Error("Voice handoff connection closed."));
    });
  });
}
