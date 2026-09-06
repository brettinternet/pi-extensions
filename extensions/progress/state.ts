import { relative } from "node:path";

const MAX_RECENT_CHECKS = 2;
const MAX_TOUCHED_PATHS = 8;

export type CheckOutcome = "running" | "passed" | "failed";

export interface ToolActivity {
  id: string;
  name: string;
  label: string;
  path?: string;
  check?: {
    label: string;
    outcome: CheckOutcome;
  };
}

export interface CheckActivity {
  id: string;
  label: string;
  outcome: Exclude<CheckOutcome, "running">;
}

export interface SemanticSnapshot {
  phase: string;
  current: string;
  completed: string[];
  blocked: string[];
  confidence: number;
}

export interface ProgressSnapshot {
  runStarted: boolean;
  agentActive: boolean;
  tools: ToolActivity[];
  checks: CheckActivity[];
  touchedPaths: string[];
  semantic?: SemanticSnapshot;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function displayPath(path: string, cwd: string): string {
  if (!path.startsWith("/")) return path;
  const candidate = relative(cwd, path);
  return candidate && !candidate.startsWith("..") ? candidate : path;
}

function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/)
    .map(compact)
    .filter(Boolean);
}

function stripCommandWrappers(command: string): string {
  let value = command;
  if (value.startsWith("rtk ")) value = value.slice(4).trimStart();
  const mise = /^mise\s+exec(?:\s+[^\s]+)?\s+--\s+/.exec(value);
  if (mise) value = value.slice(mise[0].length);
  return value;
}

export function checkCommandLabel(command: string): string | undefined {
  const patterns = [
    /^(?:bun\s+test|bun\s+run\s+(?:check|test|lint|typecheck))\b/,
    /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|typecheck))\b/,
    /^(?:task|make)\s+(?:[\w:-]+:)?(?:check|test|lint|typecheck)\b/,
    /^(?:pytest|vitest|jest|tsc|eslint|shellcheck)\b/,
    /^(?:cargo\s+(?:test|check|clippy)|go\s+test|ruff\s+(?:check|format)|biome\s+check)\b/,
    /^prettier\b.*\s--check\b/,
    /^git\s+diff\b.*\s--check\b/,
  ];

  for (const segment of commandSegments(command)) {
    const candidate = stripCommandWrappers(segment);
    if (patterns.some((pattern) => pattern.test(candidate)))
      return compact(candidate);
  }
  return undefined;
}

export function describeTool(
  name: string,
  args: unknown,
  cwd: string,
): Pick<ToolActivity, "label" | "path" | "check"> {
  const path = stringField(args, "path") ?? stringField(args, "filePath");
  const displayedPath = path ? displayPath(path, cwd) : undefined;
  if (name === "bash" || name === "powershell") {
    const command = compact(stringField(args, "command") ?? "");
    const check = checkCommandLabel(command);
    return {
      label: command || name,
      ...(check ? { check: { label: check, outcome: "running" } } : {}),
    };
  }
  return {
    label: displayedPath ? `${name} ${displayedPath}` : name,
    ...(displayedPath ? { path: displayedPath } : {}),
  };
}

export class ProgressState {
  #runStarted = false;
  #agentActive = false;
  readonly #tools = new Map<string, ToolActivity>();
  readonly #checks: CheckActivity[] = [];
  readonly #touchedPaths = new Map<string, true>();
  #semantic: SemanticSnapshot | undefined;
  #generation = 0;

  reset(): void {
    this.#runStarted = false;
    this.#agentActive = false;
    this.#tools.clear();
    this.#checks.length = 0;
    this.#touchedPaths.clear();
    this.#semantic = undefined;
    this.#generation += 1;
  }

  beginRun(): void {
    this.#runStarted = true;
    this.#agentActive = true;
    this.#tools.clear();
    this.#checks.length = 0;
    this.#touchedPaths.clear();
    this.#semantic = undefined;
    this.#generation += 1;
  }

  generation(): number {
    return this.#generation;
  }

  invalidateInference(): void {
    this.#generation += 1;
  }

  setSemantic(semantic: SemanticSnapshot | undefined): void {
    this.#semantic = semantic
      ? { ...semantic, completed: [...semantic.completed], blocked: [...semantic.blocked] }
      : undefined;
  }

  semantic(): SemanticSnapshot | undefined {
    return this.#semantic
      ? { ...this.#semantic, completed: [...this.#semantic.completed], blocked: [...this.#semantic.blocked] }
      : undefined;
  }

  settleRun(): void {
    this.#agentActive = false;
    this.#tools.clear();
    this.#generation += 1;
  }

  startTool(id: string, name: string, args: unknown, cwd: string): void {
    this.#tools.set(id, { id, name, ...describeTool(name, args, cwd) });
  }

  updateTool(id: string, name: string, args: unknown, cwd: string): void {
    if (!this.#tools.has(id)) return;
    this.#tools.set(id, { id, name, ...describeTool(name, args, cwd) });
  }

  finishTool(
    id: string,
    name: string,
    args: unknown,
    cwd: string,
    isError: boolean,
  ): void {
    const activity = this.#tools.get(id) ?? {
      id,
      name,
      ...describeTool(name, args, cwd),
    };
    this.#tools.delete(id);

    if (activity.check) {
      this.#checks.push({
        id,
        label: activity.check.label,
        outcome: isError ? "failed" : "passed",
      });
      if (this.#checks.length > MAX_RECENT_CHECKS) this.#checks.shift();
    }

    if (!isError && (name === "edit" || name === "write") && activity.path) {
      this.#touchedPaths.delete(activity.path);
      this.#touchedPaths.set(activity.path, true);
      while (this.#touchedPaths.size > MAX_TOUCHED_PATHS) {
        const oldest = this.#touchedPaths.keys().next().value as
          string | undefined;
        if (!oldest) break;
        this.#touchedPaths.delete(oldest);
      }
    }
  }

  snapshot(): ProgressSnapshot {
    return {
      runStarted: this.#runStarted,
      agentActive: this.#agentActive,
      tools: [...this.#tools.values()],
      checks: [...this.#checks],
      touchedPaths: [...this.#touchedPaths.keys()],
      ...(this.#semantic ? { semantic: this.semantic() } : {}),
    };
  }
}
