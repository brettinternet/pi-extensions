import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { Value } from "typebox/value";

import {
  initialFacts,
  watchDefinitionSchema,
} from "../../extensions/until/domain.ts";
import type {
  RecurringDefinition,
  UntilDefinition,
  WatchContext,
} from "../../extensions/until/domain.ts";
import type { FollowUpSuspension } from "../../extensions/until/follow-up.ts";
import {
  SUSPENDED_ENTRY_TYPE,
  SUSPENSION_VERSION,
  resumeInput,
  suspendWatch,
  suspendedSessionFrom,
  suspendedWatchesFrom,
  suspensionData,
} from "../../extensions/until/suspension.ts";

const untilDefinition: UntilDefinition = {
  expiresAt: 61_000,
  gate: {
    checkTimeoutMs: 1_000,
    command: "test -f ready",
    cwd: "/tmp",
  },
  intervalMs: 500,
  kind: "until",
  label: "ready",
  wake: "agent",
};

const recurringDefinition: RecurringDefinition = {
  expiresAt: 100_000,
  first: "afterInterval",
  intervalMs: 10_000,
  kind: "recurring",
  label: "follow up",
  snapshot: {
    capturedAt: 1_000,
    contextRefs: [{ label: "Runbook", target: "docs/runbook.md" }],
    instruction: "Inspect the deployment.",
    origin: { entryId: "e1", sessionId: "s1" },
    quickRef: "release verification",
  },
};

const context = (
  definition: UntilDefinition | RecurringDefinition
): WatchContext => ({
  definition,
  facts: {
    ...initialFacts(definition, "abc12345", 1_000),
    attempts: 7,
    deliveries: definition.kind === "recurring" ? 2 : 0,
    reloads: 1,
  },
});

const emptyFollowUps: FollowUpSuspension = {
  phase: "ready",
  queue: [],
};

const custom = (
  customType: string,
  data: CustomEntry["data"]
): SessionEntry => ({
  customType,
  data,
  id: "x",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "custom",
});

describe("suspension", () => {
  it("round-trips normalized watch values and increments reload history", () => {
    const persisted = suspendWatch(context(recurringDefinition));
    expect(persisted).toMatchObject({
      definition: recurringDefinition,
      facts: { attempts: 7, deliveries: 2, reloads: 2 },
    });
    expect(resumeInput(persisted)).toEqual({
      definition: recurringDefinition,
      facts: persisted.facts,
    });
  });

  it("takes only the newest versioned suspension entry on the branch", () => {
    const older = suspensionData(
      [suspendWatch(context(untilDefinition))],
      emptyFollowUps,
      5_000
    );
    const newer = suspensionData([], emptyFollowUps, 6_000);
    expect(newer.v).toBe(SUSPENSION_VERSION);
    expect(
      suspendedWatchesFrom([
        custom(SUSPENDED_ENTRY_TYPE, older),
        custom("other", { watches: [{ id: "nope" }] }),
        custom(SUSPENDED_ENTRY_TYPE, newer),
      ])
    ).toEqual([]);
    expect(
      suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, older)])
    ).toHaveLength(1);
    expect(
      suspendedSessionFrom([custom(SUSPENDED_ENTRY_TYPE, older)]).followUps
    ).toEqual(emptyFollowUps);
  });

  it("restores version 2 watch state without delivery state", () => {
    const current = suspensionData(
      [suspendWatch(context(untilDefinition))],
      emptyFollowUps,
      5_000
    );
    const previous = {
      suspendedAt: current.suspendedAt,
      v: 2,
      watches: current.watches,
    };

    expect(
      suspendedSessionFrom([custom(SUSPENDED_ENTRY_TYPE, previous)])
    ).toEqual({ watches: current.watches });
  });

  it("rejects malformed newest data instead of trusting older facts", () => {
    const valid = suspensionData(
      [suspendWatch(context(untilDefinition))],
      emptyFollowUps,
      5_000
    );
    expect(
      suspendedWatchesFrom([
        custom(SUSPENDED_ENTRY_TYPE, valid),
        custom(SUSPENDED_ENTRY_TYPE, { v: 2, watches: [{ id: 1 }] }),
      ])
    ).toEqual([]);
    expect(suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, null)])).toEqual(
      []
    );
    expect(suspendedWatchesFrom([])).toEqual([]);
  });

  it("rejects oversized suspension data and labels beyond the public bound", () => {
    const persisted = suspendWatch(context(untilDefinition));
    const oversized = suspensionData(
      Array.from({ length: 33 }, () => persisted),
      emptyFollowUps,
      5_000,
    );
    expect(suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, oversized)])).toEqual([]);
    expect(
      Value.Check(watchDefinitionSchema, {
        ...untilDefinition,
        label: "x".repeat(121),
      }),
    ).toBe(false);
  });

  it("normalizes legacy reload entries without extending their deadline", () => {
    const [watch] = suspendedWatchesFrom([
      custom(SUSPENDED_ENTRY_TYPE, {
        suspendedAt: "1970-01-01T00:00:05.000Z",
        watches: [
          {
            attempts: 4,
            checkTimeoutMs: 1_000,
            command: "test -f ready",
            cwd: "/tmp",
            id: "legacy",
            intervalMs: 500,
            label: "legacy",
            reloads: 2,
            startedAt: 1_000,
            timeoutMs: 60_000,
            wake: "agent",
          },
        ],
      }),
    ]);

    expect(watch).toMatchObject({
      definition: {
        expiresAt: 61_000,
        gate: { command: "test -f ready" },
        kind: "until",
      },
      facts: {
        attempts: 4,
        id: "legacy",
        nextDueAt: 5_000,
        reloads: 2,
        startedAt: 1_000,
      },
    });
  });
});
