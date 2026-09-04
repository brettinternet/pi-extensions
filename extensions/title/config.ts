import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}
