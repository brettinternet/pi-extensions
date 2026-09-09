import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseInference } from "./inference.ts";
import type { SemanticSnapshot } from "./state.ts";

export const PROGRESS_HISTORY_SHORTCUT = "alt+g" as const;
export const PROGRESS_HISTORY_WIDGET_KEY = "pi-progress-history";
const MAX_VISIBLE_HISTORY_LINES = 8;

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

function renderHistory(
  lines: readonly ProgressHistoryLine[],
  theme: Theme,
  width: number,
): string[] {
  const visible = lines.slice(-MAX_VISIBLE_HISTORY_LINES);
  const hidden = lines.length - visible.length;
  const body = visible.length > 0
    ? visible.map((line) => {
      const prefix = line.kind === "completed" ? "✓ " : line.kind === "blocked" ? "! " : "";
      const color = line.kind === "completed" ? "success" : line.kind === "blocked" ? "warning" : "text";
      return theme.fg(color, truncateToWidth(`${prefix}${line.text}`, width));
    })
    : [theme.fg("muted", "No inferred progress history in this branch.")];
  const heading = hidden > 0
    ? `Progress history · ${hidden} earlier lines hidden`
    : "Progress history";
  return [
    theme.fg("accent", heading),
    ...body,
    theme.fg("dim", `${PROGRESS_HISTORY_SHORTCUT} or /progress steps to close`),
  ].map((line) => truncateToWidth(line, width));
}

export function setProgressHistoryVisible(
  ctx: Pick<ExtensionContext, "mode" | "sessionManager" | "ui">,
  inferenceEntryType: string,
  visible: boolean,
): void {
  if (ctx.mode !== "tui") {
    if (visible) {
      const branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];
      ctx.ui.notify(historyText(progressHistoryLines(progressHistory(branch, inferenceEntryType))), "info");
    }
    return;
  }

  if (!visible) {
    ctx.ui.setWidget(PROGRESS_HISTORY_WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(
    PROGRESS_HISTORY_WIDGET_KEY,
    (_tui, theme): Component => ({
      render: (width) => {
        const branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];
        return renderHistory(
          progressHistoryLines(progressHistory(branch, inferenceEntryType)),
          theme,
          width,
        );
      },
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}
