import { access, readFile, realpath, stat } from "node:fs/promises";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

export interface ServerDefinition {
  id: string;
  command: string[];
  extensions: string[];
  languageId: string;
  initializationOptions?: Record<string, unknown>;
  workspaceBoundary?: string;
}

const definitions: ServerDefinition[] = [
  { id: "gopls", command: ["gopls"], extensions: [".go"], languageId: "go" },
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    languageId: "typescript",
  },
  { id: "pyright", command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"], languageId: "python" },
  { id: "sourcekit-lsp", command: ["sourcekit-lsp"], extensions: [".swift"], languageId: "swift" },
  { id: "rust-analyzer", command: ["rust-analyzer"], extensions: [".rs"], languageId: "rust" },
  { id: "lua-language-server", command: ["lua-language-server"], extensions: [".lua"], languageId: "lua" },
  { id: "yaml-language-server", command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"], languageId: "yaml" },
  { id: "json-language-server", command: ["vscode-json-language-server", "--stdio"], extensions: [".json", ".jsonc"], languageId: "json" },
];

export function getBuiltinServers(): ServerDefinition[] {
  return definitions.map((server) => ({ ...server, command: [...server.command], extensions: [...server.extensions] }));
}

export function findServerDefinition(extension: string): ServerDefinition | undefined {
  return definitions.find((server) => server.extensions.includes(extension));
}

export function isWithinWorkspace(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Only canonical absolute external directories are inherited by a language server. */
export function getTrustedPath(workspace: string): string {
  const boundary = realpathSync(workspace);
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const entries = new Set<string>();
  for (const part of pathValue.split(delimiter)) {
    if (!part || !isAbsolute(part)) continue;
    try {
      const canonical = realpathSync(part);
      if (!statSync(canonical).isDirectory() || isWithinWorkspace(canonical, boundary)) continue;
      entries.add(canonical);
    } catch {
      // Missing or inaccessible PATH entries are never passed to the server.
    }
  }
  if (entries.size === 0) {
    throw new Error("No safe external PATH directories are available for the language server.");
  }
  return [...entries].join(delimiter);
}

function ensureExternal(canonical: string, workspace: string, requested: string): void {
  if (isWithinWorkspace(canonical, realpathSync(workspace))) {
    throw new Error(`TypeScript server path '${requested}' resolves inside the active workspace; refusing project code.`);
  }
}

export async function validateTypeScriptServerPath(requested: string, workspace: string): Promise<string> {
  if (!isAbsolute(requested)) throw new Error(`TypeScript tsserver.path must be an absolute path: '${requested}'.`);
  let canonical: string;
  try {
    canonical = await realpath(requested);
    ensureExternal(canonical, workspace, requested);
    const metadata = await stat(canonical);
    if (!metadata.isFile() || (metadata.mode & 0o444) === 0) throw new Error("file is not readable");
    await access(canonical, constants.R_OK);
  } catch (error) {
    throw new Error(`Invalid TypeScript tsserver.path '${requested}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonical.split(sep).at(-1) !== "tsserver.js" || canonical.split(sep).at(-2) !== "lib") {
    throw new Error(`Invalid TypeScript tsserver.path '${requested}': expected the canonical lib/tsserver.js file.`);
  }
  const packagePath = join(dirname(dirname(canonical)), "package.json");
  try {
    const canonicalPackage = await realpath(packagePath);
    ensureExternal(canonicalPackage, workspace, requested);
    const packageMetadata = await stat(canonicalPackage);
    if (!packageMetadata.isFile() || (packageMetadata.mode & 0o444) === 0) throw new Error("package.json is not readable");
    await access(canonicalPackage, constants.R_OK);
    const manifest = JSON.parse(await readFile(canonicalPackage, "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== "typescript" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) {
      throw new Error("adjacent package.json is not a versioned TypeScript package");
    }
  } catch (error) {
    throw new Error(`Invalid TypeScript tsserver.path '${requested}': cannot validate its TypeScript package version (${error instanceof Error ? error.message : String(error)}).`);
  }
  return canonical;
}

export async function findExternalTypeScriptServer(workspace: string): Promise<string> {
  const trustedPath = getTrustedPath(workspace);
  const boundary = realpathSync(workspace);
  for (const directory of trustedPath.split(delimiter)) {
    const launcher = join(directory, "tsserver");
    try {
      accessSync(launcher, constants.X_OK);
      const canonicalLauncher = realpathSync(launcher);
      ensureExternal(canonicalLauncher, boundary, launcher);
      const candidates = new Set<string>();
      if (canonicalLauncher.split(sep).at(-1) === "tsserver.js") candidates.add(canonicalLauncher);
      if (canonicalLauncher.split(sep).at(-2) === "bin") {
        candidates.add(join(dirname(dirname(canonicalLauncher)), "lib", "tsserver.js"));
      }
      for (const candidate of candidates) {
        try {
          return await validateTypeScriptServerPath(candidate, boundary);
        } catch {
          // Continue only through other tsserver executables already on trusted PATH.
        }
      }
    } catch {
      // No executable at this PATH entry.
    }
  }
  throw new Error("No validated external TypeScript tsserver.js was found on safe PATH. Set servers.typescript.initializationOptions.tsserver.path in global pi-lsp.json; project TypeScript installations are never used.");
}

/** Resolve only from canonical external PATH entries, never from workspace-local bins. */
export function resolveServerCommand(command: string, workspace: string): string | undefined {
  const boundary = realpathSync(workspace);
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/") || command.includes("\\")
      ? []
      : getTrustedPath(boundary).split(delimiter).map((directory) => join(directory, command));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (!isWithinWorkspace(canonical, boundary)) return canonical;
    } catch {
      // Continue looking in the trusted PATH entries.
    }
  }
  return undefined;
}
