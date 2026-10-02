import { access, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_MARKERS = [
  ".git",
  "go.mod",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "Package.swift",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  "CMakeLists.txt",
  "Makefile",
  "justfile",
] as const;

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findRoot(start: string, workspace: string, preferTypeScriptConfig: boolean): Promise<string> {
  let current = start;
  let fallback: string | undefined;
  while (contains(workspace, current)) {
    if (preferTypeScriptConfig && (await exists(resolve(current, "tsconfig.json")) || await exists(resolve(current, "jsconfig.json")))) return current;
    for (const marker of ROOT_MARKERS) {
      if (await exists(resolve(current, marker))) {
        fallback ??= current;
        if (!preferTypeScriptConfig || marker === ".git") return fallback;
        break;
      }
    }
    if (current === workspace) break;
    const parent = dirname(current);
    if (parent === current || !contains(workspace, parent)) break;
    current = parent;
  }
  return fallback ?? workspace;
}

export interface WorkspaceFile {
  workspace: string;
  root: string;
  path: string;
  uri: string;
  directory: boolean;
}

/** Resolve a tool path inside the active Pi cwd and reject symlink escapes. */
export async function resolveWorkspacePath(cwd: string, input: string): Promise<WorkspaceFile> {
  const workspace = await realpath(cwd);
  const requested = isAbsolute(input) ? input : resolve(workspace, input);
  let details;
  try {
    details = await stat(requested);
  } catch (error) {
    throw new Error(`Cannot access workspace path '${input}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!details.isFile() && !details.isDirectory()) throw new Error(`Workspace path '${input}' is not a regular file or directory.`);
  const path = await realpath(requested);
  if (!contains(workspace, path)) throw new Error(`Workspace path '${input}' resolves outside the active workspace '${workspace}'.`);
  const directory = details.isDirectory();
  const preferTypeScriptConfig = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
  const root = await findRoot(directory ? path : dirname(path), workspace, preferTypeScriptConfig);
  return {
    workspace,
    root,
    path,
    uri: pathToFileURL(path).href,
    directory,
  };
}
