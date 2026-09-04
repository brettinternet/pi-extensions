import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  BROKER_PATH,
  DOCKER_CONTEXT,
  PROTOCOL_VERSION,
  type BrokerOperation,
  type BrokerResponse,
  encodeBrokerRequest,
  parseBrokerResponse,
} from "./protocol.ts";

const DOCKER_COMMAND = "docker";
const MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  abortRequested: boolean;
  onAbort?: () => void;
};

export interface BrokerClientConfig {
  containerName: string;
}

export class BrokerClient {
  readonly #containerName: string;
  readonly #spawnProcess: SpawnProcess;
  readonly #pending = new Map<string, PendingRequest<unknown>>();
  readonly #cancelled = new Set<string>();
  readonly #decoder = new StringDecoder("utf8");
  #child: ChildProcess | undefined;
  #buffer = "";
  #stderr = "";
  #nextId = 0;
  #fatalError: Error | undefined;
  #stopping = false;

  constructor(config: BrokerClientConfig, spawnProcess: SpawnProcess = spawn) {
    this.#containerName = config.containerName;
    this.#spawnProcess = spawnProcess;
  }

  async start(): Promise<void> {
    if (this.#fatalError) throw this.#fatalError;
    if (this.#child) return;
    const child = this.#spawnProcess(
      DOCKER_COMMAND,
      ["--context", DOCKER_CONTEXT, "exec", "--interactive", this.#containerName, BROKER_PATH],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.#receive(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(this.#stderr, "utf8") >= MAX_STDERR_BYTES) return;
      this.#stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(this.#stderr, "utf8") > MAX_STDERR_BYTES) {
        this.#stderr = Buffer.from(this.#stderr).subarray(0, MAX_STDERR_BYTES).toString("utf8");
      }
    });
    child.on("error", (error) => this.#fail(new Error(`sandbox broker process failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (!this.#stopping && !this.#fatalError) {
        const detail = this.#stderr.trim();
        this.#fail(new Error(`sandbox broker exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      }
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolvePromise();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        rejectPromise(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const result = await this.request<{ protocol: number; workspace: string }>("ping", {}, { signal: effectiveSignal });
    if (result.protocol !== PROTOCOL_VERSION || result.workspace !== "/workspace") {
      this.#fail(new Error("sandbox broker handshake mismatch"));
      throw this.#fatalError;
    }
  }

  request<T>(
    operation: BrokerOperation,
    payload: unknown,
    options: { signal?: AbortSignal; onData?: (data: Buffer) => void } = {},
  ): Promise<T> {
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    const child = this.#child;
    if (!child?.stdin || child.stdin.destroyed) return Promise.reject(new Error("sandbox broker is not running"));
    if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

    const id = `r${++this.#nextId}`;
    const pending: PendingRequest<T> = {
      resolve: () => {},
      reject: () => {},
      onData: options.onData,
      signal: options.signal,
      abortRequested: false,
    };
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      pending.resolve = resolvePromise;
      pending.reject = rejectPromise;
    });
    pending.onAbort = () => {
      if (pending.abortRequested) return;
      pending.abortRequested = true;
      this.#pending.delete(id);
      this.#cancelled.add(id);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.reject(new Error("aborted"));
      try {
        this.#write({ version: PROTOCOL_VERSION, id: `c${++this.#nextId}`, op: "cancel", target: id });
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.#pending.set(id, pending as PendingRequest<unknown>);
    options.signal?.addEventListener("abort", pending.onAbort, { once: true });

    try {
      this.#write({ version: PROTOCOL_VERSION, id, op: operation, payload });
    } catch (error) {
      this.#pending.delete(id);
      options.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    return promise;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#stopping = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.reject(new Error("aborted"));
    }
    if (!child) return;
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      child.once("close", settle);
      if (child.exitCode !== null || child.signalCode !== null) {
        settle();
        return;
      }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
      const settleTimer = setTimeout(settle, 5_000);
      child.once("close", () => {
        clearTimeout(killTimer);
        clearTimeout(settleTimer);
      });
    });
    this.#child = undefined;
  }

  #write(request: Parameters<typeof encodeBrokerRequest>[0]): void {
    const child = this.#child;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("sandbox broker stdin is unavailable");
    child.stdin.write(encodeBrokerRequest(request));
  }

  #receive(chunk: Buffer | string): void {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_RESPONSE_LINE_BYTES) {
      this.#fail(new Error("sandbox broker response is too large"));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        this.#fail(new Error("sandbox broker returned a blank response"));
        return;
      }
      this.#route(line);
      if (this.#fatalError) return;
    }
  }

  #route(line: string): void {
    let response: BrokerResponse;
    try {
      response = parseBrokerResponse(line);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) {
      if (this.#cancelled.has(response.id)) {
        if (response.type === "result") this.#cancelled.delete(response.id);
        return;
      }
      this.#fail(new Error("sandbox broker returned an unknown request id"));
      return;
    }
    if (response.type === "data") {
      if (!pending.abortRequested) pending.onData?.(Buffer.from(response.data, "base64"));
      return;
    }

    this.#pending.delete(response.id);
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    if (pending.abortRequested) {
      pending.reject(new Error("aborted"));
    } else if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError) return;
    this.#fatalError = error;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.reject(error);
    }
    if (this.#child && !this.#stopping) this.#child.kill("SIGKILL");
  }
}