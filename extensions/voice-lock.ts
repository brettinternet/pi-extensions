import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOCK_DIRECTORY = join(homedir(), ".pi", "pi-live-codex.lock");
const OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_STALE_MS = 5_000;

interface VoiceLockOwner {
  pid: number;
  sessionId: string;
  startedAt: string;
  token: string;
}

export class VoiceLockHeldError extends Error {
  readonly owner: VoiceLockOwner | undefined;

  constructor(owner?: VoiceLockOwner) {
    const detail = owner
      ? ` (PID ${owner.pid}, session ${owner.sessionId})`
      : "";
    super(
      `Voice mode is already active in another Pi session${detail}. Stop it there before starting /live here.`,
    );
    this.name = "VoiceLockHeldError";
    this.owner = owner;
  }
}

export class VoiceLock {
  readonly #directory: string;
  readonly #token: string;
  #released = false;

  constructor(directory: string, token: string) {
    this.#directory = directory;
    this.#token = token;
  }

  release(): void {
    if (this.#released) return;
    const owner = readOwner(this.#directory);
    if (owner && owner.token !== this.#token) {
      this.#released = true;
      return;
    }
    try {
      unlinkSync(join(this.#directory, OWNER_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      rmdirSync(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#released = true;
  }
}

function readOwner(directory: string): VoiceLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(directory, OWNER_FILE), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !("sessionId" in value) ||
      typeof value.sessionId !== "string" ||
      !("startedAt" in value) ||
      typeof value.startedAt !== "string" ||
      !("token" in value) ||
      typeof value.token !== "string"
    ) {
      return undefined;
    }
    return value as VoiceLockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function incompleteLockIsRecent(directory: string): boolean {
  try {
    return Date.now() - statSync(directory).mtimeMs < INCOMPLETE_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function discardStaleLock(directory: string, token: string): boolean {
  const staleDirectory = `${directory}.stale-${token}`;
  try {
    renameSync(directory, staleDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    unlinkSync(join(staleDirectory, OWNER_FILE));
  } catch {}
  try {
    rmdirSync(staleDirectory);
  } catch {}
  return true;
}

export function acquireVoiceLock(
  sessionId: string,
  directory = LOCK_DIRECTORY,
): VoiceLock {
  const token = crypto.randomUUID();
  mkdirSync(dirname(directory), { recursive: true });

  for (;;) {
    try {
      mkdirSync(directory);
      const owner: VoiceLockOwner = {
        pid: process.pid,
        sessionId,
        startedAt: new Date().toISOString(),
        token,
      };
      try {
        writeFileSync(
          join(directory, OWNER_FILE),
          `${JSON.stringify(owner)}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        try {
          rmdirSync(directory);
        } catch {}
        throw error;
      }
      return new VoiceLock(directory, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = readOwner(directory);
    if (
      (owner && processIsAlive(owner.pid)) ||
      (!owner && incompleteLockIsRecent(directory))
    ) {
      throw new VoiceLockHeldError(owner);
    }
    discardStaleLock(directory, token);
  }
}
