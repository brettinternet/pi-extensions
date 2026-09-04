import { access } from "node:fs/promises";
import { join } from "node:path";

const PLUGIN_IDS = ["brettinternet.workbench", "brett.workbench"] as const;
const COMMAND_TIMEOUT_MS = 30_000;

export type WorkbenchAction =
  | "layout"
  | "pane.focus"
  | "editor.open"
  | "editor.status"
  | "editor.close"
  | "job.start"
  | "job.status"
  | "job.list"
  | "job.read"
  | "job.cancel"
  | "job.close"
  | "lazygit.open"
  | "lazygit.close";

export type WorkbenchPlacement = "auto" | "right" | "down" | "tab" | "zoomed";

export interface WorkbenchInput {
  action: WorkbenchAction;
  path?: string;
  line?: number;
  column?: number;
  cwd?: string;
  placement?: WorkbenchPlacement;
  focus?: boolean;
  interactive?: boolean;
  force?: boolean;
  command?: string[];
  jobId?: string;
  paneId?: string;
  lines?: number;
}

export interface WorkbenchResponse extends Record<string, unknown> {
  ok: true;
  action: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

export interface ResolvedPlugin {
  id: string;
  root: string;
  controller: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required for this action`);
  return value;
}

function placementArgs(input: WorkbenchInput): string[] {
  return [
    "--placement",
    input.placement ?? "auto",
    input.focus ? "--focus" : "--no-focus",
  ];
}

export function assertSupportedForce(input: WorkbenchInput): void {
  if (input.force !== undefined && typeof input.force !== "boolean") {
    throw new Error("force must be a boolean");
  }
  if (
    input.force !== undefined &&
    input.action !== "editor.close" &&
    input.action !== "job.close"
  ) {
    throw new Error("force is only supported for editor.close and job.close");
  }
}

export function buildWorkbenchArguments(input: WorkbenchInput): string[] {
  assertSupportedForce(input);
  switch (input.action) {
    case "layout":
      return ["layout"];
    case "pane.focus":
      return ["pane", "focus", required(input.paneId, "paneId")];
    case "editor.open": {
      const args = ["editor", "open", required(input.path, "path")];
      if (input.line !== undefined) args.push("--line", String(input.line));
      if (input.column !== undefined) args.push("--column", String(input.column));
      if (input.cwd) args.push("--cwd", input.cwd);
      return [...args, ...placementArgs(input)];
    }
    case "editor.status":
      return ["editor", "status"];
    case "editor.close": {
      const args = ["editor", "close"];
      if (input.force) args.push("--force");
      return args;
    }
    case "job.start": {
      if (!input.command?.length) throw new Error("command is required for job.start");
      const args = ["job", "start"];
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.interactive) args.push("--interactive");
      return [...args, ...placementArgs(input), "--", ...input.command];
    }
    case "job.status":
      return ["job", "status", required(input.jobId, "jobId")];
    case "job.list":
      return ["job", "list"];
    case "job.read": {
      const args = ["job", "read", required(input.jobId, "jobId")];
      if (input.lines !== undefined) args.push("--lines", String(input.lines));
      return args;
    }
    case "job.cancel":
      return ["job", "cancel", required(input.jobId, "jobId")];
    case "job.close": {
      const args = ["job", "close", required(input.jobId, "jobId")];
      if (input.force) args.push("--force");
      return args;
    }
    case "lazygit.open": {
      const args = ["lazygit", "open"];
      if (input.cwd) args.push("--cwd", input.cwd);
      return [...args, ...placementArgs(input)];
    }
    case "lazygit.close":
      return ["lazygit", "close"];
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function commandError(result: ExecResult, fallback: string): Error {
  const parsed = parseJson(result.stderr) ?? parseJson(result.stdout);
  const error = parsed && isRecord(parsed.error) ? parsed.error : undefined;
  const message = error && typeof error.message === "string"
    ? error.message
    : result.stderr.trim() || result.stdout.trim() || fallback;
  return new Error(message);
}

export class WorkbenchClient {
  readonly #exec: Exec;
  #plugin: ResolvedPlugin | undefined;

  constructor(exec: Exec) {
    this.#exec = exec;
  }

  async resolve(cwd: string, signal?: AbortSignal): Promise<ResolvedPlugin> {
    if (this.#plugin) return this.#plugin;
    for (const id of PLUGIN_IDS) {
      const result = await this.#exec(
        "herdr",
        ["plugin", "list", "--plugin", id, "--json"],
        { cwd, signal, timeout: COMMAND_TIMEOUT_MS },
      );
      if (result.code !== 0) continue;
      const payload = parseJson(result.stdout);
      const resultObject = payload && isRecord(payload.result) ? payload.result : undefined;
      const plugins = resultObject?.plugins;
      const plugin = Array.isArray(plugins) && isRecord(plugins[0]) ? plugins[0] : undefined;
      if (!plugin || plugin.enabled !== true || typeof plugin.plugin_root !== "string") continue;
      const controller = join(plugin.plugin_root, "workbench.py");
      await access(controller);
      this.#plugin = { id, root: plugin.plugin_root, controller };
      return this.#plugin;
    }
    throw new Error(
      "The enabled Herdr workbench plugin was not found. Link or install brettinternet/herdr-plugins/workbench.",
    );
  }

  async execute(
    input: WorkbenchInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchResponse> {
    assertSupportedForce(input);
    const plugin = await this.resolve(cwd, signal);
    const args = [
      `HERDR_PLUGIN_ID=${plugin.id}`,
      "python3",
      plugin.controller,
      ...buildWorkbenchArguments(input),
    ];
    const result = await this.#exec("env", args, {
      cwd,
      signal,
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw commandError(result, `workbench ${input.action} failed`);
    }
    const payload = parseJson(result.stdout);
    if (!payload || payload.ok !== true || typeof payload.action !== "string") {
      throw new Error(`workbench ${input.action} returned invalid JSON`);
    }
    return payload as WorkbenchResponse;
  }
}
