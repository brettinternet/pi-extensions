import { spawn } from "node:child_process";

import type {
  RunUntilCheck,
  UntilCheckInput,
  UntilCheckResult,
} from "./machine.ts";

const FORCE_KILL_DELAY_MS = 1_000;

function processTreeTarget(pid: number): number {
  return process.platform === "win32" ? pid : -pid;
}

function processTreeExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(processTreeTarget(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals
): void {
  if (pid === undefined) return;
  try {
    process.kill(processTreeTarget(pid), signal);
  } catch {
    // The process tree already exited.
  }
}

const executeShellCondition: RunUntilCheck = async (
  input: UntilCheckInput,
  signal: AbortSignal
): Promise<UntilCheckResult> =>
  new Promise((resolve, reject) => {
    // Abort can race with actor teardown. Do not spawn a process once the
    // caller has already cancelled this check.
    if (signal.aborted) {
      resolve({ code: 1, killed: true });
      return;
    }

    const child = spawn(input.command, [], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell:
        process.platform === "win32" ? true : process.env.SHELL || "/bin/sh",
      stdio: "ignore",
    });

    let killed = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      clearTimeout(checkTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      signal.removeEventListener("abort", terminate);
    }

    function settle(result: UntilCheckResult) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    }

    function settleAfterTreeCleanup(result: UntilCheckResult) {
      if (!processTreeExists(child.pid)) {
        settle(result);
        return;
      }
      signalProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child.pid, "SIGKILL");
        forceKillTimer = undefined;
        settle(result);
      }, FORCE_KILL_DELAY_MS);
    }

    function terminate() {
      if (settled || killed) return;
      killed = true;
      settleAfterTreeCleanup({ code: 1, killed: true });
    }

    const checkTimer = setTimeout(terminate, input.checkTimeoutMs);
    signal.addEventListener("abort", terminate, { once: true });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("exit", (code) => {
      if (killed) return;
      // Shells can exit while detached background children remain alive. Reap
      // that process group before resolving so polling never leaks commands.
      settleAfterTreeCleanup({
        code: code ?? 1,
        killed: false,
      });
    });
  });

export interface ShellConditionRunner {
  readonly drain: () => Promise<void>;
  readonly run: RunUntilCheck;
}

export const createShellConditionRunner = (): ShellConditionRunner => {
  const active = new Set<Promise<UntilCheckResult>>();

  const run: RunUntilCheck = (input, signal) => {
    const task = executeShellCondition(input, signal);
    active.add(task);
    void (async () => {
      try {
        await task;
      } catch {
        // The caller receives the original rejection.
      } finally {
        active.delete(task);
      }
    })();
    return task;
  };

  const drain = async (): Promise<void> => {
    await Promise.allSettled(active);
  };

  return { drain, run };
};

const defaultRunner = createShellConditionRunner();
export const runShellCondition = defaultRunner.run;
