import { afterEach, expect, test } from "bun:test";
import { installSessionLivenessRegistry } from "../../extensions/loop/session-liveness.ts";

const key = Symbol.for("@agegr/pi-web/session-liveness/v1");
const globals = globalThis as Record<symbol, any>;
const original = globals[key];
afterEach(() => {
  if (original === undefined) delete globals[key];
  else globals[key] = original;
});

function fresh() {
  delete globals[key];
  const query = installSessionLivenessRegistry();
  return { query, registry: globals[key] };
}

test("registry survives consumer reload and distinguishes UUIDs from file paths", () => {
  const { query, registry } = fresh();
  const release = registry.register({ name: "pi-subagents", sessionId: "uuid", sessionFile: "/tmp/session.jsonl", isActive: () => true });
  expect(query("uuid")).toBe(true);
  expect(query("/tmp/session.jsonl")).toBeUndefined();
  expect(installSessionLivenessRegistry()("uuid")).toBe(true);
  release();
  expect(query("uuid")).toBeUndefined();
});

test("forwards host registration and releases each registration exactly once", () => {
  let registrations = 0;
  let releases = 0;
  const host = { version: 1, register() { expect(this).toBe(host); registrations++; return () => { releases++; }; } };
  globals[key] = host;
  const query = installSessionLivenessRegistry();
  const idle = (host.register as any)({ name: "pi-subagents", sessionId: "uuid", isActive: () => false });
  const busy = (host.register as any)({ name: "pi-subagents", sessionId: "uuid", isActive: () => true });
  expect(globals[key]).toBe(host);
  expect(registrations).toBe(2);
  expect(query("uuid")).toBe(true);
  busy(); busy();
  expect(query("uuid")).toBe(false);
  expect(releases).toBe(1);
  idle();
  expect(query("uuid")).toBeUndefined();
  expect(releases).toBe(2);
});

test("throwing providers stay busy and a replaced registry becomes unavailable", () => {
  const { query, registry } = fresh();
  registry.register({ name: "pi-subagents", sessionId: "uuid", isActive() { throw new Error("unavailable"); } });
  expect(query("uuid")).toBe(true);
  globals[key] = { version: 2 };
  expect(query("uuid")).toBeUndefined();
  expect(installSessionLivenessRegistry()("uuid")).toBeUndefined();
});

test("does not replace a read-only host registry", () => {
  const host = Object.freeze({ version: 1, register: () => () => {} });
  globals[key] = host;
  expect(installSessionLivenessRegistry()("uuid")).toBeUndefined();
  expect(globals[key]).toBe(host);
});
