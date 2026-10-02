import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LspClient } from "../../extensions/lsp/client.ts";
import { resolveServer } from "../../extensions/lsp/config.ts";
import { resolveWorkspacePath } from "../../extensions/lsp/workspace.ts";

const cases = [
  { extension: ".sh", source: "#!/bin/bash\nanswer() { printf '%s\\n' 42; }\nanswer\n" },
  { extension: ".html", source: '<!DOCTYPE html>\n<html><body><div id="answer">42</div></body></html>\n' },
  { extension: ".css", source: ".answer { color: red; }\n" },
  { extension: ".scss", source: "$color: red;\n.answer { color: $color; }\n" },
  { extension: ".less", source: "@color: red;\n.answer { color: @color; }\n" },
  { extension: ".c", source: "const int answer = 42;\nint use(void) { return answer; }\n" },
  { extension: ".cpp", source: "constexpr int answer = 42;\nint use() { return answer; }\n" },
];

test.skipIf(process.env.PI_LSP_REAL_SERVER_SMOKE !== "1")("optional real-server Bash/HTML/CSS/clangd discovery and queries", async () => {
  let ran = 0;
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), "pi-lsp-additional-smoke-"));
    const file = join(root, `main${item.extension}`);
    await writeFile(file, item.source);
    const workspace = await resolveWorkspacePath(root, file);
    let server;
    try {
      server = await resolveServer(item.extension, workspace.workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/disabled|not found on PATH/.test(message)) {
        console.log(`lsp smoke: skip ${item.extension}: ${message}`);
        continue;
      }
      throw error;
    }
    const client = new LspClient(workspace.root, server, server.resolvedCommand, {
      initTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      pushWaitMs: 2_000,
    });
    try {
      await client.start();
      // Push diagnostics also give servers with async post-initialize setup
      // (notably Bash) a bounded opportunity to analyze the opened document.
      const diagnostics = await client.diagnostics(file);
      expect(["clean", "unknown"], `${item.extension}: ${JSON.stringify(diagnostics)}`).toContain(diagnostics.status);
      const symbols = await client.documentSymbols(file);
      expect(Array.isArray(symbols), item.extension).toBe(true);
      expect((symbols as unknown[]).length, item.extension).toBeGreaterThan(0);
      console.log(`lsp smoke: ${item.extension}: symbols found, diagnostics ${diagnostics.status}`);
      ran++;
    } finally {
      await client.stop();
      expect(client.isRunning).toBe(false);
    }
  }
  expect(ran, "no installed additional servers were available on PATH").toBeGreaterThan(0);
}, 240_000);
