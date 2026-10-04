// Host side of pi-subagents' existing pi-web registry protocol. No package import.
const registryKey = Symbol.for("@agegr/pi-web/session-liveness/v1");
const bridgeKey = Symbol.for("pi-loop.session-liveness-registry.v1");

type Provider = { name: string; sessionId: string; isActive(): boolean };
type Registry = { version: 1; register(provider: Provider): () => void };
type Bridge = { registry: Registry; providers: Set<{ provider: Provider }> };
const globals = globalThis as Record<symbol, unknown>;

/** Install before session_start, forwarding registrations to an existing host. */
export function installSessionLivenessRegistry(): (sessionId: string) => boolean | undefined {
  let bridge = globals[bridgeKey] as Bridge | undefined;
  if (!bridge || globals[registryKey] !== bridge.registry) {
    const existing = globals[registryKey] as Registry | undefined;
    if (existing !== undefined && (!existing || existing.version !== 1 || typeof existing.register !== "function")) {
      return () => undefined;
    }
    const registry: Registry = existing ?? { version: 1, register: () => () => {} };
    const downstream = registry.register.bind(registry);
    const providers: Bridge["providers"] = new Set();
    try {
      registry.register = (provider) => {
        const entry = { provider };
        const release = downstream(provider);
        providers.add(entry);
        return () => {
          if (!providers.delete(entry)) return;
          release();
        };
      };
    } catch {
      // A read-only host registry cannot be observed safely. Do not replace it.
      return () => undefined;
    }
    bridge = { registry, providers };
    globals[registryKey] = registry;
    globals[bridgeKey] = bridge;
  }
  const installed = bridge;
  return (sessionId) => {
    if (globals[registryKey] !== installed.registry) return undefined;
    const matching = [...installed.providers].filter(({ provider }) => provider.name === "pi-subagents" && provider.sessionId === sessionId);
    if (!matching.length) return undefined;
    try {
      // UUID identity is exact; session-file paths are not interchangeable here.
      return matching.some(({ provider }) => provider.isActive() !== false);
    } catch {
      return true;
    }
  };
}
