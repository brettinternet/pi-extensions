import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  detectSupportedImageMimeTypeFromFile,
  resizeImage,
} from "@earendil-works/pi-coding-agent";

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

export interface ImageAttachment {
  name: string;
  content: ImageContent;
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }

  if (escaped) word += "\\";
  if (word) words.push(word);
  return words;
}

export function droppedFilePaths(data: string, cwd: string): string[] {
  const match = BRACKETED_PASTE.exec(data);
  if (!match) return [];
  return splitShellWords(match[1] ?? "").map((path) => {
    const expanded = path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : path;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  });
}

export async function loadDroppedImages(
  data: string,
  cwd: string,
): Promise<ImageAttachment[]> {
  const paths = droppedFilePaths(data, cwd);
  if (paths.length === 0) return [];

  return Promise.all(paths.map(async (path) => {
    const mimeType = await detectSupportedImageMimeTypeFromFile(path);
    if (!mimeType) throw new Error(`${basename(path)} is not a supported image`);

    const bytes = await readFile(path);
    const resized = await resizeImage(bytes, mimeType);
    if (!resized) throw new Error(`${basename(path)} could not be processed`);
    return {
      name: basename(path),
      content: {
        type: "image",
        data: resized.data,
        mimeType: resized.mimeType,
      },
    };
  }));
}
