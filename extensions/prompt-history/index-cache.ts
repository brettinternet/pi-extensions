import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Prompt } from "./history.ts";

export interface CachedSession {
  mtimeMs: number;
  size: number;
  prompts: Prompt[];
}

type Index = { version: 1; root: string; files: Record<string, CachedSession> };

export async function readIndex(path: string, root: string): Promise<Record<string, CachedSession>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return {};
    const index = value as Partial<Index>;
    if (index.version !== 1 || index.root !== root || !index.files || typeof index.files !== "object" || Array.isArray(index.files)) return {};
    const files: Record<string, CachedSession> = {};
    for (const [file, record] of Object.entries(index.files)) {
      if (record && Number.isFinite(record.mtimeMs) && Number.isFinite(record.size) &&
        Array.isArray(record.prompts) && record.prompts.every((prompt) =>
          prompt && typeof prompt.text === "string" && typeof prompt.cwd === "string" && Number.isFinite(prompt.timestamp))) {
        files[file] = record;
      }
    }
    return files;
  } catch {
    // A missing or damaged index is rebuilt from the session files.
    return {};
  }
}

/** Atomic, owner-only copy of prompt text. The JSONL sessions remain the source of truth. */
export async function writeIndex(path: string, root: string, files: Record<string, CachedSession>): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ version: 1, root, files }), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // Search must still work if the index directory is read-only or unavailable.
    try { await unlink(temporary); } catch { /* Nothing to clean up. */ }
  }
}
