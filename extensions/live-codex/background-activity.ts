import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isObject } from "./type-guards.ts";

// This module intentionally owns a local copy of the wire contract. Producers and
// consumers may be installed as unrelated packages and communicate only via pi.events.
export const BACKGROUND_ACTIVITY_STARTED_EVENT =
  "pi:background-activity:v1:started";
export const BACKGROUND_ACTIVITY_FINISHED_EVENT =
  "pi:background-activity:v1:finished";
export const BACKGROUND_ACTIVITY_CANCEL_EVENT =
  "pi:background-activity:v1:cancel";
export const BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX =
  "pi:background-activity:v1:cancel-reply:";
export const BACKGROUND_ACTIVITY_SNAPSHOT_EVENT =
  "pi:background-activity:v1:snapshot";
export const BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX =
  "pi:background-activity:v1:snapshot-reply:";

export const SUBAGENT_PROVIDER = "pi-subagents";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SNAPSHOT_LIMIT = 100;
export const SNAPSHOT_WINDOW_MS = 250;
export const CANCEL_REPLY_TIMEOUT_MS = 5_000;

export type BackgroundActivityOutcome = "succeeded" | "failed" | "cancelled";

export interface BackgroundActivityStarted {
  version: 1;
  provider: string;
  activityId: string;
  kind: string;
  sessionId: string;
  sessionFile?: string;
  workspaceId?: string;
  originId?: string;
  label: string;
  cancellable: boolean;
  resumed?: true;
}

export interface BackgroundActivityFinished {
  version: 1;
  provider: string;
  activityId: string;
  kind: string;
  sessionId: string;
  sessionFile?: string;
  workspaceId?: string;
  outcome: BackgroundActivityOutcome;
  exitCode?: number;
  summary: string;
}

export interface BackgroundActivitySnapshotRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  sessionFile?: string;
  limit: number;
}

export interface BackgroundActivitySnapshotReply {
  version: 1;
  requestId: string;
  provider: string;
  activities: BackgroundActivityStarted[];
}

export interface ActivitySessionScope {
  sessionId: string;
  sessionFile?: string;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function matchesScope(
  event: Record<string, unknown>,
  scope: ActivitySessionScope,
): boolean {
  if (stringField(event, "sessionId") !== scope.sessionId) return false;
  const eventFile = stringField(event, "sessionFile");
  return !eventFile || (!!scope.sessionFile && eventFile === scope.sessionFile);
}

export function parseBackgroundActivityStarted(
  value: unknown,
  scope: ActivitySessionScope,
): BackgroundActivityStarted | undefined {
  if (!isObject(value) || value.version !== 1 || !matchesScope(value, scope)) {
    return undefined;
  }
  const provider = stringField(value, "provider");
  const activityId = stringField(value, "activityId");
  const kind = stringField(value, "kind");
  const label = stringField(value, "label");
  const originId = stringField(value, "originId");
  if (
    !provider || !activityId || !kind || !label ||
    typeof value.cancellable !== "boolean" ||
    (value.resumed !== true && !originId)
  ) return undefined;
  const workspaceId = stringField(value, "workspaceId");
  const sessionFile = stringField(value, "sessionFile");
  return {
    version: 1,
    provider,
    activityId,
    kind,
    sessionId: scope.sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(originId ? { originId } : {}),
    label,
    cancellable: value.cancellable,
    ...(value.resumed === true ? { resumed: true } : {}),
  };
}

export function parseBackgroundActivityFinished(
  value: unknown,
  scope: ActivitySessionScope,
): BackgroundActivityFinished | undefined {
  if (!isObject(value) || value.version !== 1 || !matchesScope(value, scope)) {
    return undefined;
  }
  const provider = stringField(value, "provider");
  const activityId = stringField(value, "activityId");
  const kind = stringField(value, "kind");
  const summary = typeof value.summary === "string" ? value.summary : undefined;
  if (
    !provider || !activityId || !kind || summary === undefined ||
    (value.outcome !== "succeeded" && value.outcome !== "failed" &&
      value.outcome !== "cancelled")
  ) return undefined;
  const workspaceId = stringField(value, "workspaceId");
  const sessionFile = stringField(value, "sessionFile");
  return {
    version: 1,
    provider,
    activityId,
    kind,
    sessionId: scope.sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    outcome: value.outcome,
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    summary,
  };
}

function matchesLegacyScope(
  event: Record<string, unknown>,
  scope: ActivitySessionScope,
): boolean {
  const eventSession = stringField(event, "sessionId");
  return !eventSession || eventSession === scope.sessionId ||
    eventSession === scope.sessionFile;
}

export function parseLegacySubagentStarted(
  value: unknown,
  scope: ActivitySessionScope,
  originId: string,
): BackgroundActivityStarted | undefined {
  if (!isObject(value) || !matchesLegacyScope(value, scope)) return undefined;
  const activityId = stringField(value, "runId") ?? stringField(value, "id");
  if (!activityId) return undefined;
  return {
    version: 1,
    provider: SUBAGENT_PROVIDER,
    activityId,
    kind: "subagent",
    ...scope,
    originId,
    label: stringField(value, "goal") ?? stringField(value, "task") ?? activityId,
    cancellable: true,
  };
}

export function parseLegacySubagentFinished(
  value: unknown,
  scope: ActivitySessionScope,
): BackgroundActivityFinished | undefined {
  if (!isObject(value) || !matchesLegacyScope(value, scope)) return undefined;
  const activityId = stringField(value, "runId") ?? stringField(value, "id");
  if (!activityId) return undefined;
  const state = stringField(value, "state");
  const outcome: BackgroundActivityOutcome = state === "stopped" || state === "cancelled"
    ? "cancelled"
    : value.success === true || state === "complete" || state === "completed"
    ? "succeeded"
    : "failed";
  return {
    version: 1,
    provider: SUBAGENT_PROVIDER,
    activityId,
    kind: "subagent",
    ...scope,
    outcome,
    summary: stringField(value, "summary")?.trim() ?? "",
  };
}

export function currentActivityScope(context: ExtensionContext): ActivitySessionScope {
  const sessionFile = context.sessionManager.getSessionFile();
  return {
    sessionId: context.sessionManager.getSessionId(),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export async function cancelBackgroundActivity(
  pi: ExtensionAPI,
  activity: BackgroundActivityStarted,
  timeoutMs = CANCEL_REPLY_TIMEOUT_MS,
): Promise<boolean> {
  const requestId = randomUUID();
  const legacy = activity.provider === SUBAGENT_PROVIDER;
  const replyEvent = legacy
    ? `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`
    : `${BACKGROUND_ACTIVITY_CANCEL_REPLY_PREFIX}${requestId}`;
  let unsubscribe = () => {};
  let timer: NodeJS.Timeout | undefined;
  let settle = (_accepted: boolean) => {};
  const reply = new Promise<boolean>((resolve) => {
    settle = resolve;
    timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    unsubscribe = pi.events.on(replyEvent, (value) => {
      if (!isObject(value) || value.version !== 1 || value.requestId !== requestId) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(value.success === true);
    });
  });
  try {
    if (legacy) {
      pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method: "stop",
        params: { id: activity.activityId },
      });
    } else {
      pi.events.emit(BACKGROUND_ACTIVITY_CANCEL_EVENT, {
        version: 1,
        requestId,
        provider: activity.provider,
        activityId: activity.activityId,
        sessionId: activity.sessionId,
        ...(activity.sessionFile ? { sessionFile: activity.sessionFile } : {}),
        ...(activity.workspaceId ? { workspaceId: activity.workspaceId } : {}),
      });
    }
  } catch {
    clearTimeout(timer);
    unsubscribe();
    settle(false);
  }
  return reply;
}

export function requestBackgroundActivitySnapshot(
  pi: ExtensionAPI,
  scope: ActivitySessionScope,
  onActivity: (activity: BackgroundActivityStarted) => void,
  windowMs = SNAPSHOT_WINDOW_MS,
): () => void {
  const requestId = randomUUID();
  const replyEvent = `${BACKGROUND_ACTIVITY_SNAPSHOT_REPLY_PREFIX}${requestId}`;
  let remaining = SNAPSHOT_LIMIT;
  const unsubscribe = pi.events.on(replyEvent, (value) => {
    if (!isObject(value) || value.version !== 1 || value.requestId !== requestId ||
      !Array.isArray(value.activities) || !stringField(value, "provider")) return;
    const provider = stringField(value, "provider")!;
    for (const candidate of value.activities.slice(0, remaining)) {
      const activity = parseBackgroundActivityStarted(candidate, scope);
      if (activity?.resumed === true && activity.provider === provider) onActivity(activity);
    }
    remaining -= Math.min(remaining, value.activities.length);
    if (remaining === 0) unsubscribe();
  });
  const timer = setTimeout(unsubscribe, windowMs);
  try {
    const request: BackgroundActivitySnapshotRequest = {
      version: 1,
      requestId,
      ...scope,
      limit: SNAPSHOT_LIMIT,
    };
    pi.events.emit(BACKGROUND_ACTIVITY_SNAPSHOT_EVENT, request);
  } catch {
    clearTimeout(timer);
    unsubscribe();
  }
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
