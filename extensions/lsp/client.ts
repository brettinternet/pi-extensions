import { spawn, type ChildProcess } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { getTrustedPath, isWithinWorkspace, type ServerDefinition } from "./servers.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const PUSH_DIAGNOSTIC_WAIT_MS = 650;
const MAX_OPEN_DOCUMENTS = 32;
const MAX_CACHED_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 1_500;
const MAX_REQUEST_BYTES = 8_000_000;

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export type DiagnosticResult =
  | { status: "clean"; diagnostics: LspDiagnostic[]; total: number; truncated: boolean; version: number; source: "pull" | "push" }
  | { status: "findings"; diagnostics: LspDiagnostic[]; total: number; truncated: boolean; version: number; source: "pull" | "push" }
  | { status: "unknown"; diagnostics: LspDiagnostic[]; total?: number; truncated?: boolean; advisory?: boolean; reason: string; version: number };

interface CachedReport {
  version: number;
  diagnostics: LspDiagnostic[];
  total: number;
  truncated: boolean;
  resultId?: string;
  source: "pull" | "push";
}

interface DocumentState {
  path: string;
  uri: string;
  version: number;
  text: string;
  used: number;
  report?: CachedReport;
  advisory?: LspDiagnostic[];
  advisoryTotal?: number;
  advisoryTruncated?: boolean;
  pushWaiters: Set<() => void>;
}

interface PullReport {
  kind?: unknown;
  items?: unknown;
  resultId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiagnostics(value: unknown): value is LspDiagnostic[] {
  const position = (point: unknown): point is { line: number; character: number } =>
    isRecord(point) && typeof point.line === "number" && Number.isSafeInteger(point.line) && point.line >= 0 &&
    typeof point.character === "number" && Number.isSafeInteger(point.character) && point.character >= 0;
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.message === "string" && isRecord(item.range) &&
    position(item.range.start) && position(item.range.end) &&
    (item.severity === undefined || (typeof item.severity === "number" && Number.isInteger(item.severity) && item.severity >= 1 && item.severity <= 4)) &&
    (item.source === undefined || typeof item.source === "string") &&
    (item.code === undefined || typeof item.code === "string" || typeof item.code === "number")
  );
}

function boundedDiagnostics(value: LspDiagnostic[]): { diagnostics: LspDiagnostic[]; truncated: boolean } {
  let truncated = value.length > MAX_CACHED_DIAGNOSTICS;
  const diagnostics = value.slice(0, MAX_CACHED_DIAGNOSTICS).map((entry) => {
    const message = entry.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS);
    if (message.length !== entry.message.length) truncated = true;
    return {
      ...entry,
      message,
      ...(entry.source === undefined ? {} : { source: entry.source.slice(0, 120) }),
    };
  });
  return { diagnostics, truncated };
}

async function readBoundedText(path: string, root: string): Promise<string> {
  const canonicalPath = await realpath(path);
  if (!isWithinWorkspace(canonicalPath, root)) {
    throw new Error(`Workspace document '${path}' now resolves outside the language-server root.`);
  }
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) throw new Error(`Workspace document '${path}' is not a regular file.`);
  if (metadata.size > MAX_REQUEST_BYTES) throw new Error(`File is larger than pi-lsp's ${MAX_REQUEST_BYTES.toLocaleString()} byte document limit.`);
  return readFile(canonicalPath, "utf8");
}

function abortError(): Error {
  return new DOMException("The LSP operation was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

function isUnsupported(error: unknown): boolean {
  return isRecord(error) && error.code === -32601;
}

function processTreeTarget(pid: number): number {
  return process.platform === "win32" ? pid : -pid;
}

function processTreeExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(processTreeTarget(pid), 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(processTreeTarget(pid), signal); } catch { /* owned tree has exited */ }
}

async function waitForProcessTreeExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processTreeExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processTreeExists(pid);
}

export class LspClient {
  private process?: ChildProcess;
  private connection?: MessageConnection;
  private canonicalRoot?: string;
  private documentVersion = 0;
  private readonly documents = new Map<string, DocumentState>();
  private readonly stderr: string[] = [];
  private initialized = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private pullDiagnosticsSupported = false;
  private connectionClosed = false;
  private capabilities: Record<string, unknown> = {};
  private queue: Promise<void> = Promise.resolve();
  private lastUsed = 0;
  private generation = 0;
  private startPromise?: Promise<void>;

  constructor(
    readonly root: string,
    readonly definition: ServerDefinition,
    readonly command: string[],
    private readonly options: { requestTimeoutMs?: number; initTimeoutMs?: number; pushWaitMs?: number; maxDocuments?: number } = {},
  ) {}

  get lastUsedAt(): number {
    return this.lastUsed;
  }

  get isRunning(): boolean {
    return Boolean(this.process && this.process.exitCode === null && !this.stopped && !this.connectionClosed);
  }

  get openDocumentCount(): number {
    return this.documents.size;
  }

  get mutationGeneration(): number {
    return this.generation;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) throw new Error("LSP client is stopped");
    this.startPromise = this.startImpl(signal);
    try {
      await this.startPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async startImpl(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const [executable, ...args] = this.command;
    if (!executable) throw new Error("The configured language server command is empty.");
    this.canonicalRoot = await realpath(this.root);
    const pathValue = getTrustedPath(this.definition.workspaceBoundary ?? this.canonicalRoot);
    throwIfAborted(signal);
    if (this.stopped) throw new Error("LSP client is stopped");
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: pathValue };
    if (process.platform === "win32" && environment.Path !== undefined) environment.Path = pathValue;
    const child = spawn(executable, args, {
      cwd: this.canonicalRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });
    this.process = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 64) this.stderr.shift();
    });
    child.once("exit", () => {
      this.pullDiagnosticsSupported = false;
      // A launcher crash must not strand workers until the next tool call.
      void this.stop();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        resolve();
      });
    });
    throwIfAborted(signal);
    if (!child.stdin || !child.stdout) throw new Error("Language server process did not create stdio pipes.");

    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    this.connection = connection;
    this.connectionClosed = false;
    connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => this.onPublishDiagnostics(params));
    connection.onRequest("workspace/configuration", (params: unknown) => {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
      return items.map(() => null);
    });
    connection.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(this.canonicalRoot ?? this.root).href, name: basename(this.canonicalRoot ?? this.root) }]);
    connection.onRequest("client/registerCapability", (params: unknown) => {
      const registrations = isRecord(params) && Array.isArray(params.registrations) ? params.registrations : [];
      if (registrations.some((entry) => isRecord(entry) && entry.method === "textDocument/diagnostic")) {
        this.pullDiagnosticsSupported = true;
      }
      return null;
    });
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "pi-lsp is read-only" }));
    connection.onClose(() => {
      this.pullDiagnosticsSupported = false;
      this.connectionClosed = true;
    });
    connection.listen();

    const rootUri = pathToFileURL(this.canonicalRoot).href;
    const initialized = await this.request<Record<string, unknown>>("initialize", {
      processId: process.pid,
      clientInfo: { name: "pi-lsp", version: "0.1.0" },
      rootPath: this.canonicalRoot,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.canonicalRoot) }],
      ...(this.definition.initializationOptions === undefined ? {} : { initializationOptions: this.definition.initializationOptions }),
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
          publishDiagnostics: { versionSupport: true },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
      },
    }, signal, this.options.initTimeoutMs ?? 15_000);
    const serverCapabilities = isRecord(initialized) && isRecord(initialized.capabilities) ? initialized.capabilities : {};
    this.capabilities = serverCapabilities;
    this.pullDiagnosticsSupported = this.pullDiagnosticsSupported || Boolean(serverCapabilities.diagnosticProvider);
    await this.notify("initialized", {});
    this.initialized = true;
    this.lastUsed = Date.now();
  }

  private getConnection(): MessageConnection {
    if (!this.connection || !this.initialized || !this.isRunning) throw new Error(`Language server '${this.definition.id}' is not running.`);
    return this.connection;
  }

  private async request<T>(method: string, params: unknown, signal?: AbortSignal, timeout = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS): Promise<T> {
    throwIfAborted(signal);
    const connection = this.connection;
    if (!connection || !this.process || this.process.exitCode !== null) throw new Error(`Language server '${this.definition.id}' is not available.`);
    const cancellation = new CancellationTokenSource();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelOnAbort = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => {
        if (!this.connectionClosed) {
          try { cancellation.cancel(); } catch { /* the peer may have closed between the check and cancel */ }
        }
        reject(signal.reason ?? abortError());
      }
      signal.addEventListener("abort", abortListener, { once: true });
    });
    const cancelOnTimeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (!this.connectionClosed) {
          try { cancellation.cancel(); } catch { /* a closed transport cannot send cancellation */ }
        }
        reject(new Error(`Language server '${this.definition.id}' timed out during ${method} (${timeout} ms).`));
      }, timeout);
    });
    try {
      const request = connection.sendRequest<T>(method, params, cancellation.token);
      return await Promise.race([request, cancelOnAbort, cancelOnTimeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      cancellation.dispose();
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.process || this.process.exitCode !== null) throw new Error(`Language server '${this.definition.id}' is not available.`);
    await connection.sendNotification(method, params);
  }

  private onPublishDiagnostics(value: unknown): void {
    if (!isRecord(value) || typeof value.uri !== "string" || !validDiagnostics(value.diagnostics)) return;
    const document = this.documents.get(value.uri);
    if (!document) return;
    if (Number.isInteger(value.version)) {
      if (value.version !== document.version) return;
      const bounded = boundedDiagnostics(value.diagnostics);
      document.report = {
        version: document.version,
        diagnostics: bounded.diagnostics,
        total: value.diagnostics.length,
        truncated: bounded.truncated,
        source: "push",
      };
      document.advisory = undefined;
    } else {
      const bounded = boundedDiagnostics(value.diagnostics);
      document.advisory = bounded.diagnostics;
      document.advisoryTotal = value.diagnostics.length;
      document.advisoryTruncated = bounded.truncated;
    }
    for (const waiter of [...document.pushWaiters]) waiter();
  }

  private async withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason ?? abortError());
          const onAbort = () => reject(signal.reason ?? abortError());
          signal.addEventListener("abort", onAbort, { once: true });
          previous.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, reject);
        });
      } else {
        await previous;
      }
    } catch (error) {
      void previous.then(release, release);
      throw error;
    }
    try {
      throwIfAborted(signal);
      if (!this.isRunning) throw new Error(`Language server '${this.definition.id}' has stopped.`);
      this.lastUsed = Date.now();
      return await operation();
    } finally {
      release();
    }
  }

  private async readDocument(path: string): Promise<{ path: string; text: string }> {
    const canonicalPath = await realpath(path);
    const text = await readBoundedText(canonicalPath, this.canonicalRoot!);
    return { path: canonicalPath, text };
  }

  private nextDocumentVersion(): number {
    return ++this.documentVersion;
  }

  private async syncDocuments(signal?: AbortSignal): Promise<void> {
    for (const document of [...this.documents.values()]) {
      throwIfAborted(signal);
      let text: string;
      try {
        text = await readBoundedText(document.path, this.canonicalRoot!);
      } catch {
        await this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
        this.documents.delete(document.uri);
        this.generation++;
        continue;
      }
      if (text !== document.text) await this.changeDocument(document, text);
    }
  }

  private async changeDocument(document: DocumentState, text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new Error(`File is larger than pi-lsp's ${MAX_REQUEST_BYTES.toLocaleString()} byte document limit.`);
    const version = this.nextDocumentVersion();
    document.version = version;
    document.text = text;
    document.report = undefined;
    document.advisory = undefined;
    document.advisoryTotal = undefined;
    document.advisoryTruncated = undefined;
    this.generation++;
    await this.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version },
      contentChanges: [{ text }],
    });
  }

  private async evictDocument(): Promise<void> {
    const limit = this.options.maxDocuments ?? MAX_OPEN_DOCUMENTS;
    if (this.documents.size < limit) return;
    const oldest = [...this.documents.values()].sort((left, right) => left.used - right.used)[0];
    if (!oldest) return;
    await this.notify("textDocument/didClose", { textDocument: { uri: oldest.uri } });
    this.documents.delete(oldest.uri);
    this.generation++;
  }

  private async openDocument(path: string, signal?: AbortSignal): Promise<DocumentState> {
    const current = await this.readDocument(path);
    const canonicalPath = current.path;
    const uri = pathToFileURL(canonicalPath).href;
    const existing = this.documents.get(uri);
    const text = current.text;
    if (existing) {
      existing.used = Date.now();
      if (existing.text !== text) await this.changeDocument(existing, text);
      return existing;
    }
    throwIfAborted(signal);
    await this.evictDocument();
    const document: DocumentState = {
      path: canonicalPath,
      uri,
      version: this.nextDocumentVersion(),
      text,
      used: Date.now(),
      pushWaiters: new Set(),
    };
    this.documents.set(uri, document);
    this.generation++;
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.languageIdForPath(canonicalPath), version: document.version, text },
    });
    return document;
  }

  private languageIdForPath(path: string): string {
    switch (extname(path).toLowerCase()) {
      case ".tsx": return "typescriptreact";
      case ".jsx": return "javascriptreact";
      case ".js":
      case ".mjs":
      case ".cjs": return "javascript";
      case ".scss": return "scss";
      case ".less": return "less";
      case ".c":
      case ".h": return "c";
      default: return this.definition.languageId;
    }
  }

  private async prepareDocument(path: string, signal?: AbortSignal): Promise<DocumentState> {
    await this.syncDocuments(signal);
    return this.openDocument(path, signal);
  }

  private async stableQuery<T>(path: string, signal: AbortSignal | undefined, query: (document: DocumentState) => Promise<T>): Promise<T> {
    return this.withLock(signal, async () => {
      let document = await this.prepareDocument(path, signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        throwIfAborted(signal);
        const version = document.version;
        const generation = this.generation;
        const result = await query(document);
        await this.syncDocuments(signal);
        document = this.documents.get(document.uri) ?? await this.openDocument(path, signal);
        if (version === document.version && generation === this.generation) return result;
      }
      throw new Error("Workspace documents changed while the language-server request was running; retry the read-only query.");
    });
  }

  private async awaitPush(document: DocumentState, version: number, signal?: AbortSignal): Promise<CachedReport | undefined> {
    if (document.report?.version === version) return document.report;
    const timeout = this.options.pushWaitMs ?? PUSH_DIAGNOSTIC_WAIT_MS;
    return new Promise<CachedReport | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (report?: CachedReport, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.pushWaiters.delete(check);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        if (error) reject(error);
        else resolve(report);
      };
      const check = () => {
        if (document.report?.version === version) finish(document.report);
      };
      const timer = setTimeout(() => finish(undefined), timeout);
      const abortListener = signal ? () => finish(undefined, signal.reason instanceof Error ? signal.reason : abortError()) : undefined;
      document.pushWaiters.add(check);
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
      check();
    });
  }

  async diagnostics(path: string, signal?: AbortSignal): Promise<DiagnosticResult> {
    return this.withLock(signal, async () => {
      const document = await this.prepareDocument(path, signal);
      // Ask for a fresh report for this acquisition, rather than reusing a cached
      // push or pull result whose dependency view may predate an unopened edit.
      await this.changeDocument(document, document.text);
      const version = document.version;
      const generation = this.generation;
      let report: CachedReport | undefined;
      let reason: string | undefined;

      if (this.pullDiagnosticsSupported) {
        try {
          const result = await this.request<PullReport | null>("textDocument/diagnostic", {
            textDocument: { uri: document.uri },
          }, signal);
          if (result === null) {
            reason = "The language server returned null for the pull-diagnostics request; the result is unknown.";
          } else if (isRecord(result) && result.kind === "full" && validDiagnostics(result.items)) {
            report = {
              version,
              diagnostics: result.items.slice(0, MAX_CACHED_DIAGNOSTICS),
              total: result.items.length,
              truncated: result.items.length > MAX_CACHED_DIAGNOSTICS,
              ...(typeof result.resultId === "string" ? { resultId: result.resultId } : {}),
              source: "pull",
            };
            document.report = report;
          } else if (isRecord(result) && result.kind === "unchanged") {
            reason = "The server returned unchanged diagnostics without a requested previous result ID; freshness is unknown.";
          } else {
            reason = "The language server returned an invalid pull-diagnostics report; the result is unknown.";
          }
        } catch (error) {
          if (signal?.aborted || !this.isRunning) throw error;
          reason = `${isUnsupported(error) ? "The advertised pull-diagnostics method is unsupported" : "Pull diagnostics failed"}: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        report = await this.awaitPush(document, version, signal);
        if (!report) reason = "No version-matched push diagnostic report arrived before the bounded wait expired.";
      }

      await this.syncDocuments(signal);
      if (!this.isRunning) throw new Error("Language server exited while collecting diagnostics.");
      const current = this.documents.get(document.uri);
      if (!current || current.version !== version || this.generation !== generation) {
        return { status: "unknown", diagnostics: [], reason: "The document changed while diagnostics were being collected; the result is unknown.", version: current?.version ?? version };
      }
      if (!report) {
        const advisory = current.advisory?.slice(0, MAX_CACHED_DIAGNOSTICS) ?? [];
        return {
          status: "unknown",
          diagnostics: advisory,
          ...(current.advisoryTotal === undefined ? {} : { total: current.advisoryTotal }),
          ...(current.advisoryTruncated ? { truncated: true } : {}),
          ...(advisory.length ? { advisory: true } : {}),
          reason: `${reason ?? "No valid diagnostic report is available."}${advisory.length ? " Unversioned diagnostics are advisory only." : ""}`,
          version,
        };
      }
      return {
        status: report.total ? "findings" : "clean",
        diagnostics: report.diagnostics,
        total: report.total,
        truncated: report.truncated,
        version,
        source: report.source,
      };
    });
  }

  async hover(path: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    return this.stableQuery(path, signal, (document) => this.request("textDocument/hover", {
      textDocument: { uri: document.uri }, position: { line, character },
    }, signal));
  }

  async getDefinition(path: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    return this.stableQuery(path, signal, (document) => this.request("textDocument/definition", {
      textDocument: { uri: document.uri }, position: { line, character },
    }, signal));
  }

  async references(path: string, line: number, character: number, includeDeclaration: boolean, signal?: AbortSignal): Promise<unknown> {
    return this.stableQuery(path, signal, (document) => this.request("textDocument/references", {
      textDocument: { uri: document.uri },
      position: { line, character },
      context: { includeDeclaration },
    }, signal));
  }

  async documentSymbols(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.stableQuery(path, signal, (document) => this.request("textDocument/documentSymbol", {
      textDocument: { uri: document.uri },
    }, signal));
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<unknown> {
    return this.withLock(signal, async () => {
      await this.syncDocuments(signal);
      const generation = this.generation;
      const result = await this.request("workspace/symbol", { query }, signal);
      await this.syncDocuments(signal);
      if (generation !== this.generation) {
        const retryGeneration = this.generation;
        const retried = await this.request("workspace/symbol", { query }, signal);
        await this.syncDocuments(signal);
        if (retryGeneration !== this.generation) throw new Error("Workspace documents changed repeatedly during symbol search.");
        return retried;
      }
      return result;
    });
  }

  getServerCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopImpl();
    return this.stopPromise;
  }

  private async stopImpl(): Promise<void> {
    const child = this.process;
    const connection = this.connection;
    const pid = child?.pid;
    if (connection && this.initialized && child?.exitCode === null && !this.connectionClosed) {
      try { await this.request("shutdown", null, undefined, 1_000); } catch { /* still terminate below */ }
      try { await connection.sendNotification("exit"); } catch { /* transport may already be closed */ }
      if (pid !== undefined) await waitForProcessTreeExit(pid, 300);
    }
    this.initialized = false;
    this.pullDiagnosticsSupported = false;
    this.documents.clear();
    this.generation++;
    try { connection?.dispose(); } catch { /* already disposed */ }
    this.connection = undefined;
    // Even a successfully exited launcher may have left descendants in its group.
    if (pid === undefined || !processTreeExists(pid)) return;
    signalProcessTree(pid, "SIGTERM");
    if (!(await waitForProcessTreeExit(pid, 400))) {
      signalProcessTree(pid, "SIGKILL");
      await waitForProcessTreeExit(pid, 300);
    }
  }
}
