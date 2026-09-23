import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface Prompt {
  text: string;
  cwd: string;
  timestamp: number;
}

const cache = new Map<string, { mtimeMs: number; size: number; prompts: Prompt[] }>();

/** Collect all user turns (including abandoned branches) from persisted sessions. */
export async function loadPrompts(sessionRoot: string, sharedDirectory: boolean): Promise<Prompt[]> {
  let directories: string[];
  try {
    directories = sharedDirectory
      ? [sessionRoot]
      : (await readdir(sessionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(sessionRoot, entry.name));
  } catch {
    return [];
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

  const prompts: Prompt[] = [];
  // Bound concurrent reads so a large history doesn't exhaust file descriptors.
  for (let i = 0; i < files.length; i += 16) {
    const batches = await Promise.all(files.slice(i, i + 16).map(async (file) => {
      try {
        const info = await stat(file);
        const previous = cache.get(file);
        if (previous?.mtimeMs === info.mtimeMs && previous.size === info.size) return previous.prompts;
        const parsed = parseSession(await readFile(file, "utf8"));
        cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, prompts: parsed });
        return parsed;
      } catch {
        cache.delete(file);
        return [];
      }
    }));
    for (const batch of batches) prompts.push(...batch);
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

export function matchingPrompts(prompts: readonly Prompt[], cwd: string, scope: "project" | "global", query: string): Prompt[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return prompts.filter((prompt) =>
    (scope === "global" || (prompt.cwd && resolve(prompt.cwd) === resolve(cwd))) &&
    words.every((word) => prompt.text.toLocaleLowerCase().includes(word))
  );
}
