import { waitFor } from "./test-utils.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "bun:test";

import { runShellCondition } from "../../extensions/until/check.ts";

const tempDirectories: string[] = [];

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("shell condition runner", () => {
  it("returns a normal successful exit", async () => {
    const result = await runShellCondition(
      {
        checkTimeoutMs: 1_000,
        command: "true",
        cwd: process.cwd(),
      },
      new AbortController().signal
    );

    expect(result).toEqual({ code: 0, killed: false });
  });

  it("marks a per-check timeout as killed and unsuccessful", async () => {
    const result = await runShellCondition(
      {
        checkTimeoutMs: 20,
        command: "sleep 30",
        cwd: process.cwd(),
      },
      new AbortController().signal
    );

    expect(result).toEqual({ code: 1, killed: true });
  });

  it("does not spawn a command when the signal is already aborted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-aborted-"));
    tempDirectories.push(directory);
    const marker = join(directory, "marker");
    const controller = new AbortController();
    controller.abort();

    await expect(
      runShellCondition(
        {
          checkTimeoutMs: 1_000,
          command: `printf marker > ${JSON.stringify(marker)}`,
          cwd: directory,
        },
        controller.signal
      )
    ).resolves.toEqual({ code: 1, killed: true });
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "cleans up detached descendants when the shell exits normally",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-process-tree-"));
      const pidFile = join(directory, "child.pid");
      tempDirectories.push(directory);

      await expect(
        runShellCondition(
          {
            checkTimeoutMs: 10_000,
            command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; false`,
            cwd: directory,
          },
          new AbortController().signal
        )
      ).resolves.toEqual({ code: 1, killed: false });

      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      await waitFor(() => {
        expect(isAlive(childPid)).toBe(false);
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "force-kills SIGTERM-resistant descendants in the condition process group",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-process-tree-"));
      const pidFile = join(directory, "child.pid");
      tempDirectories.push(directory);
      const controller = new AbortController();
      const resultPromise = runShellCondition(
        {
          checkTimeoutMs: 10_000,
          command: `(trap '' TERM HUP; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          cwd: directory,
        },
        controller.signal
      );

      await waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
      });
      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      expect(isAlive(childPid)).toBe(true);

      controller.abort();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(isAlive(childPid)).toBe(true);

      await expect(resultPromise).resolves.toEqual({ code: 1, killed: true });
      await waitFor(() => {
        expect(isAlive(childPid)).toBe(false);
      });
    }
  );
});
