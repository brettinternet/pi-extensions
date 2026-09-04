import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildWorkbenchArguments,
  type Exec,
  WorkbenchClient,
} from "../../extensions/workbench/client.ts";

describe("workbench arguments", () => {
  test("builds an editor request with an exact location", () => {
    expect(buildWorkbenchArguments({
      action: "editor.open",
      path: "src/index.ts",
      line: 12,
      column: 7,
      cwd: "/repo",
      placement: "right",
      focus: true,
    })).toEqual([
      "editor",
      "open",
      "src/index.ts",
      "--line",
      "12",
      "--column",
      "7",
      "--cwd",
      "/repo",
      "--placement",
      "right",
      "--focus",
    ]);
  });

  test("preserves command argv without shell interpolation", () => {
    expect(buildWorkbenchArguments({
      action: "job.start",
      cwd: "/repo",
      placement: "down",
      command: ["printf", "%s", "hello world; untouched"],
    })).toEqual([
      "job",
      "start",
      "--cwd",
      "/repo",
      "--placement",
      "down",
      "--no-focus",
      "--",
      "printf",
      "%s",
      "hello world; untouched",
    ]);
  });

  test("serializes force only for close actions", () => {
    expect(buildWorkbenchArguments({ action: "editor.close", force: true })).toEqual([
      "editor",
      "close",
      "--force",
    ]);
    expect(buildWorkbenchArguments({ action: "editor.close", force: false })).toEqual([
      "editor",
      "close",
    ]);
    expect(buildWorkbenchArguments({ action: "job.close", jobId: "job-1", force: true })).toEqual([
      "job",
      "close",
      "job-1",
      "--force",
    ]);
    expect(buildWorkbenchArguments({ action: "job.close", jobId: "job-1" })).toEqual([
      "job",
      "close",
      "job-1",
    ]);
    expect(() => buildWorkbenchArguments({ action: "job.start", force: true, command: ["echo", "ok"] }))
      .toThrow("force is only supported for editor.close and job.close");
    expect(() => buildWorkbenchArguments({ action: "lazygit.close", force: false }))
      .toThrow("force is only supported for editor.close and job.close");
  });

  test("requires action-specific identifiers", () => {
    expect(() => buildWorkbenchArguments({ action: "job.read" })).toThrow("jobId is required");
    expect(() => buildWorkbenchArguments({ action: "pane.focus" })).toThrow("paneId is required");
  });
});

describe("workbench client", () => {
  test("discovers the enabled plugin and pins its ID for direct execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workbench-"));
    await writeFile(join(root, "workbench.py"), "# test\n");
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: Exec = async (command, args) => {
      calls.push({ command, args });
      if (command === "herdr") {
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            result: { plugins: [{ enabled: true, plugin_root: root }] },
          }),
        };
      }
      return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify({ ok: true, action: "layout.show" }),
      };
    };

    const response = await new WorkbenchClient(exec).execute({ action: "layout" }, "/repo");

    expect(response.action).toBe("layout.show");
    expect(calls[1]).toEqual({
      command: "env",
      args: [
        "HERDR_PLUGIN_ID=brettinternet.workbench",
        "python3",
        join(root, "workbench.py"),
        "layout",
      ],
    });
  });

  test("surfaces structured controller errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workbench-"));
    await writeFile(join(root, "workbench.py"), "# test\n");
    const exec: Exec = async (command) => command === "herdr"
      ? {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify({ result: { plugins: [{ enabled: true, plugin_root: root }] } }),
      }
      : {
        code: 1,
        killed: false,
        stdout: "",
        stderr: JSON.stringify({ ok: false, error: { message: "not in Herdr" } }),
      };

    await expect(
      new WorkbenchClient(exec).execute({ action: "layout" }, "/repo"),
    ).rejects.toThrow("not in Herdr");
  });
});
