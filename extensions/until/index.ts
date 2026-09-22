import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createActor } from "xstate";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import { createShellConditionRunner } from "./check.ts";
import { systemClock } from "./clock.ts";
import type { UntilClock } from "./clock.ts";
import {
  parseUntilCommand,
  prepareUntilArguments,
  untilParameters,
} from "./command.ts";
import type {
  StartWatchCommand,
  UntilCommand,
  UntilParameters,
} from "./command.ts";
import { planCompletion } from "./completion.ts";
import {
  advanceAfterTick,
  gateOf,
  initialFacts,
  wakeOf,
} from "./domain.ts";
import type {
  ContextRef,
  WatchActorInput,
  WatchDefinition,
} from "./domain.ts";
import {
  createFollowUpMachine,
  type FollowUpRequest,
  type FollowUpSuspension,
} from "./follow-up.ts";
import { renderWatchIndicator, renderWatchPanel } from "./indicator.ts";
import type { WatchDisplay, WatchPhase } from "./indicator.ts";
import { createWatchMachine } from "./machine.ts";
import type { WatchTerminalState } from "./machine.ts";
import {
  renderRecurringExpiredPacket,
  renderRecurringWakePacket,
} from "./packet.ts";
import {
  MAX_ACTIVE_WATCHES,
  SUSPENDED_ENTRY_TYPE,
  resumeInput,
  suspendWatch,
  suspendedSessionFrom,
  suspensionData,
} from "./suspension.ts";
import type { PersistedWatch } from "./suspension.ts";
import {
  createTelemetrySink,
  hashCondition,
  readTelemetry,
  summarizeTelemetry,
  summaryText,
  telemetryOptionsFromEnv,
} from "./telemetry.ts";
import type { TelemetrySink } from "./telemetry.ts";

export { prepareUntilArguments, untilParameters } from "./command.ts";

const MAX_TERMINAL_RECEIPTS = 50;
const WIDGET_KEY = "pi-until-watches";
export const WATCHES_EVENT = "pi-until:watches";
const PANEL_PAGE_SIZE = 6;
const INDICATOR_REFRESH_MS = 1_000;

type ReceiptStatus =
  | "running"
  | "succeeded"
  | "timedOut"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";
type FinalReceiptStatus = Exclude<ReceiptStatus, "running">;
type WatchMachine = ReturnType<typeof createWatchMachine>;
type WatchActor = ActorRefFrom<WatchMachine>;
type WatchSnapshot = SnapshotFrom<WatchMachine>;
type FollowUpMachine = ReturnType<typeof createFollowUpMachine>;
type FollowUpActor = ActorRefFrom<FollowUpMachine>;

const followUpMarkerSchema = Type.Object(
  { followUpId: Type.String({ minLength: 1 }) },
  { additionalProperties: true }
);

const terminalReceiptSchema = Type.Object(
  {
    attempts: Type.Number({ minimum: 0 }),
    contextRefs: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 16 })),
    defect: Type.Optional(Type.String()),
    deliveries: Type.Number({ minimum: 0 }),
    deliveryPending: Type.Boolean(),
    expiresAt: Type.Optional(Type.String()),
    finishedAt: Type.Optional(Type.String()),
    id: Type.String({ minLength: 1 }),
    intervalMs: Type.Number({ minimum: 1 }),
    kind: Type.Union([Type.Literal("until"), Type.Literal("recurring")]),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    lastCheckKilled: Type.Optional(Type.Boolean()),
    lastCheckedAt: Type.Optional(Type.String()),
    lastExitCode: Type.Optional(Type.Number()),
    missedTicks: Type.Number({ minimum: 0 }),
    nextDueAt: Type.Optional(Type.String()),
    quickRef: Type.Optional(Type.String()),
    reloads: Type.Number({ minimum: 0 }),
    startedAt: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("succeeded"), Type.Literal("timedOut"),
      Type.Literal("completed"), Type.Literal("expired"),
      Type.Literal("cancelled"), Type.Literal("failed"),
    ]),
    wake: Type.Union([Type.Literal("agent"), Type.Literal("notify")]),
  },
  { additionalProperties: false }
);

interface WatchRecord {
  readonly actor: WatchActor;
}

export interface PiUntilOptions {
  readonly clock?: UntilClock;
  readonly followUpDispatchAckMs?: number;
  readonly telemetry?: TelemetrySink;
}

export interface WatchReceipt {
  readonly attempts: number;
  readonly contextRefs?: readonly ContextRef[];
  readonly defect?: string;
  readonly deliveries: number;
  readonly deliveryPending: boolean;
  readonly expiresAt?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly intervalMs: number;
  readonly kind: WatchDefinition["kind"];
  readonly label: string;
  readonly lastCheckKilled?: boolean;
  readonly lastCheckedAt?: string;
  readonly lastExitCode?: number;
  readonly missedTicks: number;
  readonly nextDueAt?: string;
  readonly quickRef?: string;
  readonly reloads: number;
  readonly startedAt: string;
  readonly status: ReceiptStatus;
  readonly wake: "agent" | "notify";
}

const sessionId = (ctx: ExtensionContext | undefined) =>
  ctx?.sessionManager.getSessionId() ?? "unknown";

function terminalState(
  snapshot: WatchSnapshot
): WatchTerminalState | undefined {
  if (snapshot.status !== "done") return undefined;
  if (snapshot.matches("satisfied")) return "satisfied";
  if (snapshot.matches("completed")) return "completed";
  if (snapshot.matches("expired")) return "expired";
  if (snapshot.matches("cancelled")) return "cancelled";
  if (snapshot.matches("failed")) return "failed";
  return undefined;
}

function receiptStatus(record: WatchRecord): ReceiptStatus {
  const snapshot = record.actor.getSnapshot();
  if (snapshot.status === "error") return "failed";
  const terminal = terminalState(snapshot);
  if (terminal === undefined) return "running";
  if (terminal === "satisfied") return "succeeded";
  if (terminal === "failed") return "failed";
  if (terminal === "expired") {
    return snapshot.context.definition.kind === "until"
      ? "timedOut"
      : "expired";
  }
  return terminal;
}

function finalReceiptStatus(record: WatchRecord): FinalReceiptStatus {
  const status = receiptStatus(record);
  if (status === "running") {
    throw new Error("cannot finish a running pi-until watch");
  }
  return status;
}

function defectFrom(snapshot: WatchSnapshot): string | undefined {
  if (snapshot.context.facts.failure !== undefined) {
    return snapshot.context.facts.failure.message;
  }
  if (snapshot.status !== "error") return undefined;
  return snapshot.error instanceof Error
    ? snapshot.error.message
    : String(snapshot.error);
}

function toReceipt(record: WatchRecord): WatchReceipt {
  const snapshot = record.actor.getSnapshot();
  const { definition, facts } = snapshot.context;
  const status = receiptStatus(record);
  const recurring = definition.kind === "recurring" ? definition : undefined;
  return {
    attempts: facts.attempts,
    contextRefs: recurring?.snapshot.contextRefs,
    defect: defectFrom(snapshot),
    deliveries: facts.deliveries,
    deliveryPending: facts.deliveryPending,
    expiresAt:
      definition.expiresAt === undefined
        ? undefined
        : new Date(definition.expiresAt).toISOString(),
    finishedAt:
      facts.finishedAt === undefined
        ? undefined
        : new Date(facts.finishedAt).toISOString(),
    id: facts.id,
    intervalMs: definition.intervalMs,
    kind: definition.kind,
    label: definition.label,
    lastCheckedAt:
      facts.lastCheckedAt === undefined
        ? undefined
        : new Date(facts.lastCheckedAt).toISOString(),
    lastCheckKilled: facts.lastResult?.killed,
    lastExitCode: facts.lastResult?.code,
    missedTicks: facts.missedTicks,
    nextDueAt:
      status === "running"
        ? new Date(facts.nextDueAt).toISOString()
        : undefined,
    quickRef: recurring?.snapshot.quickRef,
    reloads: facts.reloads,
    startedAt: new Date(facts.startedAt).toISOString(),
    status,
    wake: wakeOf(definition),
  };
}

function watchPhase(record: WatchRecord): WatchPhase | undefined {
  if (receiptStatus(record) !== "running") return undefined;
  const snapshot = record.actor.getSnapshot();
  if (snapshot.matches({ active: "checking" })) return "checking";
  if (snapshot.matches({ active: "duePending" })) return "duePending";
  if (snapshot.matches({ active: "awaitingSettlement" })) {
    return "awaitingSettlement";
  }
  return "sleeping";
}

function toWatchDisplay(record: WatchRecord): WatchDisplay {
  const { definition, facts } = record.actor.getSnapshot().context;
  return {
    attempts: facts.attempts,
    condition: gateOf(definition)?.command,
    deliveries: facts.deliveries,
    id: facts.id,
    intervalMs: definition.intervalMs,
    kind: definition.kind,
    label: definition.label,
    missedTicks: facts.missedTicks,
    nextDueAt: facts.nextDueAt,
    phase: watchPhase(record),
    startedAt: facts.startedAt,
    status: receiptStatus(record),
    wake: wakeOf(definition),
  };
}

function displayFromReceipt(receipt: WatchReceipt): WatchDisplay {
  return {
    attempts: receipt.attempts,
    deliveries: receipt.deliveries,
    id: receipt.id,
    intervalMs: receipt.intervalMs,
    kind: receipt.kind,
    label: receipt.label,
    missedTicks: receipt.missedTicks,
    nextDueAt:
      receipt.nextDueAt === undefined ? 0 : Date.parse(receipt.nextDueAt),
    startedAt: Date.parse(receipt.startedAt),
    status: receipt.status,
    wake: receipt.wake,
  };
}

function listText(receipts: readonly WatchReceipt[]): string {
  if (receipts.length === 0) return "No pi-until watches.";
  return receipts
    .map(
      (receipt) =>
        `${receipt.id}\t${receipt.status}\t${receipt.label}\tattempts=${receipt.attempts}`
    )
    .join("\n");
}

function receiptText(receipt: WatchReceipt): string {
  const lines = [
    `pi-until watch ${receipt.id}: ${receipt.status}`,
    `Kind: ${receipt.kind}`,
    `Label: ${receipt.label}`,
    `Checks: ${receipt.attempts}`,
  ];
  if (receipt.kind === "recurring") {
    lines.push(
      `Deliveries: ${receipt.deliveries}`,
      `Delivery pending: ${receipt.deliveryPending ? "yes" : "no"}`,
      `Missed ticks: ${receipt.missedTicks}`
    );
    if (receipt.quickRef !== undefined)
      lines.push(`Quick ref: ${receipt.quickRef}`);
    if (receipt.nextDueAt !== undefined)
      lines.push(`Next due: ${receipt.nextDueAt}`);
    if (receipt.expiresAt !== undefined)
      lines.push(`Expires: ${receipt.expiresAt}`);
  }
  if (receipt.reloads > 0) lines.push(`Survived reloads: ${receipt.reloads}`);
  if (receipt.lastExitCode !== undefined) {
    lines.push(`Last exit code: ${receipt.lastExitCode}`);
  }
  if (receipt.lastCheckKilled === true)
    lines.push("Last check was terminated.");
  if (receipt.defect !== undefined) lines.push(`Failure: ${receipt.defect}`);
  return lines.join("\n");
}

export default function piUntil(
  pi: ExtensionAPI,
  options: PiUntilOptions = {}
) {
  const watches = new Map<string, WatchRecord>();
  const terminalReceipts: WatchReceipt[] = [];
  let currentContext: ExtensionContext | undefined;
  let indicatorMounted = false;
  let requestIndicatorRender: (() => void) | undefined;
  let shuttingDown = false;
  let followUps: FollowUpActor;

  const clock = options.clock ?? systemClock;
  const shellRunner = createShellConditionRunner();
  const machine = createWatchMachine(shellRunner.run, clock);
  const telemetry =
    options.telemetry ??
    createTelemetrySink({
      ...telemetryOptionsFromEnv(process.env),
      now: () => clock.now(),
    });

  const track = telemetry.record;

  const activeWatches = () => [...watches.values()];

  const allReceipts = () => [
    ...activeWatches().map(toReceipt),
    ...terminalReceipts,
  ];

  const terminalReceiptFor = (id: string) =>
    terminalReceipts.find((receipt) => receipt.id === id);

  const restoreTerminalReceipts = (ctx: ExtensionContext): void => {
    const restored: WatchReceipt[] = [];
    const seen = new Set<string>();
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== "custom" || entry.customType !== "pi-until-finished") {
        continue;
      }
      if (!Value.Check(terminalReceiptSchema, entry.data)) continue;
      const receipt = entry.data as WatchReceipt;
      if (seen.has(receipt.id)) continue;
      seen.add(receipt.id);
      restored.push(receipt);
      if (restored.length >= MAX_TERMINAL_RECEIPTS) break;
    }
    terminalReceipts.push(...restored);
  };

  const orderedReceipts = () =>
    allReceipts().sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return (
        runningDifference ||
        Date.parse(right.startedAt) - Date.parse(left.startedAt)
      );
    });

  const orderedWatchDisplays = () =>
    [
      ...activeWatches().map(toWatchDisplay),
      ...terminalReceipts.map(displayFromReceipt),
    ].sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return runningDifference || right.startedAt - left.startedAt;
    });

  // refreshIndicator runs on every actor snapshot, including check ticks
  // that change nothing a listener can see. Only emit when the display
  // list actually differs from the last one emitted.
  let lastEmittedWatches: string | undefined;
  const emitWatches = () => {
    const display = activeWatches().map(toWatchDisplay);
    const serialized = JSON.stringify(display);
    if (serialized === lastEmittedWatches) return;
    lastEmittedWatches = serialized;
    pi.events.emit(WATCHES_EVENT, display);
  };

  const refreshIndicator = () => {
    emitWatches();
    const ctx = currentContext;
    if (ctx?.mode !== "tui") return;

    if (activeWatches().length === 0) {
      if (indicatorMounted) ctx.ui.setWidget(WIDGET_KEY, undefined);
      indicatorMounted = false;
      requestIndicatorRender = undefined;
      return;
    }

    if (!indicatorMounted) {
      indicatorMounted = true;
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const requestRender = () => tui.requestRender();
        requestIndicatorRender = requestRender;
        const refreshTimer = setInterval(requestRender, INDICATOR_REFRESH_MS);
        refreshTimer.unref();
        return {
          dispose() {
            clearInterval(refreshTimer);
            if (requestIndicatorRender === requestRender) {
              requestIndicatorRender = undefined;
            }
          },
          invalidate() {
            // Render reads live watch state and theme values.
          },
          render(width: number) {
            return renderWatchIndicator(
              activeWatches().map(toWatchDisplay),
              clock.now(),
              width,
              theme
            );
          },
        };
      });
      return;
    }

    requestIndicatorRender?.();
  };

  const enqueueTerminalFollowUp = (
    receipt: WatchReceipt,
    customType: string,
    content: string
  ) => {
    followUps.send({
      request: {
        content,
        customType,
        dedupeKey: `terminal:${receipt.id}:${receipt.status}`,
        details: receipt,
        id: randomUUID(),
        kind: "terminal",
        watchId: receipt.id,
      },
      type: "ENQUEUE",
    });
  };

  const finishWatch = (record: WatchRecord) => {
    const snapshot = record.actor.getSnapshot();
    const { definition, facts } = snapshot.context;
    if (watches.get(facts.id) !== record) return;

    const finishedAt = facts.finishedAt ?? clock.now();
    const receipt = {
      ...toReceipt(record),
      finishedAt: new Date(finishedAt).toISOString(),
    } satisfies WatchReceipt;
    watches.delete(facts.id);
    terminalReceipts.unshift(receipt);
    if (terminalReceipts.length > MAX_TERMINAL_RECEIPTS) {
      terminalReceipts.length = MAX_TERMINAL_RECEIPTS;
    }
    if (shuttingDown) return;
    followUps.send({ dedupeKey: `recurring:${facts.id}`, type: "DROP" });
    refreshIndicator();

    const conditionHash = hashCondition(gateOf(definition)?.command ?? "");
    void track(sessionId(currentContext), {
      attempts: receipt.attempts,
      conditionHash,
      deliveries: receipt.deliveries,
      durationMs: finishedAt - facts.startedAt,
      event: "finished",
      id: receipt.id,
      lastCheckKilled: receipt.lastCheckKilled,
      lastExitCode: receipt.lastExitCode,
      missedTicks: receipt.missedTicks,
      reloads: receipt.reloads,
      status: finalReceiptStatus(record),
      wake: receipt.wake,
      watchKind: receipt.kind,
    });
    if (receipt.status === "cancelled") return;
    pi.appendEntry("pi-until-finished", receipt);

    if (definition.kind === "recurring") {
      if (receipt.status === "expired") {
        enqueueTerminalFollowUp(
          receipt,
          "pi-until-recurring",
          renderRecurringExpiredPacket(definition.snapshot, {
            delivery: facts.deliveries,
            expiresAt: definition.expiresAt,
            id: facts.id,
            missedTicks: facts.missedTicks,
            reloads: facts.reloads,
          })
        );
      } else if (receipt.status === "failed") {
        enqueueTerminalFollowUp(
          receipt,
          "pi-until-recurring",
          `The recurring watch failed. Inspect this receipt before deciding what to do.\n\n${receiptText(receipt)}`
        );
      }
      return;
    }

    if (
      receipt.status !== "succeeded" &&
      receipt.status !== "timedOut" &&
      receipt.status !== "failed"
    ) {
      return;
    }
    const plan = planCompletion(receipt.status, receipt.wake);
    if (plan.kind === "agent") {
      enqueueTerminalFollowUp(
        receipt,
        "pi-until",
        `${plan.instruction}\n\n${receiptText(receipt)}`
      );
    } else {
      currentContext?.ui.notify(
        `${definition.label}: ${plan.summary}`,
        plan.level
      );
    }
  };

  const dispatchFollowUp = (request: FollowUpRequest) => {
    if (shuttingDown) return;
    try {
      if (request.kind === "terminal") {
        pi.sendMessage(
          {
            content: request.content,
            customType: request.customType,
            details: { followUpId: request.id, receipt: request.details },
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
        return;
      }

      const record = watches.get(request.watchId);
      if (
        record === undefined ||
        !record.actor.getSnapshot().matches({ active: "duePending" })
      ) {
        followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
        return;
      }
      const { definition, facts } = record.actor.getSnapshot().context;
      if (definition.kind !== "recurring") {
        followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
        return;
      }
      const deliveredAt = request.dispatchedAt ?? clock.now();
      const plannedFacts = advanceAfterTick(
        {
          ...facts,
          deliveries: facts.deliveries + 1,
          deliveryPending: false,
        },
        definition.intervalMs,
        deliveredAt
      );
      const receipt = {
        ...toReceipt(record),
        deliveries: plannedFacts.deliveries,
        deliveryPending: false,
        missedTicks: plannedFacts.missedTicks,
        nextDueAt: new Date(plannedFacts.nextDueAt).toISOString(),
      } satisfies WatchReceipt;
      pi.sendMessage(
        {
          content: renderRecurringWakePacket(definition.snapshot, {
            deliveredAt,
            delivery: plannedFacts.deliveries,
            expiresAt: definition.expiresAt,
            id: facts.id,
            missedTicks: plannedFacts.missedTicks,
            nextDueAt: plannedFacts.nextDueAt,
            reloads: facts.reloads,
          }),
          customType: "pi-until-recurring",
          details: { followUpId: request.id, receipt },
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true }
      );
    } catch {
      followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
    }
  };

  const createSessionFollowUps = (
    sessionBusy: boolean,
    restored?: FollowUpSuspension
  ): FollowUpActor => {
    const actor = createActor(
      createFollowUpMachine({
        dispatch: dispatchFollowUp,
        dispatchAckMs: options.followUpDispatchAckMs,
        failed: (request) => {
          const record = watches.get(request.watchId);
          if (request.kind === "recurring" && record !== undefined) {
            record.actor.send({
              failure: {
                kind: "delivery",
                message: "Pi did not accept the follow-up message",
              },
              type: "DELIVERY_FAILED",
            });
            return;
          }
          currentContext?.ui.notify(
            `pi-until could not deliver follow-up for ${request.watchId}`,
            "error"
          );
        },
        isLive: (request) =>
          request.kind === "terminal" || watches.has(request.watchId),
        settled: (request) => {
          if (request.kind !== "recurring") return;
          watches
            .get(request.watchId)
            ?.actor.send({ at: clock.now(), type: "DELIVERY_SETTLED" });
        },
        started: (request) => {
          if (request.kind !== "recurring") return;
          watches.get(request.watchId)?.actor.send({
            at: request.dispatchedAt ?? clock.now(),
            type: "DELIVERY_STARTED",
          });
        },
        unacknowledged: (request) => {
          currentContext?.ui.notify(
            `pi-until is still waiting for Pi to start follow-up ${request.id}; its delivery queue is paused`,
            "warning"
          );
        },
        now: () => clock.now(),
      }),
      { clock, input: { restored, sessionBusy } }
    );
    actor.start();
    if (restored?.phase === "awaitingSettlement" && !sessionBusy) {
      actor.send({ type: "SESSION_SETTLED" });
    }
    return actor;
  };
  followUps = createSessionFollowUps(true);

  const suspendFollowUps = (actor: FollowUpActor): FollowUpSuspension => {
    const snapshot = actor.getSnapshot();
    const phase = snapshot.matches("awaitingSettlement")
      ? "awaitingSettlement"
      : snapshot.matches("awaitingStart") ||
          snapshot.matches("restoredAwaitingStart")
        ? "awaitingStart"
        : snapshot.matches("startUncertain")
          ? "startUncertain"
          : snapshot.context.sessionBusy
            ? "busy"
            : "ready";
    return {
      active: snapshot.context.active,
      phase,
      queue: [...snapshot.context.queue],
    };
  };

  const parseCommand = (
    params: UntilParameters,
    ctx: ExtensionContext
  ): UntilCommand =>
    parseUntilCommand(params, {
      cwd: ctx.cwd,
      entryId: ctx.sessionManager.getLeafId() ?? undefined,
      sessionId: sessionId(ctx),
      startedAt: clock.now(),
    });

  const startWatch = (
    command: StartWatchCommand,
    ctx: ExtensionContext
  ): WatchRecord => {
    followUps.send({
      type: ctx.isIdle() ? "SESSION_SETTLED" : "SESSION_BUSY",
    });
    if (ctx.mode === "print" || ctx.mode === "json") {
      throw new Error(
        "pi-until requires a long-lived interactive or RPC Pi process"
      );
    }
    if (activeWatches().length >= MAX_ACTIVE_WATCHES) {
      throw new Error(
        `pi-until allows at most ${MAX_ACTIVE_WATCHES} active watches`
      );
    }

    const id = randomUUID().slice(0, 8);
    const { definition, startedAt } = command;
    const input: WatchActorInput = {
      definition,
      facts: initialFacts(definition, id, startedAt),
    };
    const record = runWatch(input);
    const receipt = toReceipt(record);
    pi.appendEntry("pi-until-started", {
      receipt,
      snapshot:
        definition.kind === "recurring" ? definition.snapshot : undefined,
    });
    const gate = gateOf(definition);
    const conditionHash = hashCondition(gate?.command ?? "");
    void track(sessionId(ctx), {
      checkTimeoutMs: gate?.checkTimeoutMs ?? 0,
      conditionHash,
      event: "started",
      id,
      intervalMs: definition.intervalMs,
      label: definition.label,
      resumed: false,
      timeoutMs:
        definition.expiresAt === undefined
          ? undefined
          : definition.expiresAt - startedAt,
      wake: wakeOf(definition),
      watchKind: definition.kind,
    });
    return record;
  };

  /** Resume watches suspended by the previous extension instance on `/reload`. */
  const resumeWatches = (
    suspended: readonly PersistedWatch[],
    ctx: ExtensionContext
  ) => {
    for (const watch of suspended.slice(0, MAX_ACTIVE_WATCHES)) {
      if (watches.size >= MAX_ACTIVE_WATCHES) break;
      if (watches.has(watch.facts.id)) continue;
      const input = resumeInput(watch);
      runWatch(input);
      const gate = gateOf(input.definition);
      const conditionHash = hashCondition(gate?.command ?? "");
      void track(sessionId(ctx), {
        checkTimeoutMs: gate?.checkTimeoutMs ?? 0,
        conditionHash,
        event: "started",
        id: input.facts.id,
        intervalMs: input.definition.intervalMs,
        label: input.definition.label,
        resumed: true,
        timeoutMs:
          input.definition.expiresAt === undefined
            ? undefined
            : input.definition.expiresAt - input.facts.startedAt,
        wake: wakeOf(input.definition),
        watchKind: input.definition.kind,
      });
    }
    if (suspended.length > 0) {
      void track(sessionId(ctx), { count: suspended.length, event: "resumed" });
      ctx.ui.notify(
        `pi-until resumed ${suspended.length} watch${suspended.length === 1 ? "" : "es"} after reload`,
        "info"
      );
    }
  };

  /** Start one authoritative actor from a fresh or restored watch value. */
  const runWatch = (input: WatchActorInput): WatchRecord => {
    const actor = createActor(machine, { clock, input });
    const record: WatchRecord = { actor };
    watches.set(input.facts.id, record);

    actor.subscribe({
      error() {
        finishWatch(record);
      },
      next(snapshot) {
        if (snapshot.matches({ active: "duePending" })) {
          followUps.send({
            request: {
              dedupeKey: `recurring:${snapshot.context.facts.id}`,
              id: randomUUID(),
              kind: "recurring",
              watchId: snapshot.context.facts.id,
            },
            type: "ENQUEUE",
          });
        }
        if (
          terminalState(snapshot) !== undefined ||
          snapshot.status === "error"
        ) {
          finishWatch(record);
          return;
        }
        refreshIndicator();
      },
    });

    actor.start();
    refreshIndicator();
    return record;
  };

  const showWatchPanel = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(listText(orderedReceipts()), "info");
      return;
    }

    let offset = 0;
    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) => {
        const upKeys = keybindings.getKeys("tui.select.up").join("/");
        const downKeys = keybindings.getKeys("tui.select.down").join("/");
        const closeKeys = keybindings.getKeys("tui.select.cancel").join("/");
        const navigationHint = `${upKeys}/${downKeys} scroll · ${closeKeys} close`;
        const requestRender = () => tui.requestRender();
        const refreshTimer = setInterval(requestRender, 1_000);
        refreshTimer.unref();
        return {
          dispose() {
            clearInterval(refreshTimer);
          },
          handleInput(data: string) {
            const count = orderedWatchDisplays().length;
            const maximumOffset = Math.max(0, count - 1);
            if (keybindings.matches(data, "tui.select.up")) {
              offset = Math.max(0, offset - 1);
            } else if (keybindings.matches(data, "tui.select.down")) {
              offset = Math.min(maximumOffset, offset + 1);
            } else if (keybindings.matches(data, "tui.select.pageUp")) {
              offset = Math.max(0, offset - PANEL_PAGE_SIZE);
            } else if (keybindings.matches(data, "tui.select.pageDown")) {
              offset = Math.min(maximumOffset, offset + PANEL_PAGE_SIZE);
            } else if (
              keybindings.matches(data, "tui.select.cancel") ||
              keybindings.matches(data, "tui.select.confirm")
            ) {
              done(null);
              return;
            }
            requestRender();
          },
          invalidate() {
            // Render reads live watch state and theme values.
          },
          render(width: number) {
            return renderWatchPanel(
              orderedWatchDisplays(),
              clock.now(),
              width,
              offset,
              PANEL_PAGE_SIZE,
              navigationHint,
              theme
            );
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          margin: 1,
          maxHeight: "85%",
          minWidth: 56,
          width: "72%",
        },
      }
    );
  };

  pi.registerTool({
    description:
      "Start session-scoped shell-condition watches or recurring agent follow-ups. One session arbiter serializes every pi-until wake. Recurrences use fixed cadence, immutable task snapshots, explicit completion, and /reload-only restoration.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      const command = parseCommand(params, ctx);
      void track(sessionId(ctx), {
        action: command.action,
        event: "action",
        source: "tool",
      });
      if (command.action === "start" || command.action === "repeat") {
        const record = startWatch(command, ctx);
        const receipt = toReceipt(record);
        const { definition } = record.actor.getSnapshot().context;
        const timing =
          definition.kind === "until"
            ? `It will check immediately, then every ${definition.intervalMs / 1_000}s.`
            : `Its first wake is ${definition.first === "now" ? "after this turn" : receipt.nextDueAt}, then every ${definition.intervalMs / 1_000}s until ${receipt.expiresAt}.`;
        return {
          content: [
            {
              type: "text",
              text: `Started pi-until ${receipt.kind} watch ${receipt.id} (${receipt.label}). ${timing}`,
            },
          ],
          details: receipt,
        };
      }

      if (command.action === "list") {
        const receipts = allReceipts();
        return {
          content: [{ type: "text", text: listText(receipts) }],
          details: { watches: receipts },
        };
      }

      const record = watches.get(command.id);
      const historical = terminalReceiptFor(command.id);
      if (record === undefined) {
        if (historical === undefined) {
          throw new Error(`unknown pi-until watch: ${command.id}`);
        }
        return {
          content: [{ type: "text", text: receiptText(historical) }],
          details: historical,
        };
      }

      if (command.action === "complete") {
        const { definition } = record.actor.getSnapshot().context;
        if (definition.kind !== "recurring") {
          throw new Error("only recurring watches can be completed explicitly");
        }
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "COMPLETE" });
        }
        const receipt = toReceipt(record);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      if (command.action === "cancel") {
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "CANCEL" });
        }
        const receipt = toReceipt(record);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      const receipt = toReceipt(record);
      return {
        content: [{ type: "text", text: receiptText(receipt) }],
        details: receipt,
      };
    },
    label: "Until",
    name: "until",
    parameters: untilParameters,
    prepareArguments: prepareUntilArguments,
    promptGuidelines: [
      "Use until action=start when work should resume after a side-effect-free shell condition exits 0. Do not block bash with polling or sleep loops.",
      "Use until action=repeat when the same agent must do work on a fixed cadence. Supply timeoutSeconds, instruction, and quickRef.",
      "Treat contextRefs as opaque pointers. Read a target only when the recurring instruction requires it.",
      "Keep recurring snapshots short and secret-free. The instruction, quickRef, and contextRefs are immutable private session data.",
      "Call until action=complete only when the recurring goal is achieved. A finished agent turn is not completion.",
      "Call until action=cancel when recurring work should stop without success. Do not continue an expired or failed recurrence unless the user asks.",
      "Use a durable workload scheduler instead when work must survive Pi exit, session replacement, or reboot.",
    ],
    promptSnippet:
      "Watch a shell predicate or schedule serialized work in this live Pi session",
  });

  type CommandCompletion = {
    value: string;
    label: string;
    description: string;
  };

  const commandCompletions = (
    prefix: string,
    candidates: readonly CommandCompletion[],
  ) => {
    const query = prefix.trimStart().toLowerCase();
    const matches = candidates.filter((candidate) =>
      candidate.value.toLowerCase().startsWith(query),
    );
    return matches.length > 0 ? matches : null;
  };

  const activeIdCompletions = (
    action: "status" | "cancel" | "complete",
    prefix: string,
  ) =>
    commandCompletions(
      prefix,
      activeWatches()
        .filter(({ actor }) =>
          action !== "complete" ||
          actor.getSnapshot().context.definition.kind === "recurring",
        )
        .map(({ actor }) => {
          const receipt = toReceipt({ actor });
          return {
            value: `${action} ${receipt.id}`,
            label: `${receipt.id} · ${receipt.label}`,
            description: `${receipt.kind} ${receipt.status}`,
          };
        }),
    );

  const untilCommandCompletions = (prefix: string) => {
    const input = prefix.trimStart();
    if (input === "start" || input.startsWith("start ")) {
      return commandCompletions(prefix, [
        { value: "start test -f ", label: "test -f <path>", description: "Watch for a file" },
        { value: "start test -d ", label: "test -d <path>", description: "Watch for a directory" },
        { value: "start git diff --quiet", label: "git diff --quiet", description: "Watch for a clean worktree" },
      ]);
    }
    for (const action of ["status", "cancel", "complete"] as const) {
      if (input === action || input.startsWith(`${action} `)) {
        return activeIdCompletions(action, prefix);
      }
    }
    return commandCompletions(prefix, [
      { value: "start ", label: "start <condition>", description: "Start a shell-condition watch" },
      { value: "list", label: "list", description: "Open session watches" },
      { value: "status ", label: "status <id>", description: "Inspect a watch" },
      { value: "cancel ", label: "cancel <id>", description: "Cancel a watch" },
      { value: "complete ", label: "complete <id>", description: "Complete a recurring watch" },
      { value: "stats", label: "stats", description: "Summarize local usage telemetry" },
    ]);
  };

  const commandUsage =
    "Usage: /until <start <condition> | list | status <id> | cancel <id> | complete <id> | stats>";

  pi.registerCommand("until", {
    getArgumentCompletions: untilCommandCompletions,
    description:
      "[start <condition> | list | status <id> | cancel <id> | complete <id> | stats] — Manage session watches",
    handler: async (args, ctx) => {
      currentContext = ctx;
      const input = args.trim();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
      const action = match?.[1];
      const value = match?.[2] ?? "";

      if (!action) {
        ctx.ui.notify(commandUsage, "warning");
        return;
      }

      try {
        if (action === "start") {
          void track(sessionId(ctx), { action, event: "action", source: "command" });
          const command = parseCommand({ action, condition: value }, ctx);
          if (command.action !== "start") return;
          const receipt = toReceipt(startWatch(command, ctx));
          ctx.ui.notify(`Watching ${receipt.label} as ${receipt.id}`, "info");
          return;
        }

        if (action === "list") {
          if (value) throw new Error(commandUsage);
          void track(sessionId(ctx), { action, event: "action", source: "command" });
          await showWatchPanel(ctx);
          return;
        }

        if (action === "stats") {
          if (value) throw new Error(commandUsage);
          void track(sessionId(ctx), { action, event: "action", source: "command" });
          if (!telemetry.enabled) {
            ctx.ui.notify(
              "pi-until telemetry is disabled (set PI_UNTIL_TELEMETRY=1 to enable)",
              "warning",
            );
            return;
          }
          const events = await readTelemetry(telemetry.filePath);
          ctx.ui.notify(
            summaryText(summarizeTelemetry(events), telemetry.filePath),
            "info",
          );
          return;
        }

        if (action !== "status" && action !== "cancel" && action !== "complete") {
          throw new Error(commandUsage);
        }
        if (!value || /\s/.test(value)) throw new Error(commandUsage);
        void track(sessionId(ctx), { action, event: "action", source: "command" });

        const id = value;
        const record = watches.get(id);
        if (!record) {
          const historical = terminalReceiptFor(id);
          if (action === "status" && historical) {
            ctx.ui.notify(receiptText(historical), "info");
            return;
          }
          ctx.ui.notify(`Unknown pi-until watch: ${id}`, "warning");
          return;
        }

        if (action === "status") {
          ctx.ui.notify(receiptText(toReceipt(record)), "info");
          return;
        }
        if (action === "cancel") {
          if (receiptStatus(record) === "running") {
            record.actor.send({ type: "CANCEL" });
          }
          ctx.ui.notify(`Cancelled ${id}`, "info");
          return;
        }
        if (record.actor.getSnapshot().context.definition.kind !== "recurring") {
          ctx.ui.notify(`Watch ${id} is not recurring`, "warning");
          return;
        }
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "COMPLETE" });
        }
        ctx.ui.notify(`Completed ${id}`, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "SESSION_BUSY" });
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "SESSION_SETTLED" });
  });

  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (
      event.message.role !== "custom" ||
      !Value.Check(followUpMarkerSchema, event.message.details)
    ) {
      return;
    }
    followUps.send({
      id: event.message.details.followUpId,
      type: "MESSAGE_STARTED",
    });
  });

  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    const suspended =
      event.reason === "reload"
        ? suspendedSessionFrom(ctx.sessionManager.getBranch())
        : { watches: [] };
    if (event.reason === "reload" || shuttingDown) {
      followUps.stop();
      shuttingDown = false;
      followUps = createSessionFollowUps(!ctx.isIdle(), suspended.followUps);
    } else {
      followUps.send({
        type: ctx.isIdle() ? "SESSION_SETTLED" : "SESSION_BUSY",
      });
    }
    // Only a reload keeps the same process and session. new/resume/fork
    // replace the session, and a suspension entry from an earlier process
    // must never resurrect watches nobody is running.
    if (event.reason === "reload") {
      restoreTerminalReceipts(ctx);
      resumeWatches(suspended.watches, ctx);
    }
    refreshIndicator();
  });

  pi.on("session_shutdown", async (event) => {
    shuttingDown = true;
    const suspendedFollowUps = suspendFollowUps(followUps);
    followUps.stop();
    const active = activeWatches();
    try {
      if (event.reason === "reload") {
        const suspended = active.map((record) =>
          suspendWatch(record.actor.getSnapshot().context)
        );
        // Materialize the immutable machine value before handing it to Pi's
        // persistence boundary; some providers clone proxy values as {}.
        const persisted = JSON.parse(
          JSON.stringify(
            suspensionData(suspended, suspendedFollowUps, clock.now())
          )
        ) as ReturnType<typeof suspensionData>;
        // Written even when empty so the newest entry always wins.
        pi.appendEntry(SUSPENDED_ENTRY_TYPE, persisted);
        if (suspended.length > 0) {
          void track(sessionId(currentContext), {
            count: suspended.length,
            event: "suspended",
          });
        }
      }
    } finally {
      // Cleanup must run even when session persistence rejects the append.
      for (const record of active) {
        record.actor.send({ type: "CANCEL" });
      }
      await shellRunner.drain();
      for (const record of active) {
        record.actor.stop();
      }
      watches.clear();
      terminalReceipts.length = 0;
      currentContext?.ui.setWidget(WIDGET_KEY, undefined);
      indicatorMounted = false;
      requestIndicatorRender = undefined;
      currentContext = undefined;
    }
  });
}
