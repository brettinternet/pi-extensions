import { chmod, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { LspClient } from "../../extensions/lsp/client.ts";
import { readGlobalConfig, resolveServer } from "../../extensions/lsp/config.ts";
import { diagnoseSetup } from "../../extensions/lsp/doctor.ts";
import { formatDiagnostics, formatSymbols, MAX_OUTPUT_CHARS } from "../../extensions/lsp/format.ts";
import { LspClientManager } from "../../extensions/lsp/manager.ts";
import { findServerDefinition, getBuiltinServers, resolveServerCommand } from "../../extensions/lsp/servers.ts";
import { resolveWorkspacePath } from "../../extensions/lsp/workspace.ts";
import piLspExtension from "../../extensions/lsp/index.ts";

const fakeServer = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
const definition = { id: "fake", command: [], extensions: [".go"], languageId: "go" };
const command = [process.execPath, fakeServer];
const savedEnvironment = new Map<string, string | undefined>();

async function rootWithGo(text = "package main\n"): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  const file = join(root, "main.go");
  await writeFile(file, text);
  return { root, file };
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
}

afterEach(restoreEnv);

function fakeManager(options: ConstructorParameters<typeof LspClientManager>[0] = {}) {
  return new LspClientManager({
    ...options,
    clientFactory: (root, server, serverCommand) => new LspClient(root, server, serverCommand, {
      requestTimeoutMs: 1_500,
      initTimeoutMs: 1_500,
      pushWaitMs: 35,
      maxDocuments: 2,
    }),
  });
}

function logFile(root: string): string {
  return join(root, "fake-lsp.log");
}

async function readLog(root: string): Promise<string> {
  try { return await readFile(logFile(root), "utf8"); } catch { return ""; }
}

async function runDiagnostics(manager: LspClientManager, root: string, file: string, signal?: AbortSignal) {
  return manager.run(root, definition, command, signal, (client) => client.diagnostics(file, signal));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for expected language-server state.");
}

describe("pi-lsp client", () => {
  test("cold-starts lazily and classifies a valid empty pull report as clean", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_PULL_SEQUENCE: "full", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      expect(manager.size).toBe(0);
      const result = await runDiagnostics(manager, root, file);
      expect(result).toMatchObject({ status: "clean", source: "pull", total: 0, truncated: false });
      expect(result.version).toBeGreaterThan(0);
      expect((await readLog(root)).match(/initialize:/g)).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("requests fresh pull reports; unsolicited unchanged, null, unsupported, and malformed are unknown", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_PULL_SEQUENCE: "full,unchanged,null,error,invalid", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      expect((await runDiagnostics(manager, root, file)).status).toBe("clean");
      expect((await runDiagnostics(manager, root, file)).status).toBe("unknown");
      expect((await runDiagnostics(manager, root, file)).status).toBe("unknown");
      expect((await runDiagnostics(manager, root, file)).status).toBe("unknown");
      expect((await runDiagnostics(manager, root, file)).status).toBe("unknown");
    } finally {
      await manager.shutdown();
    }
  });

  test("tracks dirty to clean to dirty edits at increasing document versions", async () => {
    const { root, file } = await rootWithGo("package main // BAD\n");
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_PULL_SEQUENCE: "full", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      const dirty = await runDiagnostics(manager, root, file);
      await writeFile(file, "package main\n");
      const clean = await runDiagnostics(manager, root, file);
      await writeFile(file, "package main // BAD\n");
      const dirtyAgain = await runDiagnostics(manager, root, file);
      expect([dirty.status, clean.status, dirtyAgain.status]).toEqual(["findings", "clean", "findings"]);
      expect(clean.version).toBeGreaterThan(dirty.version);
      expect(dirtyAgain.version).toBeGreaterThan(clean.version);
    } finally {
      await manager.shutdown();
    }
  });

  test("never reuses clean push reports after open, unopened, or evicted dependency edits", async () => {
    for (const state of ["open", "unopened", "evicted"]) {
      const { root, file } = await rootWithGo();
      const dependency = join(root, "dependency.go");
      const replay = join(root, "replay.json");
      await writeFile(dependency, "package main\nvar dependency = 1\n");
      setEnv({ FAKE_LSP_PULL: "false", FAKE_LSP_PUSH_MODE: "versioned", FAKE_LSP_REPLAY_FILE: replay });
      const manager = fakeManager();
      try {
        if (state !== "unopened") await manager.run(root, definition, command, undefined, (client) => client.hover(dependency, 0, 0));
        const first = await runDiagnostics(manager, root, file);
        expect(first.status).toBe("clean");
        if (state === "evicted") {
          const third = join(root, "third.go");
          await writeFile(third, "package main\n");
          await manager.run(root, definition, command, undefined, (client) => client.hover(third, 0, 0));
        }
        await writeFile(dependency, "package main // BAD\n");
        await writeFile(replay, JSON.stringify({ uri: pathToFileURL(await realpath(file)).href, version: first.version, diagnostics: [] }));
        const changed = await runDiagnostics(manager, root, file);
        expect(changed.status).toBe("unknown");
        expect(changed.version).toBeGreaterThan(first.version);
      } finally { await manager.shutdown(); restoreEnv(); }
    }
  });

  test("reopened documents cannot accept an old lifetime's delayed clean push", async () => {
    const { root, file } = await rootWithGo();
    const replay = join(root, "replay.json");
    setEnv({ FAKE_LSP_PUSH_MODE: "versioned", FAKE_LSP_REPLAY_FILE: replay });
    const client = new LspClient(root, definition, command, { maxDocuments: 1, pushWaitMs: 35 });
    try {
      await client.start();
      const first = await client.diagnostics(file);
      expect(first.status).toBe("clean");
      const second = join(root, "second.go");
      await writeFile(second, "package main\n");
      await client.hover(second, 0, 0);
      await writeFile(file, "package main // BAD\n");
      await writeFile(replay, JSON.stringify({ uri: pathToFileURL(await realpath(file)).href, version: first.version, diagnostics: [] }));
      const reopened = await client.diagnostics(file);
      expect(reopened.status).toBe("unknown");
      expect(reopened.version).toBeGreaterThan(first.version);
    } finally { await client.stop(); }
  });

  test("cached synchronization rejects file and parent-directory symlink replacements", async () => {
    for (const parentSwap of [false, true]) {
      const { root, file } = await rootWithGo();
      const inside = join(root, "nested");
      const outside = await mkdtemp(join(tmpdir(), "pi-lsp-private-"));
      await mkdir(inside);
      const cached = join(inside, "cached.go");
      await writeFile(cached, "package main\n");
      await writeFile(join(outside, "cached.go"), "DO_NOT_TRANSMIT_PRIVATE_CONTENT");
      setEnv({ FAKE_LSP_LOG: logFile(root) });
      const client = new LspClient(root, definition, command);
      try {
        await client.start();
        await client.hover(cached, 0, 0);
        await rename(parentSwap ? inside : cached, (parentSwap ? inside : cached) + ".original");
        await symlink(parentSwap ? outside : join(outside, "cached.go"), parentSwap ? inside : cached);
        await client.hover(file, 0, 0);
        expect(client.openDocumentCount).toBe(1);
        expect(await readLog(root)).not.toContain("DO_NOT_TRANSMIT_PRIVATE_CONTENT");
        await expect(client.hover(cached, 0, 0)).rejects.toThrow(/outside/);
      } finally { await client.stop(); restoreEnv(); }
    }
  });

  test.skipIf(process.platform === "win32")("shutdown removes owned workers after graceful exit, stubborn shutdown, or launcher crash", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const unrelatedExit = new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
    try {
      for (const mode of ["graceful", "stubborn", "crash"]) {
        const { root, file } = await rootWithGo();
        const pidFile = join(root, "worker.pid");
        setEnv({ FAKE_LSP_CHILD_PID_FILE: pidFile, FAKE_LSP_IGNORE_SHUTDOWN: mode === "stubborn" ? "1" : undefined, FAKE_LSP_CRASH_ON_HOVER: mode === "crash" ? "1" : undefined });
        const client = new LspClient(root, definition, command);
        try {
          await client.start();
          await waitFor(async () => { try { return Number(await readFile(pidFile, "utf8")) > 0; } catch { return false; } });
          const workerPid = Number(await readFile(pidFile, "utf8"));
          if (mode === "crash") await expect(client.hover(file, 0, 0)).rejects.toThrow();
          await client.stop();
          expect(() => process.kill(workerPid, 0)).toThrow();
          expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
        } finally { await client.stop(); restoreEnv(); }
      }
    } finally { unrelated.kill("SIGKILL"); await unrelatedExit; }
  }, 10_000);

  test("versioned push reports may prove clean; stale and unversioned pushes remain unknown", async () => {
    for (const [mode, expected, advisory] of [
      ["versioned", "clean", false],
      ["stale", "unknown", false],
      ["unversioned", "unknown", true],
    ] as const) {
      const { root, file } = await rootWithGo(mode === "unversioned" ? "package main // BAD\n" : "package main\n");
      setEnv({ FAKE_LSP_PULL: "false", FAKE_LSP_PUSH_MODE: mode, FAKE_LSP_LOG: logFile(root) });
      const manager = fakeManager();
      try {
        const result = await runDiagnostics(manager, root, file);
        expect(result.status).toBe(expected);
        expect(result.status === "unknown" && result.advisory === true).toBe(advisory);
      } finally {
        await manager.shutdown();
      }
      restoreEnv();
    }
  });

  test("a file edit during a delayed pull report invalidates the response", async () => {
    const { root, file } = await rootWithGo();
    setEnv({
      FAKE_LSP_PULL: "true",
      FAKE_LSP_PULL_SEQUENCE: "full",
      FAKE_LSP_DIAGNOSTIC_DELAY_MS: "140",
      FAKE_LSP_LOG: logFile(root),
    });
    const manager = fakeManager();
    try {
      const pending = runDiagnostics(manager, root, file);
      await delay(35);
      await writeFile(file, "package main // BAD\n");
      const result = await pending;
      expect(result.status).toBe("unknown");
      if (result.status !== "unknown") throw new Error("Expected unknown diagnostics after an edit.");
      expect(result.reason).toMatch(/document changed/i);
    } finally {
      await manager.shutdown();
    }
  });

  test("pre-aborted calls do not spawn, and a cancelled sole initializer is stopped", async () => {
    const first = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_LOG: logFile(first.root) });
    const manager = fakeManager();
    const preAborted = new AbortController();
    preAborted.abort();
    try {
      await expect(runDiagnostics(manager, first.root, first.file, preAborted.signal)).rejects.toThrow();
      expect(manager.size).toBe(0);
      expect(await readLog(first.root)).toBe("");
    } finally {
      await manager.shutdown();
    }

    const second = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_INIT_DELAY_MS: "900", FAKE_LSP_LOG: logFile(second.root) });
    const cancelledManager = fakeManager();
    const controller = new AbortController();
    try {
      const pending = runDiagnostics(cancelledManager, second.root, second.file, controller.signal);
      await waitFor(async () => (await readLog(second.root)).includes("initialize:"));
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(cancelledManager.size).toBe(0);
    } finally {
      await cancelledManager.shutdown();
    }
  });

  test("cancellation rejects a pending request instead of manufacturing clean", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_DIAGNOSTIC_DELAY_MS: "700", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    const controller = new AbortController();
    try {
      const pending = runDiagnostics(manager, root, file, controller.signal);
      await delay(35);
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await manager.shutdown();
    }
  });

  test("retries a crashed read-only query once with a fresh client", async () => {
    const { root, file } = await rootWithGo();
    const marker = join(root, "crashed-once");
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_CRASH_MARKER: marker, FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      const result = await runDiagnostics(manager, root, file);
      expect(result.status).toBe("clean");
      expect((await readLog(root)).match(/initialize:/g)).toHaveLength(2);
      expect((await readLog(root)).match(/crash/g)).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("deduplicates simultaneous client startup and serializes stateful operations", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      const results = await Promise.all([
        runDiagnostics(manager, root, file),
        runDiagnostics(manager, root, file),
      ]);
      expect(results.map((item) => item.status)).toEqual(["clean", "clean"]);
      expect((await readLog(root)).match(/initialize:/g)).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("reaps an idle owned process and shutdown waits for an in-progress initialize", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_INIT_DELAY_MS: "130", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager({ idleMs: 30, reaperMs: 10 });
    const starting = runDiagnostics(manager, root, file);
    await waitFor(async () => (await readLog(root)).includes("initialize:"));
    await manager.shutdown();
    await expect(starting).rejects.toThrow(/shutting down|shut down/i);
    expect(manager.size).toBe(0);
    expect(await readLog(root)).toContain("exit");
  });

  test("serves read-only hover, definition, references, and symbol queries", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      const results = await manager.run(root, definition, command, undefined, async (client) => ({
        hover: await client.hover(file, 0, 0),
        definition: await client.getDefinition(file, 0, 0),
        references: await client.references(file, 0, 0, true),
        documentSymbols: await client.documentSymbols(file),
        workspaceSymbols: await client.workspaceSymbols("Fake"),
      }));
      expect(results.hover).toMatchObject({ contents: { value: "**fake hover result**" } });
      expect(results.definition).toMatchObject({ uri: expect.stringContaining("main.go") });
      expect(results.references).toHaveLength(1);
      expect(results.documentSymbols).toMatchObject([{ name: "FakeSymbol" }]);
      expect(results.workspaceSymbols).toMatchObject([{ name: "FakeSymbol" }]);
    } finally {
      await manager.shutdown();
    }
  });

  test("passes validated initialization options and chooses TS-family language IDs by extension", async () => {
    const { root } = await rootWithGo();
    const tsDefinition = { id: "typescript", command: [], extensions: [".ts"], languageId: "typescript", initializationOptions: { tsserver: { path: "/opt/typescript/lib/tsserver.js" } } };
    const client = new LspClient(root, tsDefinition, command);
    setEnv({ FAKE_LSP_LOG: logFile(root) });
    try {
      await client.start();
      for (const extension of [".ts", ".tsx", ".js", ".jsx"] as const) {
        const path = join(root, `source${extension}`);
        await writeFile(path, "const answer = 1;\n");
        await client.hover(path, 0, 0);
      }
    } finally {
      await client.stop();
    }
    const log = await readLog(root);
    expect(log).toContain('initializationOptions:{"tsserver":{"path":"/opt/typescript/lib/tsserver.js"}}');
    expect(log).toContain("didOpen:typescript");
    expect(log).toContain("didOpen:typescriptreact");
    expect(log).toContain("didOpen:javascript");
    expect(log).toContain("didOpen:javascriptreact");
  });

  test("new server families send the correct language IDs for each file type", async () => {
    const { root } = await rootWithGo();
    setEnv({ FAKE_LSP_LOG: logFile(root) });
    const families = [
      { extensions: [".sh", ".bash"], ids: ["shellscript", "shellscript"] },
      { extensions: [".html", ".htm"], ids: ["html", "html"] },
      { extensions: [".css", ".scss", ".less"], ids: ["css", "scss", "less"] },
      { extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], ids: ["c", "c", "cpp", "cpp", "cpp", "cpp", "cpp", "cpp"] },
    ];
    for (const family of families) {
      const server = findServerDefinition(family.extensions[0]!)!;
      const client = new LspClient(root, server, command);
      try {
        await client.start();
        for (const extension of family.extensions) {
          expect(findServerDefinition(extension)?.id).toBe(server.id);
          const file = join(root, `source${extension}`);
          await writeFile(file, "example\n");
          await client.documentSymbols(file);
        }
      } finally {
        await client.stop();
      }
    }
    const opened = (await readLog(root)).split("\n").filter((line) => line.startsWith("didOpen:"));
    expect(opened).toEqual(families.flatMap((family) => family.ids.map((id) => `didOpen:${id}`)));
  });

  test("limits document retention and formats output/details within the configured bound", async () => {
    const { root, file } = await rootWithGo();
    setEnv({ FAKE_LSP_PULL: "true", FAKE_LSP_LOG: logFile(root) });
    const manager = fakeManager();
    try {
      const client = new LspClient(root, definition, command, { maxDocuments: 2 });
      try {
        await client.start();
        await client.hover(file, 0, 0);
        const second = join(root, "second.go");
        const third = join(root, "third.go");
        await writeFile(second, "package main\n");
        await writeFile(third, "package main\n");
        await client.hover(second, 0, 0);
        await client.hover(third, 0, 0);
        expect(client.openDocumentCount).toBe(2);
      } finally {
        await client.stop();
      }
      expect(client.openDocumentCount).toBe(0);
    } finally {
      await manager.shutdown();
    }

    const diagnostics = Array.from({ length: 80 }, (_, index) => ({
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      message: "\"\\\\\n".repeat(3_000),
    }));
    const formatted = formatDiagnostics({ status: "findings", diagnostics, total: 80, truncated: true, version: 1, source: "pull" }, 50);
    expect(formatted.content[0]!.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(JSON.stringify(formatted.details).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(formatted.details).toMatchObject({ status: "findings", total: 80, truncated: true });
    const symbols = formatSymbols([
      { name: "first", kind: 5, children: [{ name: "FirstChild", kind: 12 }] },
      { name: "second", kind: 5, children: [{ name: "SecondChild", kind: 12 }] },
    ], 10);
    expect(symbols.details).toMatchObject({ symbols: [{ name: "first", children: [{ name: "FirstChild" }] }, { name: "second", children: [{ name: "SecondChild" }] }] });
  });
});

describe("pi-lsp workspace and server discovery", () => {
  test("C/C++ configuration selects a nested project root", async () => {
    for (const marker of [".clangd", "compile_commands.json", "compile_flags.txt"]) {
      const { root } = await rootWithGo();
      const nested = join(root, "native");
      await mkdir(join(nested, "src"), { recursive: true });
      await writeFile(join(nested, marker), "");
      const file = join(nested, "src", "main.cpp");
      await writeFile(file, "int main() {}\n");
      expect((await resolveWorkspacePath(root, file)).root).toBe(await realpath(nested));
    }
  });

  test("TypeScript inherits an ancestor compiler config across nested package manifests", async () => {
    const { root } = await rootWithGo();
    const nested = join(root, "package");
    await mkdir(nested);
    await writeFile(join(nested, "package.json"), "{}");
    const file = join(nested, "source.ts");
    await writeFile(file, "export const value = 1;");
    await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"}}');
    expect((await resolveWorkspacePath(root, file)).root).toBe(await realpath(root));
    await writeFile(join(nested, "tsconfig.json"), "{}");
    expect((await resolveWorkspacePath(root, file)).root).toBe(await realpath(nested));
  });

  test("detects nested Package.swift roots and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-lsp-workspace-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "package.json"), "{}\n");
    const nested = join(root, "swift-package");
    await mkdir(join(nested, "Sources", "Demo"), { recursive: true });
    await writeFile(join(nested, "Package.swift"), "// swift package\n");
    const file = join(nested, "Sources", "Demo", "main.swift");
    await writeFile(file, "print(\"hello\")\n");
    expect((await resolveWorkspacePath(root, file)).root).toBe(await realpath(nested));

    const worktree = join(root, "git-worktree");
    await mkdir(worktree);
    await writeFile(join(worktree, ".git"), "gitdir: ../.git/worktrees/demo\n");
    const worktreeFile = join(worktree, "main.go");
    await writeFile(worktreeFile, "package main\n");
    expect((await resolveWorkspacePath(root, worktreeFile)).root).toBe(await realpath(worktree));

    const outside = await mkdtemp(join(tmpdir(), "pi-lsp-outside-"));
    const outsideFile = join(outside, "escape.go");
    await writeFile(outsideFile, "package main\n");
    const link = join(root, "escape.go");
    try {
      await symlink(outsideFile, link);
      await expect(resolveWorkspacePath(root, link)).rejects.toThrow(/outside the active workspace/i);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return;
      throw error;
    }
  });

  test("rejects PATH executables from the workspace and ignores project LSP command configs", async () => {
    const { root } = await rootWithGo();
    const localBin = join(root, "node_modules", ".bin");
    await mkdir(localBin, { recursive: true });
    const globalBin = await mkdtemp(join(tmpdir(), "pi-lsp-global-bin-"));
    const globalAgentDir = await mkdtemp(join(tmpdir(), "pi-lsp-global-agent-"));
    const marker = join(root, "executed-local-command.txt");
    const localCommand = join(localBin, "gopls");
    const globalCommand = join(globalBin, "gopls");
    await writeFile(localCommand, `#!/bin/sh\nprintf ran > '${marker}'\n`);
    await writeFile(globalCommand, `#!/bin/sh\nprintf global-ran > '${marker}'\n`);
    await chmod(localCommand, 0o755);
    await chmod(globalCommand, 0o755);
    await writeFile(join(globalAgentDir, "pi-lsp.json"), JSON.stringify({ servers: { gopls: { command: ["gopls", "--stdio"] } } }));
    const piDirectory = join(root, ".pi");
    await mkdir(piDirectory);
    await writeFile(join(piDirectory, "lsp-client.json"), JSON.stringify({ lsp: { gopls: { command: [localCommand] } } }));
    await writeFile(join(piDirectory, "lsp.json"), JSON.stringify({ servers: { gopls: { command: [localCommand] } } }));
    await writeFile(join(root, ".pi-lsp.json"), JSON.stringify({ servers: { gopls: { command: [localCommand] } } }));
    const oldPath = process.env.PATH ?? "";
    setEnv({ PATH: `${localBin}${delimiter}${globalBin}${delimiter}${oldPath}`, PI_CODING_AGENT_DIR: globalAgentDir });
    expect(resolveServerCommand("gopls", root)).toBe(await realpath(globalCommand));
    const resolved = await resolveServer(".go", root);
    expect(resolved.resolvedCommand[0]).toBe(await realpath(globalCommand));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  test("preserves external shim names while rejecting workspace launcher targets", async () => {
    const { root } = await rootWithGo();
    const trustedBin = await mkdtemp(join(tmpdir(), "pi-lsp-shims-"));
    const dispatcher = join(trustedBin, "dispatcher");
    await writeFile(dispatcher, '#!/bin/sh\nprintf "%s" "$0"\n');
    await chmod(dispatcher, 0o755);
    const launcher = join(trustedBin, "gopls");
    await symlink(dispatcher, launcher);
    setEnv({ PATH: trustedBin });
    const resolved = resolveServerCommand("gopls", root)!;
    expect(resolved).toBe(join(await realpath(trustedBin), "gopls"));
    expect(spawnSync(resolved, [], { encoding: "utf8" }).stdout).toBe(resolved);
    const localServer = join(root, "local-server");
    await writeFile(localServer, "#!/bin/sh\nexit 0\n");
    await chmod(localServer, 0o755);
    const escapingLauncher = join(trustedBin, "pyright-langserver");
    await symlink(localServer, escapingLauncher);
    expect(resolveServerCommand("pyright-langserver", root)).toBeUndefined();
    expect(resolveServerCommand(escapingLauncher, root)).toBeUndefined();
  });

  test("an external env-node launcher cannot pick an interpreter from the workspace PATH", async () => {
    const { root, file } = await rootWithGo();
    const localBin = join(root, "bin");
    const trustedBin = await mkdtemp(join(tmpdir(), "pi-lsp-interpreter-"));
    const marker = join(root, "untrusted-interpreter-ran");
    await mkdir(localBin);
    await writeFile(join(localBin, "node"), `#!/bin/sh\nprintf compromised > ${JSON.stringify(marker)}\nexit 99\n`);
    await chmod(join(localBin, "node"), 0o755);
    await symlink(process.execPath, join(trustedBin, "node"));
    const launcher = join(trustedBin, "server.mjs");
    await writeFile(launcher, "#!/usr/bin/env node\n" + await readFile(fakeServer, "utf8"));
    await chmod(launcher, 0o755);
    setEnv({ PATH: [localBin, ".", "", trustedBin].join(delimiter) });
    const client = new LspClient(root, definition, [resolveServerCommand(launcher, root)!]);
    try {
      await client.start();
      expect(await client.hover(file, 0, 0)).toBeTruthy();
      await expect(readFile(marker)).rejects.toThrow();
    } finally { await client.stop(); }
  });

  test("TypeScript selects only a validated external compiler and enforces no automatic typing installation", async () => {
    const { root } = await rootWithGo();
    const agentDir = await mkdtemp(join(tmpdir(), "pi-lsp-trusted-agent-"));
    const trusted = await mkdtemp(join(tmpdir(), "pi-lsp-trusted-ts-"));
    const local = join(root, "node_modules", "typescript");
    for (const base of [trusted, local]) {
      await mkdir(join(base, "lib"), { recursive: true });
      await mkdir(join(base, "bin"));
      await writeFile(join(base, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
      await writeFile(join(base, "lib", "tsserver.js"), "// test compiler\n");
      await writeFile(join(base, "bin", "tsserver"), "#!/usr/bin/env node\n");
      await chmod(join(base, "bin", "tsserver"), 0o755);
    }
    const launcher = join(trusted, "bin", "typescript-language-server");
    await writeFile(launcher, "#!/usr/bin/env node\n");
    await chmod(launcher, 0o755);
    setEnv({ PATH: [join(local, "bin"), join(trusted, "bin"), process.env.PATH].join(delimiter), PI_CODING_AGENT_DIR: agentDir });
    const compiler = await realpath(join(trusted, "lib", "tsserver.js"));
    expect((await resolveServer(".ts", root)).initializationOptions).toMatchObject({ disableAutomaticTypingAcquisition: true, tsserver: { path: compiler } });
    for (const path of [compiler, join(local, "lib", "tsserver.js"), join(trusted, "missing.js")]) {
      await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: { typescript: { initializationOptions: { disableAutomaticTypingAcquisition: false, tsserver: { path } } } } }));
      if (path === compiler) expect((await resolveServer(".ts", root)).initializationOptions).toMatchObject({ disableAutomaticTypingAcquisition: true });
      else await expect(resolveServer(".ts", root)).rejects.toThrow(/Invalid TypeScript tsserver.path/);
    }
  });

  test("validates global JSON configuration and reports malformed input clearly", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-lsp-agent-config-"));
    setEnv({ PI_CODING_AGENT_DIR: agentDir });
    const globalConfig = {
      servers: {
        gopls: { disabled: true },
        typescript: { initializationOptions: { tsserver: { path: "/opt/typescript/lib/tsserver.js" } } },
      },
    };
    await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify(globalConfig));
    expect(await readGlobalConfig()).toEqual(globalConfig);
    await writeFile(join(agentDir, "pi-lsp.json"), "{ malformed");
    await expect(readGlobalConfig()).rejects.toThrow(/Invalid Pi LSP config/);
  });

  test("doctor checks commands, disabled servers, and TypeScript setup without spawning", async () => {
    const { root } = await rootWithGo();
    const agentDir = await mkdtemp(join(tmpdir(), "pi-lsp-doctor-"));
    const marker = join(root, "server-started");
    setEnv({ PI_CODING_AGENT_DIR: agentDir });
    const servers = Object.fromEntries(getBuiltinServers().map((server) => [server.id, { disabled: true }]));
    const config = { servers: {
      ...servers,
      gopls: { command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] },
      typescript: { command: [process.execPath], initializationOptions: { tsserver: { path: join(agentDir, "missing.js") } } },
    } };
    await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify(config));
    const report = await diagnoseSetup(root);
    expect(report.hasIssues).toBe(true);
    expect(report.text).toContain("gopls: found");
    expect(report.text).toContain("pyright: disabled");
    expect(report.text).toContain("typescript: unavailable");
    expect(report.text).toContain("Invalid TypeScript tsserver.path");
    await expect(readFile(marker)).rejects.toThrow();

    await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: { ...servers, gopls: config.servers.gopls } }));
    expect((await diagnoseSetup(root)).hasIssues).toBe(false);
    await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: { ...servers, gopls: { command: [join(agentDir, "missing-server")] } } }));
    expect((await diagnoseSetup(root)).text).toContain("gopls: unavailable");
    await writeFile(join(agentDir, "pi-lsp.json"), "{ malformed");
    const invalid = await diagnoseSetup(root);
    expect(invalid.hasIssues).toBe(true);
    expect(invalid.text).toContain(join(agentDir, "pi-lsp.json"));
  });

  test("extension registration is lazy and exposes only read-only tools plus command completions", async () => {
    const tools: Array<Record<string, unknown>> = [];
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    let command: { getArgumentCompletions(prefix: string): unknown; handler(args: string, ctx: never): Promise<void> } | undefined;
    const pi = {
      registerTool(tool: Record<string, unknown>) { tools.push(tool); },
      registerCommand(_name: string, definition: typeof command) { command = definition; },
      on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
    } as never;
    piLspExtension(pi);
    expect(tools.map((tool) => tool.name)).toEqual([
      "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_document_symbols", "lsp_workspace_symbols",
    ]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(command?.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status", description: "Show active language-server processes" },
      { value: "stop", label: "stop", description: "Stop owned language-server processes" },
    ]);
    expect(command?.getArgumentCompletions("sto")).toEqual([{ value: "stop", label: "stop", description: "Stop owned language-server processes" }]);
    expect(command?.getArgumentCompletions("doc")).toEqual([{ value: "doctor", label: "doctor", description: "Check global configuration and installed server paths without starting servers" }]);
    expect(tools.find((tool) => tool.name === "lsp_diagnostics")?.promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringContaining("meaningful batch"),
      expect.stringContaining("unknown is not clean"),
      expect.stringContaining("do not repeatedly retry"),
    ]));
    expect(hooks.has("session_shutdown")).toBe(true);
    expect(hooks.has("tool_result")).toBe(false);
    const agentDir = await mkdtemp(join(tmpdir(), "pi-lsp-doctor-command-"));
    setEnv({ PI_CODING_AGENT_DIR: agentDir });
    await writeFile(join(agentDir, "pi-lsp.json"), JSON.stringify({ servers: Object.fromEntries(getBuiltinServers().map((server) => [server.id, { disabled: true }])) }));
    const notices: Array<{ text: string; level: string }> = [];
    const ctx = { cwd: agentDir, ui: { notify(text: string, level: string) { notices.push({ text, level }); } } } as never;
    await command!.handler("doctor", ctx);
    expect(notices.at(-1)).toMatchObject({ text: expect.stringContaining("gopls: disabled"), level: "info" });
    await command!.handler("status", ctx);
    expect(notices.at(-1)?.text).toBe("lsp: no active language servers");
    await writeFile(join(agentDir, "pi-lsp.json"), "invalid");
    await command!.handler("doctor", ctx);
    expect(notices.at(-1)?.level).toBe("warning");
  });
});
