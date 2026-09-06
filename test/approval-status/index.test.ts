import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import approvalStatusExtension, {
  APPROVAL_FINISHED_EVENT,
  APPROVAL_STARTED_EVENT,
  withApprovalStatus,
} from "../../extensions/approval-status/index.ts";

class EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function harness() {
  const events = new EventBus();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    events,
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  approvalStatusExtension(pi);
  return { events, hooks, pi };
}

const first = { version: 1, requestId: "first", label: "Approval required" };
const second = { version: 1, requestId: "second", label: "Another approval" };

describe("approval status", () => {
  test("holds one counted Herdr block across concurrent approvals", () => {
    const { events } = harness();
    const reports: unknown[] = [];
    events.on("herdr:blocked", (value) => reports.push(value));

    events.emit(APPROVAL_STARTED_EVENT, first);
    events.emit(APPROVAL_STARTED_EVENT, second);
    events.emit(APPROVAL_FINISHED_EVENT, first);
    events.emit(APPROVAL_FINISHED_EVENT, second);

    expect(reports).toEqual([
      { active: true, label: "Approval required" },
      { active: false },
    ]);
  });

  test("ignores malformed and duplicate lifecycle events", () => {
    const { events } = harness();
    const reports: unknown[] = [];
    events.on("herdr:blocked", (value) => reports.push(value));

    events.emit(APPROVAL_STARTED_EVENT, { requestId: "missing-version", label: "Approval" });
    events.emit(APPROVAL_STARTED_EVENT, first);
    events.emit(APPROVAL_STARTED_EVENT, first);
    events.emit(APPROVAL_FINISHED_EVENT, { ...first, requestId: "unknown" });
    events.emit(APPROVAL_FINISHED_EVENT, first);

    expect(reports).toEqual([
      { active: true, label: "Approval required" },
      { active: false },
    ]);
  });

  test("clears pending status when the session changes", () => {
    const { events, hooks } = harness();
    const reports: unknown[] = [];
    events.on("herdr:blocked", (value) => reports.push(value));

    events.emit(APPROVAL_STARTED_EVENT, first);
    hooks.get("session_start")?.({}, {});

    expect(reports).toEqual([
      { active: true, label: "Approval required" },
      { active: false },
    ]);
  });

  test("pairs status around successful and failed approval work", async () => {
    const { events, pi } = harness();
    const lifecycle: string[] = [];
    events.on(APPROVAL_STARTED_EVENT, () => lifecycle.push("started"));
    events.on(APPROVAL_FINISHED_EVENT, () => lifecycle.push("finished"));

    await expect(withApprovalStatus(pi, "Approval", async () => "approved", "success"))
      .resolves.toBe("approved");
    await expect(withApprovalStatus(pi, "Approval", async () => {
      throw new Error("denied");
    }, "failure")).rejects.toThrow("denied");

    expect(lifecycle).toEqual(["started", "finished", "started", "finished"]);
  });
});
