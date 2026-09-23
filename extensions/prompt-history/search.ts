import { resolve } from "node:path";
import type { Prompt } from "./history.ts";

export interface SearchResult {
  prompt: Prompt;
  preview: string;
  /** UTF-16 offsets into preview for the highlighted query spans. */
  ranges: Array<[number, number]>;
  score: number;
  tier: number;
}

export function previewText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function originalRanges(preview: string, ranges: Array<[number, number]>): Array<[number, number]> {
  if (!ranges.length) return [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of preview) {
    const lower = character.toLocaleLowerCase();
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  return ranges.map(([start, end]) => [starts[start]!, ends[end - 1]!]);
}

export function searchPrompts(prompts: readonly Prompt[], cwd: string, scope: "project" | "global", query: string): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const words = needle.split(" ").filter(Boolean);
  const matches: SearchResult[] = [];
  for (const prompt of prompts) {
    if (scope === "project" && (!prompt.cwd || resolve(prompt.cwd) !== resolve(cwd))) continue;
    const preview = previewText(prompt.text);
    if (!needle) {
      matches.push({ prompt, preview, ranges: [], score: 0, tier: 0 });
      continue;
    }

    const text = preview.toLocaleLowerCase();
    const phrase = text.indexOf(needle);
    if (phrase >= 0) {
      matches.push({ prompt, preview, ranges: originalRanges(preview, [[phrase, phrase + needle.length]]), score: -phrase, tier: 3 });
      continue;
    }

    const positions = words.map((word) => text.indexOf(word));
    if (positions.every((position) => position >= 0)) {
      const span = Math.max(...positions.map((position, index) => position + words[index]!.length)) - Math.min(...positions);
      const ranges = originalRanges(preview, positions.map((position, index): [number, number] => [position, position + words[index]!.length]));
      matches.push({ prompt, preview, ranges, score: -span - Math.min(...positions), tier: 2 });
      continue;
    }

    // A short, bounded subsequence finds typos without matching arbitrary letters
    // scattered through a very long prompt.
    const characters = [...needle.replace(/\s/g, "")];
    if (characters.length < 3) continue;
    const ranges: Array<[number, number]> = [];
    let next = 0;
    for (const character of characters) {
      const position = text.indexOf(character, next);
      if (position < 0 || (ranges.length > 0 && position - next > 8)) break;
      ranges.push([position, position + character.length]);
      next = position + character.length;
    }
    if (ranges.length === characters.length && next - ranges[0]![0] <= characters.length * 3) {
      matches.push({ prompt, preview, ranges: originalRanges(preview, ranges),
        score: -(next - ranges[0]![0]) - ranges[0]![0], tier: 1 });
    }
  }
  return matches.sort((a, b) => b.tier - a.tier || b.score - a.score || b.prompt.timestamp - a.prompt.timestamp);
}
