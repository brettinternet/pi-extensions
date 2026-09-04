export type DelegationState =
  | "queued"
  | "active"
  | "running"
  | "settled"
  | "failed";

export type JobState = "running" | "completed" | "failed" | "cancelled";

export interface TrackedJob {
  id: string;
  state: JobState;
}

export interface TrackedDelegation {
  id: string;
  request: string;
  state: DelegationState;
  pendingFinal: string;
  jobs: Map<string, TrackedJob>;
}

export interface WorkStatus {
  queued: number;
  active: number;
  failed: number;
}

export class ActivityTracker {
  readonly #delegations = new Map<string, TrackedDelegation>();
  readonly #queue: string[] = [];
  readonly #jobOwners = new Map<string, string>();
  #activeId: string | undefined;

  enqueue(id: string, request: string): TrackedDelegation | undefined {
    if (this.#delegations.has(id)) return undefined;
    const delegation: TrackedDelegation = {
      id,
      request,
      state: "queued",
      pendingFinal: "",
      jobs: new Map(),
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
    if (!delegation || delegation.state !== "queued") {
      return this.activateNext();
    }
    delegation.state = "active";
    this.#activeId = id;
    return delegation;
  }

  active(): TrackedDelegation | undefined {
    return this.#activeId
      ? this.#delegations.get(this.#activeId)
      : undefined;
  }

  setPendingFinal(text: string): void {
    const active = this.active();
    if (active) active.pendingFinal = text;
  }

  settleActive(): TrackedDelegation | undefined {
    const active = this.active();
    if (!active) return undefined;
    active.state = this.#hasRunningJobs(active) ? "running" : "settled";
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

  associateJob(jobId: string): TrackedDelegation | undefined {
    const active = this.active();
    if (!active || this.#jobOwners.has(jobId)) return undefined;
    active.jobs.set(jobId, { id: jobId, state: "running" });
    this.#jobOwners.set(jobId, active.id);
    return active;
  }

  completeJob(
    jobId: string,
    state: Exclude<JobState, "running">,
  ): TrackedDelegation | undefined {
    const ownerId = this.#jobOwners.get(jobId);
    if (!ownerId) return undefined;
    const owner = this.#delegations.get(ownerId);
    const job = owner?.jobs.get(jobId);
    if (!owner || !job || job.state !== "running") return undefined;
    job.state = state;
    if (owner.state === "running" && !this.#hasRunningJobs(owner)) {
      owner.state = this.#allJobsCompleted(owner) ? "settled" : "failed";
    }
    return owner;
  }

  get(id: string): TrackedDelegation | undefined {
    return this.#delegations.get(id);
  }

  ownsRunningJob(jobId: string): boolean {
    const ownerId = this.#jobOwners.get(jobId);
    return ownerId !== undefined &&
      this.#delegations.get(ownerId)?.jobs.get(jobId)?.state === "running";
  }

  status(): WorkStatus {
    let queued = 0;
    let active = 0;
    let failed = 0;
    for (const delegation of this.#delegations.values()) {
      if (delegation.state === "queued") queued += 1;
      if (delegation.state === "active" || delegation.state === "running") {
        active += 1;
      }
      if (delegation.state === "failed") failed += 1;
    }
    return { queued, active, failed };
  }

  #hasRunningJobs(delegation: TrackedDelegation): boolean {
    for (const job of delegation.jobs.values()) {
      if (job.state === "running") return true;
    }
    return false;
  }

  #allJobsCompleted(delegation: TrackedDelegation): boolean {
    for (const job of delegation.jobs.values()) {
      if (job.state !== "completed") return false;
    }
    return true;
  }
}
