import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts, matchingPrompts, parseSession, type Prompt } from "../../extensions/prompt-history/history.ts";
import registerPromptHistory, { HistoryPicker } from "../../extensions/prompt-history/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const created: string[] = [];
afterEach(async () => {
  for (const root of created.splice(0)) {
    await unlink(join(root, "project", "session.jsonl"));
    await rmdir(join(root, "project"));
    await rmdir(root);
  }
});

const session = (cwd: string) => [
  JSON.stringify({ type: "session", cwd }),
  JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "First prompt\nwith details" } }),
  JSON.stringify({ type: "message", timestamp: "2026-01-02T00:00:00Z", message: { role: "assistant", content: "Not a prompt" } }),
  JSON.stringify({ type: "message", timestamp: "2026-01-03T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Second prompt" }, { type: "image", data: "abc" }] } }),
  "{truncated",
].join("\n");

test("reads only user text from session JSONL, preserving multiline prompts", () => {
  expect(parseSession(session("/project")).map((item) => item.text)).toEqual(["First prompt\nwith details", "Second prompt"]);
});

test("reads saved sessions from all project folders and filters exact cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-test-"));
  created.push(root);
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "session.jsonl"), session("/project"));
  const prompts = await loadPrompts(root, false);
  expect(prompts.map((item) => item.text)).toEqual(["Second prompt", "First prompt\nwith details"]);
  expect(matchingPrompts(prompts, "/project", "project", "first details")).toHaveLength(1);
  expect(matchingPrompts(prompts, "/other", "project", "")).toHaveLength(0);
  expect(matchingPrompts(prompts, "/other", "global", "second")).toHaveLength(1);
});

test("picker searches, toggles scope, restores complete selection and cancels", () => {
  const prompts: Prompt[] = [
    { cwd: "/elsewhere", text: "Other prompt", timestamp: Date.now() },
    { cwd: "/project", text: "Project prompt\nnext line", timestamp: Date.now() },
  ];
  const results: Array<string | undefined> = [];
  const theme = { fg: (_color: string, value: string) => value };
  const picker = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, (value) => results.push(value));
  expect(picker.render(80).join("\n")).not.toContain("Other prompt");
  picker.handleInput("\t");
  expect(picker.render(80).join("\n")).toContain("Other prompt");
  picker.handleInput("o");
  picker.handleInput("t");
  picker.handleInput("\r");
  expect(results).toEqual(["Other prompt"]);
  const canceled = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, (value) => results.push(value));
  canceled.handleInput("\x1b");
  expect(results).toEqual(["Other prompt", undefined]);
});

test("loads global history on first Tab without blocking project search", async () => {
  const prompts: Prompt[] = [{ cwd: "/project", text: "Local", timestamp: Date.now() }];
  let finish!: (prompts: Prompt[]) => void;
  let loads = 0;
  const theme = { fg: (_color: string, value: string) => value };
  const picker = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, () => {}, "", "project", () => {
    loads++;
    return new Promise<Prompt[]>((resolve) => { finish = resolve; });
  });
  picker.handleInput("\t");
  expect(picker.render(80).join("\n")).toContain("Loading global history");
  picker.handleInput("\t");
  expect(picker.render(80).join("\n")).toContain("Local");
  picker.handleInput("\t");
  expect(loads).toBe(1);
  finish([...prompts, { cwd: "/other", text: "Remote", timestamp: Date.now() }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(picker.render(80).join("\n")).toContain("Remote");
});

test("registers Ctrl+R and command scope completions", () => {
  const shortcuts: string[] = [];
  let completions: ((prefix: string) => unknown) | undefined;
  registerPromptHistory({
    registerShortcut: (key: string) => shortcuts.push(key),
    registerCommand: (_name: string, options: { getArgumentCompletions?: (prefix: string) => unknown }) => {
      completions = options.getArgumentCompletions;
    },
  } as unknown as ExtensionAPI);
  expect(shortcuts).toEqual(["ctrl+r"]);
  expect(completions?.("g")).toEqual([{ value: "global", label: "global" }]);
});
