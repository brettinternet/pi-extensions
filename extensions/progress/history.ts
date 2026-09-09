import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { parseInference } from "./inference.ts";
import type { SemanticSnapshot } from "./state.ts";

export const PROGRESS_HISTORY_SHORTCUT = "alt+g" as const;
const VISIBLE_HISTORY_LINES = 8;

type BranchEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export interface ProgressHistoryLine {
  kind: "run" | "completed" | "blocked";
  text: string;
}

export function progressHistory(
  branch: readonly BranchEntry[],
  inferenceEntryType: string,
): SemanticSnapshot[] {
  const history: SemanticSnapshot[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== inferenceEntryType) continue;
    try {
      history.push(parseInference(entry.data));
    } catch {
      // Ignore invalid or obsolete metadata.
    }
  }
  return history;
}

export function progressHistoryLines(history: readonly SemanticSnapshot[]): ProgressHistoryLine[] {
  return history.flatMap((semantic, index) => {
    const current = semantic.current ? ` · ${semantic.current}` : "";
    return [
      { kind: "run" as const, text: `${index + 1}. ${semantic.phase}${current}` },
      ...semantic.completed.map((item) => ({ kind: "completed" as const, text: item })),
      ...semantic.blocked.map((item) => ({ kind: "blocked" as const, text: item })),
    ];
  });
}

function historyText(lines: readonly ProgressHistoryLine[]): string {
  if (lines.length === 0) return "No inferred progress history in this branch.";
  return lines.map((line) => {
    const prefix = line.kind === "completed" ? "  ✓ " : line.kind === "blocked" ? "  ! " : "";
    return `${prefix}${line.text}`;
  }).join("\n");
}

class ProgressHistoryOverlay implements Component {
  readonly #lines: readonly ProgressHistoryLine[];
  readonly #theme: Theme;
  readonly #done: () => void;
  #offset: number;

  constructor(lines: readonly ProgressHistoryLine[], theme: Theme, done: () => void) {
    this.#lines = lines;
    this.#theme = theme;
    this.#done = done;
    this.#offset = Math.max(0, lines.length - VISIBLE_HISTORY_LINES);
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const visible = this.#lines.slice(this.#offset, this.#offset + VISIBLE_HISTORY_LINES);
    const body = visible.length > 0
      ? visible.map((line) => {
        const prefix = line.kind === "completed" ? "✓ " : line.kind === "blocked" ? "! " : "";
        const color = line.kind === "completed" ? "success" : line.kind === "blocked" ? "warning" : "text";
        return ` ${this.#theme.fg(color, truncateToWidth(`${prefix}${line.text}`, contentWidth))}`;
      })
      : [` ${this.#theme.fg("muted", "No inferred progress history in this branch.")}`];
    const position = this.#lines.length > VISIBLE_HISTORY_LINES
      ? ` · ${this.#offset + 1}-${Math.min(this.#offset + VISIBLE_HISTORY_LINES, this.#lines.length)}/${this.#lines.length}`
      : "";
    return [
      ` ${this.#theme.fg("accent", this.#theme.bold("Progress history"))}`,
      ...body,
      ` ${this.#theme.fg("dim", `↑↓ scroll · esc close${position}`)}`,
    ].map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const maxOffset = Math.max(0, this.#lines.length - VISIBLE_HISTORY_LINES);
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.#done();
    } else if (matchesKey(data, Key.up)) {
      this.#offset = Math.max(0, this.#offset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.#offset = Math.min(maxOffset, this.#offset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.#offset = Math.max(0, this.#offset - VISIBLE_HISTORY_LINES);
    } else if (matchesKey(data, Key.pageDown)) {
      this.#offset = Math.min(maxOffset, this.#offset + VISIBLE_HISTORY_LINES);
    } else if (matchesKey(data, Key.home)) {
      this.#offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.#offset = maxOffset;
    }
  }

  invalidate(): void {}
}

export async function showProgressHistory(
  ctx: Pick<ExtensionContext, "mode" | "sessionManager" | "ui">,
  inferenceEntryType: string,
): Promise<void> {
  const branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];
  const lines = progressHistoryLines(progressHistory(branch, inferenceEntryType));
  if (ctx.mode !== "tui") {
    ctx.ui.notify(historyText(lines), "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const overlay = new ProgressHistoryOverlay(lines, theme, done);
      return {
        render: (width) => overlay.render(width),
        handleInput: (data) => {
          overlay.handleInput?.(data);
          tui.requestRender();
        },
        invalidate: () => overlay.invalidate(),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "75%",
        minWidth: 44,
        maxHeight: 11,
        offsetY: -4,
        margin: 1,
      },
    },
  );
}
