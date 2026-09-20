import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { watchDefinitionSchema, watchFactsSchema } from "./domain.ts";
import type {
  WatchActorInput,
  WatchContext,
  WatchDefinition,
  WatchFacts,
} from "./domain.ts";
import type { FollowUpSuspension } from "./follow-up.ts";

export const SUSPENDED_ENTRY_TYPE = "pi-until-suspended";
export const SUSPENSION_VERSION = 3;
export const MAX_ACTIVE_WATCHES = 32;
const MAX_FOLLOW_UP_REQUESTS = 82;

const persistedWatchSchema = Type.Object(
  {
    definition: watchDefinitionSchema,
    facts: watchFactsSchema,
  },
  { additionalProperties: false }
);

const followUpRequestBase = {
  dedupeKey: Type.String({ minLength: 1, maxLength: 256 }),
  id: Type.String({ minLength: 1, maxLength: 128 }),
  watchId: Type.String({ minLength: 1, maxLength: 128 }),
};

const followUpRequestSchema = Type.Union([
  Type.Object(
    {
      ...followUpRequestBase,
      dispatchedAt: Type.Optional(Type.Number()),
      kind: Type.Literal("recurring"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...followUpRequestBase,
      content: Type.String({ maxLength: 50_000 }),
      customType: Type.String({ minLength: 1, maxLength: 120 }),
      details: Type.Unknown(),
      kind: Type.Literal("terminal"),
    },
    { additionalProperties: false }
  ),
]);

const followUpPhaseSchema = Type.Union([
  Type.Literal("awaitingSettlement"),
  Type.Literal("awaitingStart"),
  Type.Literal("busy"),
  Type.Literal("ready"),
  Type.Literal("startUncertain"),
]);

const followUpSuspensionSchema = Type.Object(
  {
    active: Type.Optional(followUpRequestSchema),
    phase: followUpPhaseSchema,
    queue: Type.Array(followUpRequestSchema, {
      maxItems: MAX_FOLLOW_UP_REQUESTS,
    }),
  },
  { additionalProperties: false }
);

const suspensionDataSchema = Type.Object(
  {
    followUps: followUpSuspensionSchema,
    suspendedAt: Type.String(),
    v: Type.Literal(SUSPENSION_VERSION),
    watches: Type.Array(persistedWatchSchema, { maxItems: MAX_ACTIVE_WATCHES }),
  },
  { additionalProperties: false }
);

const versionTwoSuspensionDataSchema = Type.Object(
  {
    suspendedAt: Type.String(),
    v: Type.Literal(2),
    watches: Type.Array(persistedWatchSchema, { maxItems: MAX_ACTIVE_WATCHES }),
  },
  { additionalProperties: false }
);

const legacyWatchSchema = Type.Object({
  attempts: Type.Number(),
  checkTimeoutMs: Type.Number(),
  command: Type.String(),
  cwd: Type.String(),
  id: Type.String(),
  intervalMs: Type.Number(),
  label: Type.String({ maxLength: 120 }),
  reloads: Type.Number(),
  startedAt: Type.Number(),
  timeoutMs: Type.Optional(Type.Number()),
  wake: Type.Union([Type.Literal("agent"), Type.Literal("notify")]),
});

const legacySuspensionDataSchema = Type.Object({
  suspendedAt: Type.String(),
  watches: Type.Array(legacyWatchSchema, { maxItems: MAX_ACTIVE_WATCHES }),
});

export interface PersistedWatch {
  readonly definition: WatchDefinition;
  readonly facts: WatchFacts;
}

export interface SuspensionData {
  readonly followUps: FollowUpSuspension;
  readonly suspendedAt: string;
  readonly v: typeof SUSPENSION_VERSION;
  readonly watches: readonly PersistedWatch[];
}

export interface SuspendedSession {
  readonly followUps?: FollowUpSuspension;
  readonly watches: readonly PersistedWatch[];
}

type LegacyWatch = Static<typeof legacyWatchSchema>;

const plainDefinition = (definition: WatchDefinition): WatchDefinition =>
  definition.kind === "until"
    ? {
        ...definition,
        gate: { ...definition.gate },
      }
    : {
        ...definition,
        gate: definition.gate === undefined ? undefined : { ...definition.gate },
        snapshot: {
          ...definition.snapshot,
          contextRefs: definition.snapshot.contextRefs.map((reference) => ({
            ...reference,
          })),
          origin: { ...definition.snapshot.origin },
        },
      };

export const suspendWatch = (context: WatchContext): PersistedWatch => ({
  definition: plainDefinition(context.definition),
  facts: {
    ...context.facts,
    ...(context.facts.lastResult === undefined
      ? {}
      : { lastResult: { ...context.facts.lastResult } }),
    ...(context.facts.failure === undefined
      ? {}
      : { failure: { ...context.facts.failure } }),
    reloads: context.facts.reloads + 1,
  },
});

export const suspensionData = (
  watches: readonly PersistedWatch[],
  followUps: FollowUpSuspension,
  now: number
): SuspensionData => ({
  followUps: {
    active: followUps.active,
    phase: followUps.phase,
    queue: [...followUps.queue],
  },
  suspendedAt: new Date(now).toISOString(),
  v: SUSPENSION_VERSION,
  watches: [...watches],
});

const normalizeLegacyWatch = (
  watch: LegacyWatch,
  suspendedAt: number
): PersistedWatch => {
  const base: WatchDefinition = {
    gate: {
      checkTimeoutMs: watch.checkTimeoutMs,
      command: watch.command,
      cwd: watch.cwd,
    },
    intervalMs: watch.intervalMs,
    kind: "until",
    label: watch.label,
    wake: watch.wake,
  };
  const definition: WatchDefinition =
    watch.timeoutMs === undefined
      ? base
      : { ...base, expiresAt: watch.startedAt + watch.timeoutMs };
  const facts: WatchFacts = {
    attempts: watch.attempts,
    deliveries: 0,
    deliveryPending: false,
    id: watch.id,
    missedTicks: 0,
    nextDueAt: suspendedAt,
    reloads: watch.reloads,
    startedAt: watch.startedAt,
  };
  return { definition, facts };
};

/**
 * The newest suspension entry on the branch is the only authority. Version 1
 * entries are normalized at this boundary; malformed newest entries resolve
 * to an empty set instead of reviving older facts.
 */
export const suspendedSessionFrom = (
  entries: readonly SessionEntry[]
): SuspendedSession => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SUSPENDED_ENTRY_TYPE) {
      continue;
    }
    if (Value.Check(suspensionDataSchema, entry.data)) {
      return {
        followUps: entry.data.followUps as FollowUpSuspension,
        watches: entry.data.watches,
      };
    }
    if (Value.Check(versionTwoSuspensionDataSchema, entry.data)) {
      return { watches: entry.data.watches };
    }
    if (Value.Check(legacySuspensionDataSchema, entry.data)) {
      const suspendedAt = Date.parse(entry.data.suspendedAt);
      const normalizedAt = Number.isFinite(suspendedAt) ? suspendedAt : 0;
      return {
        watches: entry.data.watches.map((watch) =>
          normalizeLegacyWatch(watch, normalizedAt)
        ),
      };
    }
    return { watches: [] };
  }
  return { watches: [] };
};

export const suspendedWatchesFrom = (
  entries: readonly SessionEntry[]
): readonly PersistedWatch[] => suspendedSessionFrom(entries).watches;

export const resumeInput = (watch: PersistedWatch): WatchActorInput => ({
  definition: watch.definition,
  facts: watch.facts,
});
