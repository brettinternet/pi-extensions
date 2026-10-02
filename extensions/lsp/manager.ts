import { LspClient } from "./client.ts";
import type { ServerDefinition } from "./servers.ts";

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_REAPER_MS = 30_000;
const DEFAULT_MAX_CLIENTS = 16;
const DEFAULT_MAX_PER_ROOT = 4;

interface ManagedClient {
  key: string;
  root: string;
  serverId: string;
  client: LspClient;
  starting: Promise<void>;
  active: number;
  pendingWaiters: number;
  lastUsed: number;
  startupController: AbortController;
  startingSettled: boolean;
}

export interface ClientManagerOptions {
  idleMs?: number;
  reaperMs?: number;
  maxClients?: number;
  maxPerRoot?: number;
  now?: () => number;
  clientFactory?: (root: string, definition: ServerDefinition, command: string[]) => LspClient;
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export class LspClientManager {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly retiring = new Set<Promise<void>>();
  private creationQueue: Promise<void> = Promise.resolve();
  private readonly idleMs: number;
  private readonly reaperMs: number;
  private readonly maxClients: number;
  private readonly maxPerRoot: number;
  private readonly now: () => number;
  private readonly factory: NonNullable<ClientManagerOptions["clientFactory"]>;
  private reaper?: ReturnType<typeof setInterval>;
  private disposed = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: ClientManagerOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.reaperMs = options.reaperMs ?? DEFAULT_REAPER_MS;
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.maxPerRoot = options.maxPerRoot ?? DEFAULT_MAX_PER_ROOT;
    this.now = options.now ?? Date.now;
    this.factory = options.clientFactory ?? ((root, definition, command) => new LspClient(root, definition, command));
  }

  get size(): number {
    return this.clients.size;
  }

  getStatus(): Array<{ root: string; serverId: string; starting: boolean; running: boolean }> {
    return [...this.clients.values()].map((entry) => ({
      root: entry.root,
      serverId: entry.serverId,
      starting: !entry.startingSettled,
      running: entry.client.isRunning,
    }));
  }

  private key(root: string, serverId: string): string {
    return `${root}\0${serverId}`;
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => { void this.reapIdle(); }, this.reaperMs);
    this.reaper.unref?.();
  }

  private async reapIdle(): Promise<void> {
    const now = this.now();
    const stale = [...this.clients.values()].filter((entry) =>
      entry.active === 0 && entry.pendingWaiters === 0 && entry.startingSettled && now - entry.lastUsed >= this.idleMs
    );
    await Promise.all(stale.map((entry) => this.remove(entry)));
  }

  private async makeRoom(root: string): Promise<void> {
    const rootEntries = () => [...this.clients.values()].filter((entry) => entry.root === root);
    while (this.clients.size >= this.maxClients || rootEntries().length >= this.maxPerRoot) {
      const candidates = [...this.clients.values()]
        .filter((entry) => entry.active === 0 && entry.pendingWaiters === 0 && entry.startingSettled &&
          (rootEntries().length < this.maxPerRoot || entry.root === root))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const candidate = candidates[0];
      if (!candidate) {
        throw new Error(`pi-lsp client capacity reached (maximum ${this.maxPerRoot} language servers per root, ${this.maxClients} total); retry after an idle server is released.`);
      }
      await this.remove(candidate);
    }
  }

  private async create(root: string, definition: ServerDefinition, command: string[]): Promise<ManagedClient> {
    if (this.disposed) throw new Error("pi-lsp is shutting down.");
    const previousCreation = this.creationQueue;
    let release!: () => void;
    this.creationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previousCreation;
    try {
      if (this.disposed) throw new Error("pi-lsp is shutting down.");
      const key = this.key(root, definition.id);
      const existing = this.clients.get(key);
      if (existing) return existing;
      this.startReaper();
      await this.makeRoom(root);
      if (this.disposed) throw new Error("pi-lsp is shutting down.");
      const client = this.factory(root, definition, command);
      const startupController = new AbortController();
      let entry!: ManagedClient;
      const starting = client.start(startupController.signal).then(() => {
        if (this.disposed) throw new Error("pi-lsp shut down while the language server was starting.");
      }).catch(async (error) => {
        await client.stop();
        if (this.clients.get(key) === entry) this.clients.delete(key);
        throw error;
      });
      entry = {
        key,
        root,
        serverId: definition.id,
        client,
        starting,
        active: 0,
        pendingWaiters: 0,
        lastUsed: this.now(),
        startupController,
        startingSettled: false,
      };
      this.clients.set(key, entry);
      starting.then(
        () => { entry.startingSettled = true; entry.lastUsed = this.now(); },
        () => { entry.startingSettled = true; },
      );
      return entry;
    } finally {
      release();
    }
  }

  private async get(root: string, definition: ServerDefinition, command: string[], signal?: AbortSignal): Promise<ManagedClient> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    if (this.disposed) throw new Error("pi-lsp is shutting down.");
    const key = this.key(root, definition.id);
    let entry = this.clients.get(key);
    if (entry && !entry.client.isRunning && entry.startingSettled) {
      await this.remove(entry);
      entry = undefined;
    }
    if (!entry) entry = await this.create(root, definition, command);
    entry.pendingWaiters++;
    let failed = false;
    let failure: unknown;
    try {
      await waitWithSignal(entry.starting, signal);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
      if (this.disposed) throw new Error("pi-lsp is shutting down.");
      entry.lastUsed = this.now();
      entry.active++;
      return entry;
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      entry.pendingWaiters--;
      if (failed && entry.pendingWaiters === 0 && entry.active === 0 && !entry.startingSettled) {
        entry.startupController.abort(failure);
        void this.remove(entry);
      }
    }
  }

  async run<T>(
    root: string,
    definition: ServerDefinition,
    command: string[],
    signal: AbortSignal | undefined,
    operation: (client: LspClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = await this.get(root, definition, command, signal);
      try {
        if (!entry.client.isRunning) throw new Error(`Language server '${entry.serverId}' exited before the request.`);
        return await operation(entry.client);
      } catch (error) {
        if (signal?.aborted || attempt > 0 || entry.client.isRunning) throw error;
        await this.remove(entry);
      } finally {
        entry.active = Math.max(0, entry.active - 1);
        entry.lastUsed = this.now();
      }
    }
    throw new Error("Unreachable language server retry state.");
  }

  private remove(entry: ManagedClient): Promise<void> {
    if (this.clients.get(entry.key) === entry) this.clients.delete(entry.key);
    const retirement = (async () => {
      try { await entry.starting; } catch { /* failed startup still requires idempotent stop */ }
      await entry.client.stop();
    })();
    this.retiring.add(retirement);
    retirement.then(() => this.retiring.delete(retirement), () => this.retiring.delete(retirement));
    return retirement;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    this.shutdownPromise = (async () => {
      await this.creationQueue;
      await Promise.all([...this.clients.values()].map((entry) => this.remove(entry)));
      await Promise.all([...this.retiring]);
    })();
    return this.shutdownPromise;
  }
}
