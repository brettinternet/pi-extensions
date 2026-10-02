import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  findExternalTypeScriptServer,
  getBuiltinServers,
  resolveServerCommand,
  validateTypeScriptServerPath,
  type ServerDefinition,
} from "./servers.ts";

export interface LspConfigEntry {
  disabled?: boolean;
  command?: string[];
  initializationOptions?: Record<string, unknown>;
}

export interface LspConfig {
  servers: Record<string, LspConfigEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => validJsonValue(item, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 100 && Object.values(value).every((item) => validJsonValue(item, depth + 1));
}

export async function readGlobalConfig(): Promise<LspConfig> {
  const path = resolve(getAgentDir(), "pi-lsp.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { servers: {} };
    throw new Error(`Cannot read Pi LSP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Pi LSP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "servers") || !isRecord(parsed.servers)) {
    throw new Error(`Invalid Pi LSP config at ${path}: expected { "servers": { "<server-id>": { "disabled"?: boolean, "command"?: string[], "initializationOptions"?: object } } }`);
  }

  const servers: Record<string, LspConfigEntry> = {};
  for (const [id, value] of Object.entries(parsed.servers)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !getBuiltinServers().some((server) => server.id === id) || !isRecord(value)) {
      throw new Error(`Invalid Pi LSP config at ${path}: invalid or unknown server entry '${id}'`);
    }
    if (Object.keys(value).some((key) => key !== "disabled" && key !== "command" && key !== "initializationOptions")) {
      throw new Error(`Invalid Pi LSP config at ${path}: unsupported key in server '${id}'`);
    }
    if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
      throw new Error(`Invalid Pi LSP config at ${path}: '${id}.disabled' must be boolean`);
    }
    if (value.command !== undefined && (!Array.isArray(value.command) || value.command.length === 0 || value.command.length > 32 || value.command.some((part) => typeof part !== "string" || part.length === 0))) {
      throw new Error(`Invalid Pi LSP config at ${path}: '${id}.command' must be a non-empty string array`);
    }
    const command = value.command as string[] | undefined;
    if (command?.some((part) => part.includes("\0"))) {
      throw new Error(`Invalid Pi LSP config at ${path}: '${id}.command' contains an invalid NUL byte`);
    }
    if (command?.[0] && (command[0].includes("/") || command[0].includes("\\")) && !isAbsolute(command[0])) {
      throw new Error(`Invalid Pi LSP config at ${path}: '${id}.command[0]' must be an absolute path or executable name`);
    }
    if (value.initializationOptions !== undefined && (
      !isRecord(value.initializationOptions) ||
      !validJsonValue(value.initializationOptions) ||
      JSON.stringify(value.initializationOptions).length > 8_000
    )) {
      throw new Error(`Invalid Pi LSP config at ${path}: '${id}.initializationOptions' must be a JSON object no larger than 8 KB with at most 8 nested levels`);
    }
    servers[id] = {
      ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
      ...(command === undefined ? {} : { command: [...command] }),
      ...(value.initializationOptions === undefined ? {} : { initializationOptions: value.initializationOptions }),
    };
  }
  return { servers };
}

export async function resolveServer(extension: string, workspace: string): Promise<ServerDefinition & { resolvedCommand: string[] }> {
  const config = await readGlobalConfig();
  const definition = getBuiltinServers().find((server) => server.extensions.includes(extension));
  if (!definition) throw new Error(`No built-in LSP server is configured for '${extension || "this file"}'.`);

  const override = config.servers[definition.id];
  if (override?.disabled) throw new Error(`The '${definition.id}' language server is disabled in ${resolve(getAgentDir(), "pi-lsp.json")}.`);
  const command = override?.command ?? definition.command;
  const executable = resolveServerCommand(command[0]!, workspace);
  if (!executable) {
    throw new Error(`Language server '${definition.id}' was not found on PATH (${command[0]}). Install it yourself or set its command in ${resolve(getAgentDir(), "pi-lsp.json")}; pi-lsp never installs servers.`);
  }
  let initializationOptions = override?.initializationOptions;
  if (definition.id === "typescript") {
    const configuredTsserver = initializationOptions?.["tsserver"];
    if (configuredTsserver !== undefined && !isRecord(configuredTsserver)) {
      throw new Error(`Invalid global TypeScript configuration in ${resolve(getAgentDir(), "pi-lsp.json")}: initializationOptions.tsserver must be an object.`);
    }
    const configuredPath = isRecord(configuredTsserver) ? configuredTsserver["path"] : undefined;
    if (configuredPath !== undefined && typeof configuredPath !== "string") {
      throw new Error(`Invalid global TypeScript configuration in ${resolve(getAgentDir(), "pi-lsp.json")}: initializationOptions.tsserver.path must be an absolute path.`);
    }
    const tsserverPath = configuredPath === undefined
      ? await findExternalTypeScriptServer(workspace)
      : await validateTypeScriptServerPath(configuredPath, workspace);
    initializationOptions = {
      ...(initializationOptions ?? {}),
      disableAutomaticTypingAcquisition: true,
      tsserver: { ...(isRecord(configuredTsserver) ? configuredTsserver : {}), path: tsserverPath },
    };
  }
  return {
    ...definition,
    command,
    resolvedCommand: [executable, ...command.slice(1)],
    workspaceBoundary: await realpath(workspace),
    ...(initializationOptions ? { initializationOptions } : {}),
  };
}
