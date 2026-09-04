#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 1;
const WORKSPACE = "/workspace";
const GUEST_HOME = "/home/node";
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 10_000;
const GREP_MAX_LINE_LENGTH = 500;
const BASE_ENV = Object.freeze({
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

const running = new Map();
let shuttingDown = false;

class BrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestError(message) {
  throw new BrokerError(message, "EINVAL");
}

function validateId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    requestError("invalid request id");
  }
}

function validatePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !path.posix.isAbsolute(value)
  ) {
    requestError("invalid sandbox path");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) requestError("non-canonical sandbox path");
  if (value !== WORKSPACE && !value.startsWith(`${WORKSPACE}/`)) {
    throw new BrokerError("sandbox path is outside /workspace", "EBOUNDARY");
  }
  return value;
}

function assertInsideWorkspace(value) {
  if (value !== WORKSPACE && !value.startsWith(`${WORKSPACE}/`)) {
    throw new BrokerError("resolved path is outside /workspace", "EBOUNDARY");
  }
}

async function existingPath(value) {
  const safe = validatePath(value);
  let resolved;
  try {
    resolved = await realpath(safe);
  } catch (error) {
    throw new BrokerError(`path does not exist: ${safe}`, error?.code || "ENOENT");
  }
  assertInsideWorkspace(resolved);
  return safe;
}

async function safeWritePath(value) {
  const safe = validatePath(value);
  let probe = safe;
  for (;;) {
    try {
      const resolved = await realpath(probe);
      assertInsideWorkspace(resolved);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.posix.dirname(probe);
      if (parent === probe) throw new BrokerError("workspace parent does not exist", "ENOENT");
      probe = parent;
    }
  }
  return safe;
}

function payloadRecord(request) {
  if (!isRecord(request.payload)) requestError(`invalid payload for ${request.op}`);
  return request.payload;
}

function stringValue(payload, key, maxLength = 4096) {
  const value = payload[key];
  if (typeof value !== "string" || value.length > maxLength) requestError(`invalid ${key}`);
  return value;
}

function positiveLimit(value) {
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    requestError("invalid search limit");
  }
  return Math.min(value, MAX_SEARCH_RESULTS);
}

function send(value) {
  if (shuttingDown) return;
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new BrokerError("broker response is too large", "E2BIG");
  }
  process.stdout.write(line);
}

function sendResult(id, result) {
  send({ version: PROTOCOL_VERSION, id, type: "result", ok: true, result });
}

function sendError(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ version: PROTOCOL_VERSION, id, type: "result", ok: false, error: message });
}

function killTree(child) {
  if (!child || child.killed) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the process has already exited or has no group.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The close event will settle the operation.
  }
}

function validateCommandEnvironment(value) {
  if (!isRecord(value)) requestError("invalid command environment");
  for (const [key, envValue] of Object.entries(value)) {
    if (!(key in BASE_ENV) || typeof envValue !== "string" || envValue !== BASE_ENV[key]) {
      throw new BrokerError("command environment is not the sandbox allowlist", "EBOUNDARY");
    }
  }
  return { ...BASE_ENV };
}

function startTrackedProcess(id, executable, args, cwd, onStdout, options = {}) {
  const child = spawn(executable, args, {
    cwd,
    env: BASE_ENV,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    child,
    cancelled: false,
    timedOut: false,
    overflow: false,
    limitReached: false,
    timer: undefined,
  };
  running.set(id, state);
  let stdoutBuffer = "";
  let outputBytes = 0;
  let stderr = "";
  let settled = false;

  const finish = (fn) => {
    if (settled) return;
    settled = true;
    running.delete(id);
    if (state.timer) clearTimeout(state.timer);
    fn();
  };
  const onChunk = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CONTENT_BYTES) {
      state.overflow = true;
      killTree(child);
      return;
    }
    if (options.rawStdout) {
      options.onChunk?.(chunk, state, () => killTree(child));
      return;
    }
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      onStdout(line, state, () => killTree(child));
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    if (options.rawStderr) options.onStderr?.(chunk, state);
  });
  child.on("error", (error) => finish(() => options.onError(error)));
  child.on("close", (code) => {
    if (!options.rawStdout && stdoutBuffer.length > 0 && !state.overflow) onStdout(stdoutBuffer, state, () => killTree(child));
    finish(() => options.onClose({ code, stderr, state }));
  });
  if (options.timeout && options.timeout > 0) {
    state.timer = setTimeout(() => {
      state.timedOut = true;
      killTree(child);
    }, options.timeout * 1000);
  }
  return state;
}

async function executeCommand(id, payload) {
  const command = stringValue(payload, "command", MAX_COMMAND_BYTES);
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) requestError("command is too large");
  const cwd = await existingPath(stringValue(payload, "cwd"));
  if (!(await stat(cwd)).isDirectory()) throw new BrokerError("command cwd is not a directory", "ENOTDIR");
  validateCommandEnvironment(payload.env);
  let timeout;
  if (payload.timeout !== undefined) {
    if (typeof payload.timeout !== "number" || !Number.isFinite(payload.timeout) || payload.timeout <= 0 || payload.timeout > 3600) {
      requestError("invalid command timeout");
    }
    timeout = payload.timeout;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const state = startTrackedProcess(
      id,
      "/bin/bash",
      ["-lc", command],
      cwd,
      () => {},
      {
        rawStdout: true,
        rawStderr: true,
        timeout,
        onChunk: (chunk, currentState) => {
          if (shuttingDown || currentState.cancelled) return;
          try {
            send({ version: PROTOCOL_VERSION, id, type: "data", data: chunk.toString("base64") });
          } catch (error) {
            currentState.cancelled = true;
            killTree(currentState.child);
            rejectPromise(error);
          }
        },
        onStderr: (chunk, currentState) => {
          if (shuttingDown || currentState.cancelled) return;
          try {
            send({ version: PROTOCOL_VERSION, id, type: "data", data: chunk.toString("base64") });
          } catch (error) {
            currentState.cancelled = true;
            killTree(currentState.child);
            rejectPromise(error);
          }
        },
        onError: rejectPromise,
        onClose: ({ code, state: finalState }) => {
          if (finalState.cancelled) {
            rejectPromise(new BrokerError("aborted", "ECANCELED"));
          } else if (finalState.timedOut) {
            rejectPromise(new BrokerError(`timeout:${timeout}`, "ETIMEDOUT"));
          } else if (finalState.overflow) {
            rejectPromise(new BrokerError("command output is too large", "E2BIG"));
          } else {
            resolvePromise({ exitCode: code });
          }
        },
      },
    );
    void state;
  });
}

async function executeFind(id, payload) {
  const pattern = stringValue(payload, "pattern", 4096);
  const root = await existingPath(stringValue(payload, "path"));
  const rootStat = await stat(root);
  const limit = positiveLimit(payload.limit);
  const args = [
    "--files",
    "--hidden",
    "--color=never",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    pattern,
    "--",
    root,
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const paths = [];
    const state = startTrackedProcess(
      id,
      "/usr/bin/rg",
      args,
      rootStat.isDirectory() ? root : WORKSPACE,
      (line, currentState, stop) => {
        if (!line || paths.length >= limit) return;
        const candidate = path.posix.isAbsolute(line) ? path.posix.normalize(line) : path.posix.resolve(root, line);
        try {
          validatePath(candidate);
        } catch {
          currentState.overflow = true;
          stop();
          return;
        }
        paths.push(candidate);
        if (paths.length >= limit) {
          currentState.limitReached = true;
          stop();
        }
      },
      {
        onError: rejectPromise,
        onClose: ({ code, stderr, state: finalState }) => {
          if (finalState.cancelled) return rejectPromise(new BrokerError("aborted", "ECANCELED"));
          if (finalState.overflow) return rejectPromise(new BrokerError("find output was invalid or too large", "E2BIG"));
          if (code !== 0 && code !== 1 && !finalState.limitReached) {
            return rejectPromise(new BrokerError(stderr.trim() || `ripgrep exited with code ${code}`, "ESEARCH"));
          }
          resolvePromise({ paths });
        },
      },
    );
    // The returned state is intentionally retained by running for cancellation.
    void state;
  });
}

function truncateLine(line) {
  if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, truncated: false };
  return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, truncated: true };
}

function appendGrepBlock(output, lines, displayPath, lineIndex, context) {
  const start = context > 0 ? Math.max(0, lineIndex - context) : lineIndex;
  const end = context > 0 ? Math.min(lines.length - 1, lineIndex + context) : lineIndex;
  let truncated = false;
  for (let index = start; index <= end; index++) {
    const selected = truncateLine((lines[index] || "").replace(/\r/g, ""));
    truncated ||= selected.truncated;
    const separator = index === lineIndex ? ":" : "-";
    output.push(`${displayPath}${separator}${index + 1}${separator} ${selected.text}`);
  }
  return truncated;
}

async function executeGrep(id, payload) {
  const pattern = stringValue(payload, "pattern", 4096);
  const root = await existingPath(stringValue(payload, "path"));
  const rootStat = await stat(root);
  const ignoreCase = payload.ignoreCase === true;
  const literal = payload.literal === true;
  const glob = payload.glob;
  if (glob !== undefined && (typeof glob !== "string" || glob.length > 4096)) requestError("invalid glob");
  const context = payload.context === undefined ? 0 : payload.context;
  if (typeof context !== "number" || !Number.isInteger(context) || context < 0 || context > 100) requestError("invalid context");
  const limit = positiveLimit(payload.limit);
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (ignoreCase) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (glob !== undefined) args.push("--glob", glob);
  args.push("--glob", "!.git/**", "--glob", "!node_modules/**", "--", pattern, root);

  return new Promise((resolvePromise, rejectPromise) => {
    const matches = [];
    const state = startTrackedProcess(
      id,
      "/usr/bin/rg",
      args,
      rootStat.isDirectory() ? root : WORKSPACE,
      (line, currentState, stop) => {
        if (matches.length >= limit) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.type !== "match") return;
        const rawPath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (typeof rawPath !== "string" || typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || typeof lineText !== "string") return;
        const candidate = path.posix.isAbsolute(rawPath) ? path.posix.normalize(rawPath) : path.posix.resolve(root, rawPath);
        try {
          validatePath(candidate);
        } catch {
          currentState.overflow = true;
          stop();
          return;
        }
        matches.push({ path: candidate, line: lineNumber, text: lineText.replace(/\r?\n$/, "") });
        if (matches.length >= limit) {
          currentState.limitReached = true;
          stop();
        }
      },
      {
        onError: rejectPromise,
        onClose: async ({ code, stderr, state: finalState }) => {
          if (finalState.cancelled) return rejectPromise(new BrokerError("aborted", "ECANCELED"));
          if (finalState.overflow) return rejectPromise(new BrokerError("grep output was invalid or too large", "E2BIG"));
          if (code !== 0 && code !== 1 && !finalState.limitReached) {
            return rejectPromise(new BrokerError(stderr.trim() || `ripgrep exited with code ${code}`, "ESEARCH"));
          }
          if (matches.length === 0) return resolvePromise({ output: "" });

          const output = [];
          let linesTruncated = false;
          for (const match of matches) {
            const matchFile = await existingPath(match.path);
            const displayPath = rootStat.isDirectory()
              ? path.posix.relative(root, matchFile) || path.posix.basename(matchFile)
              : path.posix.basename(matchFile);
            if (context === 0) {
              const selected = truncateLine(match.text);
              linesTruncated ||= selected.truncated;
              output.push(`${displayPath}:${match.line}: ${selected.text}`);
            } else {
              let content;
              try {
                content = (await readFile(matchFile, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
              } catch {
                output.push(`${displayPath}:${match.line}: (unable to read file)`);
                continue;
              }
              linesTruncated ||= appendGrepBlock(output, content.split("\n"), displayPath, match.line - 1, context);
            }
          }
          resolvePromise({
            output: output.join("\n"),
            matchLimitReached: finalState.limitReached,
            linesTruncated,
          });
        },
      },
    );
    void state;
  });
}

async function execute(request) {
  switch (request.op) {
    case "ping":
      return { protocol: PROTOCOL_VERSION, workspace: WORKSPACE };
    case "exists": {
      const payload = payloadRecord(request);
      const value = stringValue(payload, "path");
      try {
        await existingPath(value);
        return { exists: true };
      } catch (error) {
        if (error?.code === "ENOENT") return { exists: false };
        throw error;
      }
    }
    case "access": {
      const payload = payloadRecord(request);
      const value = await existingPath(stringValue(payload, "path"));
      const mode = payload.mode;
      if (mode !== "read" && mode !== "readwrite") requestError("invalid access mode");
      await access(value, mode === "read" ? constants.R_OK : constants.R_OK | constants.W_OK);
      return {};
    }
    case "readFile": {
      const payload = payloadRecord(request);
      const value = await existingPath(stringValue(payload, "path"));
      const data = await readFile(value);
      if (data.byteLength > MAX_CONTENT_BYTES) throw new BrokerError("file is too large", "E2BIG");
      return { data: data.toString("base64") };
    }
    case "writeFile": {
      const payload = payloadRecord(request);
      const value = await safeWritePath(stringValue(payload, "path"));
      const content = stringValue(payload, "content", MAX_CONTENT_BYTES);
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new BrokerError("file content is too large", "E2BIG");
      await writeFile(value, content, { encoding: "utf8" });
      return {};
    }
    case "mkdir": {
      const payload = payloadRecord(request);
      const value = await safeWritePath(stringValue(payload, "path"));
      await mkdir(value, { recursive: true });
      return {};
    }
    case "stat": {
      const payload = payloadRecord(request);
      const value = await existingPath(stringValue(payload, "path"));
      const result = await stat(value);
      return { isDirectory: result.isDirectory() };
    }
    case "readdir": {
      const payload = payloadRecord(request);
      const value = await existingPath(stringValue(payload, "path"));
      const result = await stat(value);
      if (!result.isDirectory()) throw new BrokerError("path is not a directory", "ENOTDIR");
      return { entries: (await readdir(value)).sort() };
    }
    case "find":
      return executeFind(request.id, payloadRecord(request));
    case "grep":
      return executeGrep(request.id, payloadRecord(request));
    case "exec":
      return executeCommand(request.id, payloadRecord(request));
    default:
      requestError(`unsupported broker operation: ${request.op}`);
  }
}

async function handleRequest(request) {
  if (!isRecord(request) || request.version !== PROTOCOL_VERSION) {
    throw new BrokerError("sandbox broker protocol version mismatch", "EPROTO");
  }
  validateId(request.id);
  if (request.op === "cancel") {
    validateId(request.target);
    const operation = running.get(request.target);
    if (operation) {
      operation.cancelled = true;
      killTree(operation.child);
    }
    return;
  }
  if (typeof request.op !== "string") requestError("invalid broker operation");
  const result = await execute(request);
  sendResult(request.id, result);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    process.stderr.write("sandbox broker request is too large\n");
    process.exitCode = 1;
    input.close();
    return;
  }
  void (async () => {
    let request;
    try {
      request = JSON.parse(line);
      await handleRequest(request);
    } catch (error) {
      const id = isRecord(request) && typeof request.id === "string" ? request.id : "invalid";
      try {
        sendError(id, error);
      } catch {
        process.exitCode = 1;
        input.close();
      }
    }
  })();
});

input.on("close", () => {
  shuttingDown = true;
  for (const operation of running.values()) {
    operation.cancelled = true;
    killTree(operation.child);
  }
  setTimeout(() => process.exit(0), 25).unref();
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => {
    shuttingDown = true;
    for (const operation of running.values()) {
      operation.cancelled = true;
      killTree(operation.child);
    }
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  });
}