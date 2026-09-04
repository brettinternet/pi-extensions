import path from "node:path";

export const PROTOCOL_VERSION = 1 as const;
export const DOCKER_CONTEXT = "colima" as const;
export const IMAGE_TAG = "pi-colima-sandbox:node-22.19.0-bookworm-v2" as const;
export const GUEST_WORKSPACE = "/workspace" as const;
export const GUEST_HOME = "/home/node" as const;
export const BROKER_PATH = "/usr/local/bin/pi-colima-sandbox-broker" as const;

export const GUEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  HOME: GUEST_HOME,
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  NPM_CONFIG_USERCONFIG: "/dev/null",
});

export type BrokerOperation =
  | "ping"
  | "exists"
  | "access"
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "stat"
  | "readdir"
  | "find"
  | "grep"
  | "exec";

export interface BrokerRequest {
  version: typeof PROTOCOL_VERSION;
  id: string;
  op: BrokerOperation | "cancel";
  payload?: unknown;
  target?: string;
}

export interface BrokerDataResponse {
  version: typeof PROTOCOL_VERSION;
  id: string;
  type: "data";
  data: string;
}

export interface BrokerResultResponse<T = unknown> {
  version: typeof PROTOCOL_VERSION;
  id: string;
  type: "result";
  ok: true;
  result: T;
}

export interface BrokerErrorResponse {
  version: typeof PROTOCOL_VERSION;
  id: string;
  type: "result";
  ok: false;
  error: string;
}

export type BrokerResponse<T = unknown> =
  | BrokerDataResponse
  | BrokerResultResponse<T>
  | BrokerErrorResponse;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeBrokerRequest(request: BrokerRequest): string {
  if (!isValidBrokerRequest(request)) {
    throw new Error("Invalid sandbox broker request");
  }
  return `${JSON.stringify(request)}\n`;
}

export function isValidBrokerRequest(value: unknown): value is BrokerRequest {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return false;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return false;
  if (value.op === "cancel") {
    return typeof value.target === "string" && ID_PATTERN.test(value.target);
  }
  return (
    typeof value.op === "string" &&
    [
      "ping",
      "exists",
      "access",
      "readFile",
      "writeFile",
      "mkdir",
      "stat",
      "readdir",
      "find",
      "grep",
      "exec",
    ].includes(value.op)
  );
}

export function parseBrokerResponse(line: string): BrokerResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Sandbox broker returned invalid JSON");
  }
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    throw new Error("Sandbox broker protocol version mismatch");
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error("Sandbox broker returned an invalid request id");
  }
  if (value.type === "data") {
    if (typeof value.data !== "string" || !BASE64_PATTERN.test(value.data)) {
      throw new Error("Sandbox broker returned invalid data");
    }
    return {
      version: PROTOCOL_VERSION,
      id: value.id,
      type: "data",
      data: value.data,
    };
  }
  if (value.type === "result") {
    if (value.ok === true && "result" in value) {
      return {
        version: PROTOCOL_VERSION,
        id: value.id,
        type: "result",
        ok: true,
        result: value.result,
      };
    }
    if (value.ok === false && typeof value.error === "string") {
      return {
        version: PROTOCOL_VERSION,
        id: value.id,
        type: "result",
        ok: false,
        error: value.error,
      };
    }
  }
  throw new Error("Sandbox broker returned an invalid response");
}

/**
 * Resolve a Pi tool path in the guest namespace. Host paths are deliberately
 * not translated: the broker rejects every absolute path outside /workspace.
 */
export function resolveGuestPath(input: string, cwd: string = GUEST_WORKSPACE): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new Error("Invalid sandbox path");
  }
  const withoutAt = input.startsWith("@") ? input.slice(1) : input;
  const base = cwd === GUEST_WORKSPACE ? GUEST_WORKSPACE : assertGuestPath(cwd);
  const resolved = path.posix.isAbsolute(withoutAt)
    ? path.posix.normalize(withoutAt)
    : path.posix.resolve(base, withoutAt);
  return assertGuestPath(resolved);
}

export function assertGuestPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !path.posix.isAbsolute(value)
  ) {
    throw new Error("Invalid sandbox path");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new Error("Non-canonical sandbox path");
  if (value !== GUEST_WORKSPACE && !value.startsWith(`${GUEST_WORKSPACE}/`)) {
    throw new Error("Sandbox path is outside /workspace");
  }
  return value;
}

export function sanitizeGuestEnv(_env?: NodeJS.ProcessEnv): Record<string, string> {
  // Never forward values from the host. The allowlist is intentionally fixed
  // so a future Pi environment variable cannot become a guest credential.
  return { ...GUEST_ENV };
}

export function isBase64(value: string): boolean {
  return BASE64_PATTERN.test(value);
}