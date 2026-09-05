import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { classifyCommandRisk } from "./command-policy.ts";
import { ConfirmationBroker, type ForceCloseTarget } from "./confirmation.ts";
import {
  assertSupportedForce,
  type WorkbenchInput,
  type WorkbenchResponse,
  WorkbenchClient,
} from "./client.ts";
import {
  BACKGROUND_ACTIVITY_CANCEL_EVENT,
  BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX,
  BACKGROUND_ACTIVITY_FINISHED_EVENT,
  BACKGROUND_ACTIVITY_SNAPSHOT_EVENT,
  BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX,
  BACKGROUND_ACTIVITY_STARTED_EVENT,
  type BackgroundActivityCancelReply,
  type BackgroundActivityCancelRequest,
  type BackgroundActivityFinished,
  type BackgroundActivitySnapshotReply,
  type BackgroundActivitySnapshotRequest,
  type BackgroundActivityStarted,
  WORKBENCH_PROVIDER,
} from "./protocol.ts";

const OWNERSHIP_ENTRY = "pi-herdr-workbench-ownership";
const MAX_TOOL_OUTPUT_CHARS = 40_000;
const MAX_ACTIVITY_SUMMARY_CHARS = 4_000;
const POLL_INTERVAL_MS = 1_000;

const ACTIONS = [
  "layout",
  "pane.focus",
  "editor.open",
  "editor.status",
  "editor.close",
  "job.start",
  "job.status",
  "job.list",
  "job.read",
  "job.cancel",
  "job.close",
  "lazygit.open",
  "lazygit.close",
] as const;

const PLACEMENTS = ["auto", "right", "down", "tab", "zoomed"] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "Workbench operation to perform" }),
  path: Type.Optional(Type.String({ description: "File or directory for editor.open" })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  column: Type.Optional(Type.Integer({ minimum: 1 })),
  cwd: Type.Optional(Type.String({ description: "Working directory for jobs or applications" })),
  placement: Type.Optional(StringEnum(PLACEMENTS)),
  focus: Type.Optional(Type.Boolean({ description: "Move Herdr focus to the target pane" })),
  force: Type.Optional(Type.Boolean({ description: "Force-close an editor or job and discard its remaining state" })),
  interactive: Type.Optional(Type.Boolean({ description: "Attach a job directly to its pane PTY" })),
  command: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 256 })),
  jobId: Type.Optional(Type.String({ pattern: "^job-[A-Za-z0-9-]+$" })),
  paneId: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

interface OwnedResource {
  id: string;
  workspaceId?: string;
}

type ResourceKind = "job" | "editor" | "lazygit" | "known-pane" | "terminal-job";
type OwnershipOperation = "add" | "remove";

interface OwnershipEntry {
  version: 1;
  operation: OwnershipOperation;
  resource: ResourceKind;
  id: string;
  workspaceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
}

export class OwnershipRegistry {
  readonly jobs = new Map<string, OwnedResource>();
  readonly editors = new Map<string, OwnedResource>();
  readonly lazygit = new Map<string, OwnedResource>();
  readonly knownPanes = new Set<string>();
  readonly terminalJobs = new Set<string>();

  clear(): void {
    this.jobs.clear();
    this.editors.clear();
    this.lazygit.clear();
    this.knownPanes.clear();
    this.terminalJobs.clear();
  }

  apply(entry: OwnershipEntry): void {
    const add = entry.operation === "add";
    if (entry.resource === "known-pane") {
      if (add) this.knownPanes.add(entry.id);
      else this.knownPanes.delete(entry.id);
      return;
    }
    if (entry.resource === "terminal-job") {
      if (add) this.terminalJobs.add(entry.id);
      else this.terminalJobs.delete(entry.id);
      return;
    }
    const collection = entry.resource === "job"
      ? this.jobs
      : entry.resource === "editor"
      ? this.editors
      : this.lazygit;
    if (add) collection.set(entry.id, { id: entry.id, workspaceId: entry.workspaceId });
    else collection.delete(entry.id);
  }
}

function parseOwnershipEntry(value: unknown): OwnershipEntry | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const operation = value.operation;
  const resource = value.resource;
  const id = value.id;
  if (operation !== "add" && operation !== "remove") return undefined;
  if (
    resource !== "job" &&
    resource !== "editor" &&
    resource !== "lazygit" &&
    resource !== "known-pane" &&
    resource !== "terminal-job"
  ) return undefined;
  if (typeof id !== "string") return undefined;
  return {
    version: 1,
    operation,
    resource,
    id,
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
  };
}

function truncateResponse(response: WorkbenchResponse): WorkbenchResponse {
  const output = response.output;
  if (typeof output !== "string" || output.length <= MAX_TOOL_OUTPUT_CHARS) return response;
  return {
    ...response,
    output: `[Earlier output truncated]\n${output.slice(-MAX_TOOL_OUTPUT_CHARS)}`,
  };
}

function requiresTrust(action: WorkbenchInput["action"]): boolean {
  return !new Set<WorkbenchInput["action"]>([
    "layout",
    "editor.status",
    "job.status",
    "job.list",
    "job.read",
  ]).has(action);
}

function sessionIdentity(ctx: ExtensionContext): {
  sessionId: string;
  sessionFile?: string;
} {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export function terminalOutcome(job: Record<string, unknown>):
  | "succeeded"
  | "failed"
  | "cancelled"
  | undefined {
  const state = stringField(job, "status");
  const exitCode = numberField(job, "exitCode");
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state === "completed") return exitCode === undefined || exitCode === 0
    ? "succeeded"
    : "failed";
  return undefined;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function displaySummary(response: WorkbenchResponse): string {
  const action = response.action;
  const job = recordField(response, "job");
  const editor = recordField(response, "editor");
  const lazygit = recordField(response, "lazygit");
  const paneId = stringField(job, "paneId") ?? stringField(editor, "paneId") ??
    stringField(lazygit, "paneId") ?? stringField(response, "paneId");
  const jobId = stringField(job, "jobId") ?? stringField(response, "jobId");
  const status = stringField(job, "status");
  return [
    action,
    jobId ? `job ${jobId}` : undefined,
    paneId ? `pane ${paneId}` : undefined,
    status,
  ].filter(Boolean).join(" · ");
}

export default function workbenchExtension(pi: ExtensionAPI): void {
  const client = new WorkbenchClient((command, args, options) =>
    pi.exec(command, args, options)
  );
  const ownership = new OwnershipRegistry();
  const confirmations = new ConfirmationBroker(pi);
  const monitors = new Map<string, AbortController>();
  let currentContext: ExtensionContext | undefined;

  function persist(entry: OwnershipEntry): void {
    ownership.apply(entry);
    pi.appendEntry(OWNERSHIP_ENTRY, entry);
  }

  function addKnownPane(paneId: string): void {
    if (!ownership.knownPanes.has(paneId)) {
      persist({ version: 1, operation: "add", resource: "known-pane", id: paneId });
    }
  }

  function own(
    resource: Exclude<ResourceKind, "known-pane" | "terminal-job">,
    id: string,
    workspaceId?: string,
  ): void {
    persist({ version: 1, operation: "add", resource, id, ...(workspaceId ? { workspaceId } : {}) });
    if (resource !== "job") addKnownPane(id);
  }

  function release(resource: ResourceKind, id: string): void {
    persist({ version: 1, operation: "remove", resource, id });
  }

  function assertOwnedJob(jobId: string | undefined): string {
    if (!jobId || !ownership.jobs.has(jobId)) {
      throw new Error("That job is not owned by this Pi session");
    }
    return jobId;
  }

  async function currentWorkspace(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
    const layout = await client.execute({ action: "layout" }, ctx.cwd, signal);
    const pane = recordField(layout, "currentPane");
    const workspaceId = stringField(pane, "workspace_id");
    if (!workspaceId) throw new Error("Workbench did not report the current workspace");
    return workspaceId;
  }

  function markTerminal(jobId: string): void {
    if (!ownership.terminalJobs.has(jobId)) {
      persist({ version: 1, operation: "add", resource: "terminal-job", id: jobId });
    }
  }

  async function monitorJob(
    jobId: string,
    workspaceId: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (monitors.has(jobId) || ownership.terminalJobs.has(jobId)) return;
    const controller = new AbortController();
    monitors.set(jobId, controller);
    try {
      while (!controller.signal.aborted) {
        await delay(POLL_INTERVAL_MS, controller.signal);
        let status: WorkbenchResponse;
        try {
          status = await client.execute({ action: "job.status", jobId }, ctx.cwd, controller.signal);
        } catch {
          continue;
        }
        const job = recordField(status, "job");
        if (!job) continue;
        const outcome = terminalOutcome(job);
        if (!outcome) continue;
        const exitCode = numberField(job, "exitCode");
        let output = "";
        try {
          const read = await client.execute(
            { action: "job.read", jobId, lines: 40 },
            ctx.cwd,
            controller.signal,
          );
          output = typeof read.output === "string" ? read.output.trim() : "";
        } catch {}
        const headline = `Workbench job ${jobId} ${outcome}${exitCode === undefined ? "" : ` with exit code ${exitCode}`}.`;
        const availableOutput = MAX_ACTIVITY_SUMMARY_CHARS - headline.length - 2;
        const summary = output
          ? `${headline}\n\n${output.slice(-Math.max(0, availableOutput))}`
          : headline;
        markTerminal(jobId);
        const finished: BackgroundActivityFinished = {
          version: 1,
          provider: WORKBENCH_PROVIDER,
          activityId: jobId,
          kind: "job",
          ...sessionIdentity(ctx),
          workspaceId,
          outcome,
          ...(exitCode !== undefined ? { exitCode } : {}),
          summary,
        };
        pi.events.emit(BACKGROUND_ACTIVITY_FINISHED_EVENT, finished);
        if (ctx.hasUI) ctx.ui.notify(summary, outcome === "succeeded" ? "info" : "warning");
        return;
      }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (monitors.get(jobId) === controller) monitors.delete(jobId);
    }
  }

  function trackResponse(input: WorkbenchInput, response: WorkbenchResponse): void {
    if (input.action === "editor.open") {
      const editor = recordField(response, "editor");
      const paneId = stringField(editor, "paneId");
      const workspaceId = stringField(editor, "workspaceId");
      if (paneId) {
        addKnownPane(paneId);
        if (response.created === true) own("editor", paneId, workspaceId);
      }
    }
    if (input.action === "lazygit.open") {
      const lazygit = recordField(response, "lazygit");
      const paneId = stringField(lazygit, "paneId");
      const workspaceId = stringField(lazygit, "workspaceId");
      if (paneId) {
        addKnownPane(paneId);
        if (response.created === true) own("lazygit", paneId, workspaceId);
      }
    }
  }

  async function prepareAction(
    input: WorkbenchInput,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{
    forceCloseTarget?: ForceCloseTarget;
    expectedEditorPaneId?: string;
    downgradeForce?: boolean;
  }> {
    assertSupportedForce(input);
    if (requiresTrust(input.action) && !ctx.isProjectTrusted()) {
      throw new Error("Workbench mutations require a trusted project");
    }
    if (input.action === "job.start" && (!input.command || input.command.length === 0)) {
      throw new Error("job.start requires a non-empty command argv");
    }
    let forceCloseTarget: ForceCloseTarget | undefined;
    let expectedEditorPaneId: string | undefined;
    let downgradeForce = false;
    if (input.action.startsWith("job.") && !["job.start", "job.list"].includes(input.action)) {
      const jobId = assertOwnedJob(input.jobId);
      if (input.action === "job.close" && input.force === true) {
        const status = await client.execute({ action: "job.status", jobId }, ctx.cwd, signal);
        const state = stringField(recordField(status, "job"), "status");
        if (state && ["completed", "failed", "cancelled"].includes(state)) {
          downgradeForce = true;
        } else {
          forceCloseTarget = { kind: "job", id: jobId };
        }
      }
    }
    if (input.action === "pane.focus") {
      if (!input.paneId || !ownership.knownPanes.has(input.paneId)) {
        throw new Error("That pane was not returned by this Pi session's workbench");
      }
    }
    if (input.action === "editor.close") {
      const status = await client.execute({ action: "editor.status" }, ctx.cwd, signal);
      const editor = recordField(status, "editor");
      const paneId = stringField(editor, "paneId");
      if (!paneId || !ownership.editors.has(paneId)) {
        throw new Error("The current workspace editor is not owned by this Pi session");
      }
      expectedEditorPaneId = paneId;
      if (input.force === true) {
        const dirtyBuffers = editor?.dirtyBuffers;
        if (Array.isArray(dirtyBuffers) && dirtyBuffers.length === 0) {
          downgradeForce = true;
        } else {
          forceCloseTarget = { kind: "editor", id: paneId };
        }
      }
    }
    if (input.action === "lazygit.close") {
      const workspaceId = await currentWorkspace(ctx, signal);
      const owned = [...ownership.lazygit.values()].some(
        (resource) => resource.workspaceId === workspaceId,
      );
      if (!owned) throw new Error("The current workspace LazyGit pane is not owned by this Pi session");
    }
    return { forceCloseTarget, expectedEditorPaneId, downgradeForce };
  }

  pi.registerTool({
    name: "workbench",
    label: "Herdr Workbench",
    description: "Inspect and control plugin-owned Herdr panes: open Neovim files, show LazyGit, and start/read/cancel visible foreground jobs. Output is limited to 40,000 characters.",
    promptSnippet: "Control visible Herdr workbench panes and foreground jobs",
    promptGuidelines: [
      "Use workbench only when the user explicitly asks to show or arrange Herdr panes, open code or LazyGit visibly, or run a command visibly in a foreground pane.",
      "Use workbench job.start with command as an argv array; use a shell argv only when the user explicitly requests shell syntax.",
      "Default workbench focus to false unless the user asks to show, watch, reveal, or switch to the target.",
      "Use workbench job status/read/cancel/close only with job IDs returned by this Pi session.",
      "Close owned panes without force first. Use force only to discard known unsaved editor changes or close a job that is still active after an explicit user request.",
    ],
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as WorkbenchInput;
      const { forceCloseTarget, expectedEditorPaneId, downgradeForce } =
        await prepareAction(input, ctx, signal);
      if (forceCloseTarget) {
        await confirmations.confirmForceClose(input, forceCloseTarget, ctx, signal);
        if (forceCloseTarget.kind === "editor" && !ownership.editors.has(forceCloseTarget.id)) {
          throw new Error("The current workspace editor is not owned by this Pi session");
        }
      }
      const jobIdToClose = input.action === "job.close" ? assertOwnedJob(input.jobId) : undefined;
      if (input.action === "job.start") {
        const risk = classifyCommandRisk(input.command!);
        if (risk) await confirmations.confirm(input, risk, ctx, signal);
      }
      onUpdate?.({
        content: [{ type: "text", text: `Running ${input.action}…` }],
        details: {},
      });
      const preparedInput = expectedEditorPaneId
        ? { ...input, expectedPaneId: expectedEditorPaneId }
        : input;
      const executionInput = downgradeForce
        ? { ...preparedInput, force: false }
        : preparedInput;
      let response = truncateResponse(await client.execute(executionInput, ctx.cwd, signal));
      if (input.action === "job.list" && Array.isArray(response.jobs)) {
        response = {
          ...response,
          jobs: response.jobs.filter(
            (job) => isRecord(job) && typeof job.jobId === "string" && ownership.jobs.has(job.jobId),
          ),
        };
      }
      trackResponse(input, response);

      if (input.action === "job.start") {
        const job = recordField(response, "job");
        const jobId = stringField(job, "jobId");
        const paneId = stringField(job, "paneId");
        const workspaceId = stringField(job, "workspaceId");
        if (!jobId || !paneId || !workspaceId) {
          throw new Error("Workbench did not return complete job ownership information");
        }
        own("job", jobId, workspaceId);
        addKnownPane(paneId);
        const started: BackgroundActivityStarted = {
          version: 1,
          provider: WORKBENCH_PROVIDER,
          activityId: jobId,
          kind: "job",
          ...sessionIdentity(ctx),
          workspaceId,
          originId: toolCallId,
          label: input.command?.join(" ").slice(0, 500) || jobId,
          cancellable: true,
        };
        pi.events.emit(BACKGROUND_ACTIVITY_STARTED_EVENT, started);
        void monitorJob(jobId, workspaceId, ctx);
      }

      if (jobIdToClose) {
        monitors.get(jobIdToClose)?.abort();
        release("job", jobIdToClose);
        release("terminal-job", jobIdToClose);
      }
      if (input.action === "editor.close") {
        const closedPane = stringField(response, "paneId");
        if (closedPane) {
          release("editor", closedPane);
          release("known-pane", closedPane);
        }
      }
      if (input.action === "lazygit.close") {
        const closedPane = stringField(response, "paneId");
        if (closedPane) {
          release("lazygit", closedPane);
          release("known-pane", closedPane);
        }
      }

      return {
        content: [{ type: "text", text: `${displaySummary(response)}\n${JSON.stringify(response)}` }],
        details: { response },
      };
    },
  });

  const unsubscribeSnapshot = pi.events.on(
    BACKGROUND_ACTIVITY_SNAPSHOT_EVENT,
    (value) => {
      if (!isRecord(value)) return;
      const request = value as unknown as BackgroundActivitySnapshotRequest;
      const ctx = currentContext;
      if (
        !ctx || request.version !== 1 || typeof request.requestId !== "string" ||
        request.sessionId !== ctx.sessionManager.getSessionId() ||
        (request.sessionFile !== undefined &&
          request.sessionFile !== ctx.sessionManager.getSessionFile()) ||
        !Number.isInteger(request.limit) || request.limit <= 0
      ) return;
      const limit = Math.min(request.limit, 100);
      const activities: BackgroundActivityStarted[] = [];
      for (const [activityId, resource] of ownership.jobs) {
        if (activities.length >= limit) break;
        if (ownership.terminalJobs.has(activityId) || !resource.workspaceId) continue;
        activities.push({
          version: 1,
          provider: WORKBENCH_PROVIDER,
          activityId,
          kind: "job",
          ...sessionIdentity(ctx),
          workspaceId: resource.workspaceId,
          label: `Workbench job ${activityId}`,
          cancellable: true,
          resumed: true,
        });
      }
      const reply: BackgroundActivitySnapshotReply = {
        version: 1,
        requestId: request.requestId,
        provider: WORKBENCH_PROVIDER,
        activities,
      };
      pi.events.emit(
        `${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${request.requestId}`,
        reply,
      );
    },
  );

  const unsubscribeCancel = pi.events.on(
    BACKGROUND_ACTIVITY_CANCEL_EVENT,
    (value) => {
      if (!isRecord(value)) return;
      const request = value as unknown as BackgroundActivityCancelRequest;
      if (
        request.version !== 1 ||
        request.provider !== WORKBENCH_PROVIDER ||
        typeof request.requestId !== "string"
      ) return;
      const replyEvent = `${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}${request.requestId}`;
      const reply = (success: boolean, error?: string): void => {
        const payload: BackgroundActivityCancelReply = {
          version: 1,
          requestId: request.requestId,
          success,
          ...(error ? { error } : {}),
        };
        pi.events.emit(replyEvent, payload);
      };
      const ctx = currentContext;
      const owned = ownership.jobs.get(request.activityId);
      if (
        !ctx ||
        !owned ||
        request.sessionId !== ctx.sessionManager.getSessionId() ||
        (request.sessionFile !== undefined &&
          request.sessionFile !== ctx.sessionManager.getSessionFile()) ||
        request.workspaceId !== owned.workspaceId
      ) {
        reply(false, "activity is not owned by the current workbench session");
        return;
      }
      void client.execute(
        { action: "job.cancel", jobId: request.activityId },
        ctx.cwd,
      ).then(() => reply(true)).catch((error) =>
        reply(false, error instanceof Error ? error.message : String(error))
      );
    },
  );

  pi.on("session_start", (_event, ctx) => {
    confirmations.abortAll("Session changed");
    confirmations.resetRun();
    for (const monitor of monitors.values()) monitor.abort();
    monitors.clear();
    currentContext = ctx;
    ownership.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== OWNERSHIP_ENTRY) continue;
      const parsed = parseOwnershipEntry(entry.data);
      if (parsed) ownership.apply(parsed);
    }
    for (const [jobId, resource] of ownership.jobs) {
      if (!ownership.terminalJobs.has(jobId) && resource.workspaceId) {
        const started: BackgroundActivityStarted = {
          version: 1,
          provider: WORKBENCH_PROVIDER,
          activityId: jobId,
          kind: "job",
          ...sessionIdentity(ctx),
          workspaceId: resource.workspaceId,
          label: `Workbench job ${jobId}`,
          cancellable: true,
          resumed: true,
        };
        pi.events.emit(BACKGROUND_ACTIVITY_STARTED_EVENT, started);
        void monitorJob(jobId, resource.workspaceId, ctx);
      }
    }
  });

  pi.on("agent_start", () => {
    confirmations.resetRun();
  });

  pi.on("session_shutdown", () => {
    currentContext = undefined;
    confirmations.abortAll();
    unsubscribeSnapshot();
    unsubscribeCancel();
    for (const monitor of monitors.values()) monitor.abort();
    monitors.clear();
  });
}
