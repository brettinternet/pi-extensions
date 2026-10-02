import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { LspClient } from "../../extensions/pi-lsp/client.ts";
import { resolveServer } from "../../extensions/pi-lsp/config.ts";
import { resolveWorkspacePath } from "../../extensions/pi-lsp/workspace.ts";

const cases = [
  {
    extension: ".go",
    fileName: "main.go",
    rootFiles: { "go.mod": "module example.test/pi-lsp-smoke\n\ngo 1.22\n" },
    source: "package main\nvar answer int = \"wrong\"\nfunc use() int { return answer }\n",
    position: [2, 24] as const,
  },
  {
    extension: ".ts",
    fileName: "main.ts",
    rootFiles: {
      "package.json": "{\"name\":\"pi-lsp-smoke\",\"private\":true}\n",
      "tsconfig.json": "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true}}\n",
    },
    source: "export const answer: number = \"wrong\";\nexport const use = () => answer;\n",
    position: [1, 25] as const,
  },
  {
    extension: ".swift",
    fileName: "main.swift",
    rootFiles: {
      "Package.swift": "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"PiLspSmoke\", targets: [.target(name: \"PiLspSmoke\", path: \"Sources\")])\n",
    },
    source: "public let answer: Int = \"wrong\"\npublic let use = answer\n",
    position: [1, 17] as const,
  },
];

test.skipIf(process.env.PI_LSP_REAL_SERVER_SMOKE !== "1")("optional real-server Go/TypeScript/Swift diagnostics and navigation smoke", async () => {
  let ran = 0;
  for (const item of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `pi-lsp-smoke-${item.extension.slice(1)}-`));
    for (const [name, contents] of Object.entries(item.rootFiles)) await writeFile(join(workspace, name), contents);
    const sourceDirectory = item.extension === ".swift" ? join(workspace, "Sources") : workspace;
    await mkdir(sourceDirectory, { recursive: true });
    const file = join(sourceDirectory, item.fileName);
    await writeFile(file, item.source);
    const compilerMarker = join(workspace, "workspace-compiler-ran");
    if (item.extension === ".ts") {
      const localCompiler = join(workspace, "node_modules", "typescript");
      await mkdir(join(localCompiler, "lib"), { recursive: true });
      await writeFile(join(localCompiler, "package.json"), '{"name":"typescript","version":"5.9.3"}');
      await writeFile(join(localCompiler, "lib", "tsserver.js"), `require('node:fs').writeFileSync(${JSON.stringify(compilerMarker)}, 'executed'); process.exit(1);`);
    }
    const workspaceFile = await resolveWorkspacePath(workspace, file);

    let server;
    try {
      server = await resolveServer(item.extension, workspaceFile.workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/disabled|not found on PATH/.test(message)) {
        console.log(`pi-lsp smoke: skip ${item.extension}: ${message}`);
        continue;
      }
      throw error;
    }

    const client = new LspClient(workspaceFile.root, server, server.resolvedCommand, {
      initTimeoutMs: 60_000,
      requestTimeoutMs: 60_000,
      pushWaitMs: 5_000,
    });
    try {
      await client.start();
      const broken = await client.diagnostics(workspaceFile.path);
      expect(broken.status, `${item.extension} intentional type error must never claim clean`).not.toBe("clean");
      if (broken.status === "unknown") console.log(`pi-lsp smoke: ${item.extension} diagnostics remain unknown/advisory for this server`);
      const symbols = await client.documentSymbols(workspaceFile.path);
      expect(Array.isArray(symbols)).toBe(true);
      expect((symbols as unknown[]).length).toBeGreaterThan(0);
      const definition = await client.getDefinition(workspaceFile.path, item.position[0], item.position[1]);
      expect(definition).toBeTruthy();
      if (Array.isArray(definition)) expect(definition.length).toBeGreaterThan(0);
      const hover = await client.hover(workspaceFile.path, item.position[0], item.position[1]);
      expect(hover).toBeTruthy();

      await writeFile(file, item.source.replace("\"wrong\"", "42"));
      const fixed = await client.diagnostics(workspaceFile.path);
      expect(fixed.status).not.toBe("findings");
      await writeFile(file, item.source);
      expect((await client.diagnostics(workspaceFile.path)).status).not.toBe("clean");
      if (item.extension === ".ts") await expect(readFile(compilerMarker)).rejects.toThrow();
      ran++;
    } finally {
      await client.stop();
      expect(client.isRunning).toBe(false);
    }
  }
  expect(ran, "no installed supported language servers were available on PATH").toBeGreaterThan(0);
}, 240_000);
