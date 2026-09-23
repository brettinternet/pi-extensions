import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile, unlink, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts, parseSession, type Prompt } from "../../extensions/prompt-history/history.ts";
import { searchPrompts } from "../../extensions/prompt-history/search.ts";
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
  expect(searchPrompts(prompts, "/project", "project", "first details")).toHaveLength(1);
  expect(searchPrompts(prompts, "/other", "project", "")).toHaveLength(0);
  expect(searchPrompts(prompts, "/other", "global", "second")).toHaveLength(1);
});

test("persistent index refreshes changed sessions, prunes deleted sessions, and recovers corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-index-test-"));
  const source = join(root, "session.jsonl");
  const index = join(root, "private", "history.json");
  try {
    await writeFile(source, session("/project"));
    expect((await loadPrompts(root, true, index)).map((prompt) => prompt.text)).toHaveLength(2);
    expect(JSON.parse(await readFile(index, "utf8")).files[source].prompts).toHaveLength(2);
    expect((await stat(index)).mode & 0o777).toBe(0o600);
    expect((await loadPrompts(root, true, index)).map((prompt) => prompt.text)).toHaveLength(2);
    const before = await stat(source);
    await writeFile(source, session("/project").replace("First prompt", "Other prompt"));
    await utimes(source, before.atime, before.mtime);
    expect((await loadPrompts(root, true, index)).some((prompt) => prompt.text.startsWith("Other prompt"))).toBe(true);
    await writeFile(source, `${session("/project")}\n${JSON.stringify({ type: "message", timestamp: "2026-02-01", message: { role: "user", content: "New prompt" } })}`);
    expect((await loadPrompts(root, true, index))[0]?.text).toBe("New prompt");
    await writeFile(index, "broken index");
    expect(await loadPrompts(root, true, index)).toHaveLength(3);
    await unlink(source);
    expect(await loadPrompts(root, true, index)).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(index, "utf8")).files)).toEqual([]);
    await writeFile(index, "corrupt empty index");
    expect(await loadPrompts(root, true, index)).toEqual([]);
    expect(JSON.parse(await readFile(index, "utf8")).files).toEqual({});
  } finally {
    await unlink(index);
    await rmdir(join(root, "private"));
    await rmdir(root);
  }
});

test("prunes the index when the entire session directory disappears", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-prompt-history-removed-test-"));
  const root = join(fixture, "sessions");
  const source = join(root, "session.jsonl");
  const index = join(fixture, "private", "history.json");
  try {
    await mkdir(root);
    await writeFile(source, session("/project"));
    expect(await loadPrompts(root, true, index)).toHaveLength(2);
    await unlink(source);
    await rmdir(root);
    expect(await loadPrompts(root, true, index)).toEqual([]);
    expect(JSON.parse(await readFile(index, "utf8")).files).toEqual({});
  } finally {
    await unlink(index);
    await rmdir(join(fixture, "private"));
    await rmdir(fixture);
  }
});

test("search ranks exact phrases before separate words and fuzzy matches, then recency", () => {
  const prompts: Prompt[] = [
    { cwd: "/project", text: "review and then fix", timestamp: 4 },
    { cwd: "/project", text: "review fix", timestamp: 1 },
    { cwd: "/project", text: "revie fix", timestamp: 9 },
    { cwd: "/project", text: "review fix", timestamp: 2 },
  ];
  const matches = searchPrompts(prompts, "/project", "project", "review fix");
  expect(matches.map((result) => result.prompt.timestamp)).toEqual([2, 1, 4]);
  expect(matches[0]?.ranges).toEqual([[0, 10]]);
  expect(searchPrompts(prompts, "/project", "project", "revw")[0]?.prompt.text).toBe("review and then fix");
  const deep = searchPrompts([
    { cwd: "/project", text: "alpha x beta", timestamp: 2 },
    { cwd: "/project", text: `${"x".repeat(6000)}alpha beta`, timestamp: 1 },
  ], "/project", "project", "alpha beta");
  expect(deep[0]?.prompt.timestamp).toBe(1);
  expect(searchPrompts([{ cwd: "/project", text: "İ hello", timestamp: 1 }], "/project", "project", "hello")[0]?.ranges).toEqual([[2, 7]]);
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
  const toggled = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, (value) => results.push(value));
  toggled.handleInput("\x12");
  expect(results).toEqual(["Other prompt", undefined, undefined]);
});

test("picker highlights matches, shows deep snippets and global source directories", () => {
  const prompts: Prompt[] = [
    { cwd: "/project", text: `${"prefix ".repeat(25)}distinctive phrase`, timestamp: Date.now() },
    { cwd: "/other", text: "distinctive example", timestamp: Date.now() - 1 },
  ];
  const theme = { fg: (color: string, value: string) => color === "warning" ? `\x1b[33m${value}\x1b[0m` : value };
  const picker = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, () => {}, "distinctive");
  expect(picker.render(80).join("\n")).toContain("\x1b[33mdistinctive\x1b[0m");
  expect(picker.render(30).join("\n")).toContain("distinctive");
  picker.handleInput("\t");
  expect(picker.render(80).join("\n")).toContain("/other");
  const sibling = `${homedir()}-other/work`;
  const global = new HistoryPicker([{ cwd: sibling, text: "source", timestamp: 1 }], "/project", { requestRender: () => {} }, theme as any, () => {}, "", "global");
  expect(global.render(100).join("\n")).toContain(sibling);
});

test("Ctrl+P/K and Ctrl+N/J move through history like arrows", () => {
  const prompts: Prompt[] = [
    { cwd: "/project", text: "Newest", timestamp: Date.now() },
    { cwd: "/project", text: "Older", timestamp: Date.now() - 1 },
    { cwd: "/project", text: "Oldest", timestamp: Date.now() - 2 },
  ];
  const selected: string[] = [];
  const theme = { fg: (_color: string, value: string) => value };
  for (const [key, expected] of [["\x0e", "Older"], ["\x0a", "Oldest"], ["\x10", "Newest"], ["\x0b", "Newest"]]) {
    const picker = new HistoryPicker(prompts, "/project", { requestRender: () => {} }, theme as any, (value) => selected.push(value ?? ""));
    if (key === "\x0a" || key === "\x0b") picker.handleInput("\x0e");
    picker.handleInput(key);
    picker.handleInput("\r");
    expect(selected.at(-1)).toBe(expected);
  }
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
