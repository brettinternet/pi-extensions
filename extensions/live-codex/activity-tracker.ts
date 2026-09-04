import type {
  BackgroundActivityFinished,
  BackgroundActivityOutcome,
  BackgroundActivityStarted,
} from "./background-activity.ts";

export type DelegationState =
  | "queued"
  | "active"
  | "running"
  | "settled"
  | "failed";

export interface TrackedActivity extends BackgroundActivityStarted {
  state: "running" | BackgroundActivityOutcome;
  outcome?: BackgroundActivityOutcome;
  summary?: string;
}

export interface TrackedDelegation {
  id: string;
  request: string;
  state: DelegationState;
  pendingFinal: string;
  activities: Map<string, TrackedActivity>;
}

export interface WorkStatus {
  queued: number;
  active: number;
  failed: number;
}

export interface ActivityStartResult {
  activity: TrackedActivity;
  owner?: TrackedDelegation;
  bufferedFinish?: BackgroundActivityFinished;
}

export interface ActivityFinishResult {
  activity: TrackedActivity;
  owner?: TrackedDelegation;
}

export function activityKey(provider: string, activityId: string): string {
  return `${provider}\u0000${activityId}`;
}

export class ActivityTracker {
  readonly #delegations = new Map<string, TrackedDelegation>();
  readonly #queue: string[] = [];
  readonly #originOwners = new Map<string, string>();
  readonly #activityOwners = new Map<string, string>();
  readonly #activities = new Map<string, TrackedActivity>();
  readonly #pendingFinishes = new Map<string, BackgroundActivityFinished>();
  #activeId: string | undefined;

  enqueue(id: string, request: string): TrackedDelegation | undefined {
    if (this.#delegations.has(id)) return undefined;
    const delegation: TrackedDelegation = {
      id,
      request,
      state: "queued",
      pendingFinal: "",
      activities: new Map(),
    };
    this.#delegations.set(id, delegation);
    this.#queue.push(id);
    return delegation;
  }

  activateNext(): TrackedDelegation | undefined {
    if (this.#activeId) return undefined;
    const id = this.#queue.shift();
    if (!id) return undefined;
    const delegation = this.#delegations.get(id);
    if (!delegation || delegation.state !== "queued") return this.activateNext();
    delegation.state = "active";
    this.#activeId = id;
    return delegation;
  }

  active(): TrackedDelegation | undefined {
    return this.#activeId ? this.#delegations.get(this.#activeId) : undefined;
  }

  correlateToolCall(originId: string): boolean {
    const active = this.active();
    if (!active || this.#originOwners.has(originId)) return false;
    this.#originOwners.set(originId, active.id);
    return true;
  }

  setPendingFinal(text: string): void {
    const active = this.active();
    if (active) active.pendingFinal = text;
  }

  settleActive(): TrackedDelegation | undefined {
    const active = this.active();
    if (!active) return undefined;
    active.state = this.#hasRunningActivities(active) ? "running" : "settled";
    this.#activeId = undefined;
    return active;
  }

  failActive(): TrackedDelegation | undefined {
    const active = this.active();
    if (!active) return undefined;
    active.state = "failed";
    this.#activeId = undefined;
    return active;
  }

  startActivity(started: BackgroundActivityStarted): ActivityStartResult | undefined {
    const key = activityKey(started.provider, started.activityId);
    if (this.#activities.has(key)) return undefined;
    const ownerId = started.originId
      ? this.#originOwners.get(started.originId)
      : undefined;
    if (!ownerId && started.resumed !== true) return undefined;
    const owner = ownerId ? this.#delegations.get(ownerId) : undefined;
    if (ownerId && !owner) return undefined;
    const activity: TrackedActivity = { ...started, state: "running" };
    this.#activities.set(key, activity);
    if (owner) {
      owner.activities.set(key, activity);
      this.#activityOwners.set(key, owner.id);
      if (owner.state === "settled") owner.state = "running";
    }
    const bufferedFinish = this.#pendingFinishes.get(key);
    if (bufferedFinish) this.#pendingFinishes.delete(key);
    return { activity, ...(owner ? { owner } : {}), ...(bufferedFinish ? { bufferedFinish } : {}) };
  }

  finishActivity(finished: BackgroundActivityFinished): ActivityFinishResult | undefined {
    const key = activityKey(finished.provider, finished.activityId);
    const activity = this.#activities.get(key);
    if (!activity) {
      if (!this.#pendingFinishes.has(key) && this.#pendingFinishes.size < 100) {
        this.#pendingFinishes.set(key, finished);
      }
      return undefined;
    }
    if (activity.state !== "running") return undefined;
    if (activity.kind !== finished.kind ||
      activity.sessionId !== finished.sessionId ||
      activity.sessionFile !== finished.sessionFile ||
      activity.workspaceId !== finished.workspaceId) return undefined;
    activity.state = finished.outcome;
    activity.outcome = finished.outcome;
    activity.summary = finished.summary;
    const ownerId = this.#activityOwners.get(key);
    const owner = ownerId ? this.#delegations.get(ownerId) : undefined;
    if (owner?.state === "running" && !this.#hasRunningActivities(owner)) {
      owner.state = this.#allActivitiesSucceeded(owner) ? "settled" : "failed";
    }
    return { activity, ...(owner ? { owner } : {}) };
  }

  get(id: string): TrackedDelegation | undefined {
    return this.#delegations.get(id);
  }

  getActivity(provider: string, activityId: string): TrackedActivity | undefined {
    return this.#activities.get(activityKey(provider, activityId));
  }

  findRunningActivity(activityId: string, provider?: string): TrackedActivity | undefined {
    if (provider) {
      const activity = this.getActivity(provider, activityId);
      return activity?.state === "running" ? activity : undefined;
    }
    const matches = [...this.#activities.values()].filter(
      (activity) => activity.activityId === activityId && activity.state === "running",
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  status(): WorkStatus {
    let queued = 0;
    let active = 0;
    let failed = 0;
    for (const delegation of this.#delegations.values()) {
      if (delegation.state === "queued") queued += 1;
      if (delegation.state === "active" || delegation.state === "running") active += 1;
      if (delegation.state === "failed") failed += 1;
    }
    for (const [key, activity] of this.#activities) {
      if (!this.#activityOwners.has(key) && activity.state === "running") active += 1;
      if (!this.#activityOwners.has(key) && activity.state === "failed") failed += 1;
    }
    return { queued, active, failed };
  }

  #hasRunningActivities(delegation: TrackedDelegation): boolean {
    return [...delegation.activities.values()].some(({ state }) => state === "running");
  }

  #allActivitiesSucceeded(delegation: TrackedDelegation): boolean {
    return [...delegation.activities.values()].every(({ state }) => state === "succeeded");
  }
}
