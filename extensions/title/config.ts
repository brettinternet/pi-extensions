import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface Config {
  enabled: boolean;
  model: string | null;
  maxTokens: number;
  maxLength: number;
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  model: null,
  maxTokens: 30,
  maxLength: 60,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-title.jsonc");
}

function legacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-title.json");
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (input.model !== undefined && input.model !== null && typeof input.model !== "string") {
    throw new Error('"model" must be a provider/model string or null');
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error('"enabled" must be a boolean');
  }

  const model = input.model === undefined
    ? DEFAULT_CONFIG.model
    : typeof input.model === "string"
      ? input.model.trim() || null
      : null;
  return {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    model,
    maxTokens: positiveInteger(input.maxTokens, DEFAULT_CONFIG.maxTokens),
    maxLength: positiveInteger(input.maxLength, DEFAULT_CONFIG.maxLength),
  };
}

function parseConfigText(text: string): Config {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return parseConfig(value);
}

async function loadConfigFile(path: string): Promise<Config> {
  try {
    return parseConfigText(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export async function loadConfig(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  if (path) return loadConfigFile(path);

  try {
    return await loadConfigFile(configPath(env));
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code !== "ENOENT") throw error;
  }

  try {
    return await loadConfigFile(legacyConfigPath(env));
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw error;
  }
}

function updateConfigText(text: string, config: Config): string {
  parseConfigText(text);
  let updated = text;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  for (const [key, value] of Object.entries(config)) {
    updated = applyEdits(updated, modify(updated, [key], value, { formattingOptions }));
  }
  return `${updated.trimEnd()}\n`;
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  let contents: string;
  try {
    contents = updateConfigText(await readFile(path, "utf8"), config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to update ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    contents = `${JSON.stringify(config, null, 2)}\n`;
  }

  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}
