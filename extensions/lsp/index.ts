import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveServer } from "./config.ts";
import { diagnoseSetup } from "./doctor.ts";
import { formatDiagnostics, formatHover, formatLocations, formatSymbols, MAX_RESULTS } from "./format.ts";
import { LspClientManager } from "./manager.ts";
import { resolveWorkspacePath } from "./workspace.ts";

const commonReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const filePath = Type.String({ minLength: 1, description: "File path inside the active Pi workspace" });
const resultLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Maximum results to include; the response includes total/truncated" }));
const position = {
  path: filePath,
  line: Type.Integer({ minimum: 1, description: "1-based source line" }),
  column: Type.Integer({ minimum: 1, description: "1-based UTF-16 code-unit column" }),
};

function completions(prefix: string): Array<{ value: string; label: string; description?: string }> | null {
  const query = prefix.trimStart().toLowerCase();
  const candidates = [
    { value: "doctor", label: "doctor", description: "Check global configuration and installed server paths without starting servers" },
    { value: "status", label: "status", description: "Show active language-server processes" },
    { value: "stop", label: "stop", description: "Stop owned language-server processes" },
  ];
  const matches = candidates.filter((candidate) => candidate.value.startsWith(query));
  return matches.length ? matches : null;
}

async function setup(path: string, cwd: string) {
  const workspaceFile = await resolveWorkspacePath(cwd, path);
  if (workspaceFile.directory) throw new Error(`Expected a source file, received directory '${path}'.`);
  const extensionIndex = workspaceFile.path.lastIndexOf(".");
  const extension = extensionIndex > workspaceFile.path.lastIndexOf("/") ? workspaceFile.path.slice(extensionIndex).toLowerCase() : "";
  if (!extension) throw new Error(`Cannot select a language server for '${path}' without a file extension.`);
  const server = await resolveServer(extension, workspaceFile.workspace);
  return { workspaceFile, server };
}

export default function piLspExtension(pi: ExtensionAPI): void {
  let manager = new LspClientManager();

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Read current language-server diagnostics for a workspace file. Reports clean, findings, or unknown explicitly; unknown never means clean. This tool never changes files.",
    promptSnippet: "Check file diagnostics and navigate code with language servers",
    promptGuidelines: [
      "Prefer LSP hover, definitions, references, and symbols for semantic code questions in supported languages; use rg for text searches.",
      "After a meaningful batch of source edits, use lsp_diagnostics on the affected files when a server is available. Do not check after every individual edit or scan the whole repository.",
      "LSP diagnostics are supplemental: unknown is not clean, and advisory findings may be stale. Still run the project's relevant compiler checks and tests.",
      "If a server is missing, disabled, or unsupported, fall back to file reads, rg, and project checks; do not repeatedly retry or install servers automatically. /lsp doctor checks global setup without starting servers.",
    ],
    parameters: Type.Object({ path: filePath, limit: resultLimit }),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const diagnosticResult = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.diagnostics(workspaceFile.path, signal));
      return formatDiagnostics(diagnosticResult, params.limit ?? 30);
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Read hover/type documentation at a 1-based line and UTF-16 column in a workspace file. Never changes files.",
    parameters: Type.Object(position),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const value = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.hover(workspaceFile.path, params.line - 1, params.column - 1, signal));
      return formatHover(value);
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Read the definition location at a 1-based line and UTF-16 column in a workspace file. Never changes files.",
    parameters: Type.Object({ ...position, limit: resultLimit }),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const value = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.getDefinition(workspaceFile.path, params.line - 1, params.column - 1, signal));
      return formatLocations(value, params.limit ?? 30);
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Read references for the symbol at a 1-based line and UTF-16 column in a workspace file. Never changes files.",
    parameters: Type.Object({
      ...position,
      includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration location (default true)" })),
      limit: resultLimit,
    }),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const value = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.references(
        workspaceFile.path,
        params.line - 1,
        params.column - 1,
        params.includeDeclaration ?? true,
        signal,
      ));
      return formatLocations(value, params.limit ?? 30);
    },
  });

  pi.registerTool({
    name: "lsp_document_symbols",
    label: "LSP Document Symbols",
    description: "Read the symbol outline for a workspace file. Never changes files.",
    parameters: Type.Object({ path: filePath, limit: resultLimit }),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const value = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.documentSymbols(workspaceFile.path, signal));
      return formatSymbols(value, params.limit ?? 30);
    },
  });

  pi.registerTool({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description: "Search a language server's workspace symbols. Provide an anchor source file to select the language and nested project root. Never changes files.",
    parameters: Type.Object({ path: filePath, query: Type.String({ description: "Symbol name or partial name" }), limit: resultLimit }),
    annotations: commonReadOnlyAnnotations,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { workspaceFile, server } = await setup(params.path, ctx.cwd);
      const value = await manager.run(workspaceFile.root, server, server.resolvedCommand, signal, (client) => client.workspaceSymbols(params.query, signal));
      return formatSymbols(value, params.limit ?? 30);
    },
  });

  pi.registerCommand("lsp", {
    description: "Check LSP setup, show status, or stop language servers",
    getArgumentCompletions: completions,
    handler: async (args, ctx: ExtensionCommandContext) => {
      const command = args.trim();
      if (command === "doctor") {
        const report = await diagnoseSetup(ctx.cwd);
        ctx.ui.notify(report.text, report.hasIssues ? "warning" : "info");
        return;
      }
      if (command === "stop") {
        const stopped = manager;
        manager = new LspClientManager();
        await stopped.shutdown();
        ctx.ui.notify("Stopped LSP language servers.", "info");
        return;
      }
      if (command === "status" || command === "") {
        const active = manager.getStatus();
        const summary = active.length
          ? `lsp: ${active.map((item) => `${item.serverId} (${item.root})${item.starting ? " starting" : ""}`).join(", ")}`
          : "lsp: no active language servers";
        ctx.ui.notify(summary, "info");
        return;
      }
      ctx.ui.notify("Usage: /lsp [doctor|status|stop]", "warning");
    },
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
}
