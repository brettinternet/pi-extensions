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

export const WORKBENCH_PROVIDER = "herdr-workbench";

export interface BackgroundActivityStarted {
  version: 1;
  provider: string;
  activityId: string;
  kind: "job";
  sessionId: string;
  sessionFile?: string;
  workspaceId: string;
  originId?: string;
  label: string;
  cancellable: true;
  resumed?: true;
}

export interface BackgroundActivityFinished {
  version: 1;
  provider: string;
  activityId: string;
  kind: "job";
  sessionId: string;
  sessionFile?: string;
  workspaceId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode?: number;
  summary: string;
}

export interface BackgroundActivityCancelRequest {
  version: 1;
  requestId: string;
  provider: string;
  activityId: string;
  sessionId: string;
  sessionFile?: string;
  workspaceId: string;
}

export interface BackgroundActivityCancelReply {
  version: 1;
  requestId: string;
  success: boolean;
  error?: string;
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
