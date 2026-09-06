import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const APPROVAL_STARTED_EVENT = "pi:approval-status:v1:started";
export const APPROVAL_FINISHED_EVENT = "pi:approval-status:v1:finished";

export interface ApprovalStatus {
  version: 1;
  requestId: string;
  label: string;
}

function parseApprovalStatus(value: unknown): ApprovalStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<ApprovalStatus>;
  if (candidate.version !== 1 || typeof candidate.requestId !== "string" ||
    !candidate.requestId || typeof candidate.label !== "string" || !candidate.label.trim()) {
    return undefined;
  }
  return candidate as ApprovalStatus;
}

export async function withApprovalStatus<T>(
  pi: Pick<ExtensionAPI, "events">,
  label: string,
  action: () => Promise<T>,
  requestId: string = randomUUID(),
): Promise<T> {
  const status: ApprovalStatus = { version: 1, requestId, label };
  pi.events.emit(APPROVAL_STARTED_EVENT, status);
  try {
    return await action();
  } finally {
    pi.events.emit(APPROVAL_FINISHED_EVENT, status);
  }
}

export default function approvalStatusExtension(pi: ExtensionAPI): void {
  const pending = new Set<string>();

  const stopReporting = (): void => {
    if (pending.size === 0) return;
    pending.clear();
    pi.events.emit("herdr:blocked", { active: false });
  };

  pi.events.on(APPROVAL_STARTED_EVENT, (value) => {
    const status = parseApprovalStatus(value);
    if (!status || pending.has(status.requestId)) return;
    const wasEmpty = pending.size === 0;
    pending.add(status.requestId);
    if (wasEmpty) {
      pi.events.emit("herdr:blocked", { active: true, label: status.label });
    }
  });

  pi.events.on(APPROVAL_FINISHED_EVENT, (value) => {
    const status = parseApprovalStatus(value);
    if (!status || !pending.delete(status.requestId) || pending.size > 0) return;
    pi.events.emit("herdr:blocked", { active: false });
  });

  pi.on("session_start", stopReporting);
  pi.on("session_shutdown", stopReporting);
}
