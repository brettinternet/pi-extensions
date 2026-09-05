import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface ProgressConfig {
  model: string | null;
  maxInputChars: number;
  maxTokens: number;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: ProgressConfig = {
  model: null,
  maxInputChars: 12_000,
  maxTokens: 180,
  timeoutMs: 15_000,
};

const CONFIG_KEYS = new Set(["model", "maxInputChars", "maxTokens", "timeoutMs"]);

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-progress.jsonc");
}

function legacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-progress.json");
}

function positiveInteger(input: Record<string, unknown>, key: keyof ProgressConfig): number {
  const value = input[key];
  if (value === undefined) return DEFAULT_CONFIG[key] as number;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`"${key}" must be a positive integer`);
  }
  return value;
}

export function parseConfig(value: unknown): ProgressConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown configuration field: ${unknown[0]}`);
  if (input.model !== undefined && input.model !== null && typeof input.model !== "string") {
    throw new Error('"model" must be a provider/model string or null');
  }

  const model = typeof input.model === "string" ? input.model.trim() : null;
  if (input.model !== undefined && input.model !== null && !model) {
    throw new Error('"model" must not be empty');
  }
  if (model === "auto") throw new Error('"auto" is not supported; configure an explicit provider/model');

  return {
    model,
    maxInputChars: positiveInteger(input, "maxInputChars"),
    maxTokens: positiveInteger(input, "maxTokens"),
    timeoutMs: positiveInteger(input, "timeoutMs"),
  };
}

function parseConfigText(text: string): ProgressConfig {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return parseConfig(value);
}

async function loadConfigFile(path: string): Promise<ProgressConfig> {
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
): Promise<ProgressConfig> {
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
