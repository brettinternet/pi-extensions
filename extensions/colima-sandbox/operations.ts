import path from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepToolDetails,
  GrepToolInput,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { BrokerClient } from "./broker-client.ts";
import {
  GUEST_WORKSPACE,
  assertGuestPath,
  resolveGuestPath,
  sanitizeGuestEnv,
} from "./protocol.ts";

export interface GuestExecResult {
  exitCode: number | null;
}

export interface GuestFindResult {
  paths: string[];
}

export interface GuestGrepResult {
  output: string;
  matchLimitReached?: boolean;
  linesTruncated?: boolean;
}

type BrokerGetter = () => BrokerClient;

function guestPath(value: string): string {
  return assertGuestPath(value);
}

async function guestExists(broker: BrokerClient, value: string): Promise<boolean> {
  const result = await broker.request<{ exists: boolean }>("exists", { path: guestPath(value) });
  if (typeof result.exists !== "boolean") throw new Error("sandbox broker returned an invalid exists result");
  return result.exists;
}

export function createSandboxReadOperations(getBroker: BrokerGetter): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const result = await getBroker().request<{ data: string }>("readFile", { path: guestPath(absolutePath) });
      if (typeof result.data !== "string") throw new Error("sandbox broker returned invalid file data");
      return Buffer.from(result.data, "base64");
    },
    access: async (absolutePath) => {
      await getBroker().request("access", { path: guestPath(absolutePath), mode: "read" });
    },
    detectImageMimeType: async (absolutePath) => {
      const value = guestPath(absolutePath);
      const extension = path.posix.extname(value).toLowerCase();
      if (extension === ".png") return "image/png";
      if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
      if (extension === ".gif") return "image/gif";
      if (extension === ".webp") return "image/webp";
      if (extension === ".bmp") return "image/bmp";
      return null;
    },
  };
}

export function createSandboxWriteOperations(getBroker: BrokerGetter): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      await getBroker().request("writeFile", { path: guestPath(absolutePath), content });
    },
    mkdir: async (absolutePath) => {
      await getBroker().request("mkdir", { path: guestPath(absolutePath) });
    },
  };
}

export function createSandboxEditOperations(getBroker: BrokerGetter): EditOperations {
  const read = createSandboxReadOperations(getBroker);
  const write = createSandboxWriteOperations(getBroker);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (absolutePath) => {
      await getBroker().request("access", { path: guestPath(absolutePath), mode: "readwrite" });
    },
  };
}

export function createSandboxLsOperations(getBroker: BrokerGetter): LsOperations {
  return {
    exists: (absolutePath) => guestExists(getBroker(), absolutePath),
    stat: async (absolutePath) => {
      const result = await getBroker().request<{ isDirectory: boolean }>("stat", { path: guestPath(absolutePath) });
      if (typeof result.isDirectory !== "boolean") throw new Error("sandbox broker returned invalid stat data");
      return { isDirectory: () => result.isDirectory };
    },
    readdir: async (absolutePath) => {
      const result = await getBroker().request<{ entries: string[] }>("readdir", { path: guestPath(absolutePath) });
      if (!Array.isArray(result.entries) || result.entries.some((entry) => typeof entry !== "string")) {
        throw new Error("sandbox broker returned invalid directory data");
      }
      return result.entries;
    },
  };
}

export function createSandboxFindOperations(getBroker: BrokerGetter): FindOperations {
  return {
    exists: (absolutePath) => guestExists(getBroker(), absolutePath),
    glob: async (pattern, cwd, options) => {
      const result = await getBroker().request<GuestFindResult>("find", {
        pattern,
        path: guestPath(cwd),
        limit: options.limit,
      });
      if (!result || !Array.isArray(result.paths) || result.paths.some((entry) => typeof entry !== "string")) {
        throw new Error("sandbox broker returned invalid find data");
      }
      return result.paths;
    },
  };
}

export function createSandboxBashOperations(getBroker: BrokerGetter): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const result = await getBroker().request<GuestExecResult>(
        "exec",
        {
          command,
          cwd: guestPath(cwd),
          timeout,
          env: sanitizeGuestEnv(env),
        },
        { signal, onData },
      );
      if (!result || (typeof result.exitCode !== "number" && result.exitCode !== null)) {
        throw new Error("sandbox broker returned invalid command data");
      }
      return result;
    },
  };
}

export function resolveSandboxToolPath(input: string | undefined): string {
  return resolveGuestPath(input ?? ".", GUEST_WORKSPACE);
}

export async function executeSandboxGrep(
  broker: BrokerClient,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
  const root = resolveSandboxToolPath(params.path);
  const result = await broker.request<GuestGrepResult>(
    "grep",
    {
      pattern: params.pattern,
      path: root,
      glob: params.glob,
      ignoreCase: params.ignoreCase,
      literal: params.literal,
      context: params.context,
      limit: params.limit,
    },
    { signal },
  );
  if (!result || typeof result.output !== "string") throw new Error("sandbox broker returned invalid grep data");
  if (!result.output) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  const truncation = truncateHead(result.output, { maxLines: Number.MAX_SAFE_INTEGER });
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  let output = truncation.content;
  const effectiveLimit = Math.max(1, params.limit ?? 100);
  if (result.matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (result.linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}