import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readIndex, writeIndex, type CachedSession } from "./index-cache.ts";

export interface Prompt {
  text: string;
  cwd: string;
  timestamp: number;
}

const cache = new Map<string, CachedSession>();
const pending = new Map<string, Promise<void>>();

/** Collect all user turns (including abandoned branches) from persisted sessions. */
export async function loadPrompts(sessionRoot: string, sharedDirectory: boolean, indexPath?: string): Promise<Prompt[]> {
  if (!indexPath) return scanPrompts(sessionRoot, sharedDirectory);
  const previous = pending.get(indexPath) ?? Promise.resolve();
  const run = previous.then(() => scanPrompts(sessionRoot, sharedDirectory, indexPath));
  const settled = run.then(() => {}, () => {});
  pending.set(indexPath, settled);
  try {
    return await run;
  } finally {
    if (pending.get(indexPath) === settled) pending.delete(indexPath);
  }
}

async function scanPrompts(sessionRoot: string, sharedDirectory: boolean, indexPath?: string): Promise<Prompt[]> {
  let directories: string[];
  try {
    directories = sharedDirectory
      ? [sessionRoot]
      : (await readdir(sessionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(sessionRoot, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    directories = [];
  }

  const files: string[] = [];
  for (const directory of directories) {
    try {
      for (const name of await readdir(directory)) {
        if (name.endsWith(".jsonl")) files.push(join(directory, name));
      }
    } catch {
      // A session may be removed while the picker is opening.
    }
  }

  const index = indexPath ? await readIndex(indexPath, sessionRoot) : { files: {}, valid: true };
  const indexed = index.files;
  const next: Record<string, CachedSession> = {};
  let changed = !index.valid;
  const prompts: Prompt[] = [];
  // Bound concurrent reads so a large history doesn't exhaust file descriptors.
  for (let i = 0; i < files.length; i += 16) {
    const batches = await Promise.all(files.slice(i, i + 16).map(async (file) => {
      try {
        const info = await stat(file);
        const previous = indexPath ? indexed[file] : cache.get(file);
        if (previous?.mtimeMs === info.mtimeMs && previous.ctimeMs === info.ctimeMs &&
          previous.ino === info.ino && previous.dev === info.dev && previous.size === info.size) {
          next[file] = previous;
          return previous.prompts;
        }
        const parsed = parseSession(await readFile(file, "utf8"));
        next[file] = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev, size: info.size, prompts: parsed };
        if (!indexPath) cache.set(file, next[file]);
        changed = true;
        return parsed;
      } catch {
        cache.delete(file);
        changed = true;
        return [];
      }
    }));
    for (const batch of batches) prompts.push(...batch);
  }
  if (indexPath && (changed || Object.keys(indexed).length !== Object.keys(next).length)) {
    // A source may have changed or disappeared during the scan. Never retain
    // its old text in the disk index; the next open will read the new version.
    await Promise.all(Object.entries(next).map(async ([file, record]) => {
      try {
        const info = await stat(file);
        if (info.mtimeMs !== record.mtimeMs || info.ctimeMs !== record.ctimeMs ||
          info.ino !== record.ino || info.dev !== record.dev || info.size !== record.size) delete next[file];
      } catch {
        delete next[file];
      }
    }));
    await writeIndex(indexPath, sessionRoot, next);
  }
  return prompts.sort((a, b) => b.timestamp - a.timestamp);
}

export function parseSession(contents: string): Prompt[] {
  const prompts: Prompt[] = [];
  let cwd = "";
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        cwd?: unknown;
        timestamp?: unknown;
        message?: { role?: string; content?: unknown };
      };
      if (entry.type === "session") {
        cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      } else if (entry.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((part): part is { type: "text"; text: string } =>
                part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
            : "";
        if (text.trim()) prompts.push({ text, cwd, timestamp: Date.parse(String(entry.timestamp)) || 0 });
      }
    } catch {
      // Ignore a truncated final line or malformed historical entry.
    }
  }
  return prompts;
}
