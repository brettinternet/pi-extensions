// Port of Oh My Pi's MIT-licensed live visualizer to Pi's public editor API.
import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { WorkStatus } from "./activity-tracker.ts";
import {
  type EditorTheme,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type LivePhase =
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "muted"
  | "error";

export interface LiveVisualizerOptions {
  onStop(): void;
  onToggleMute(): void;
  onDrop(data: string): void;
}

export class LiveVisualizer extends CustomEditor {
  readonly #tui: TUI;
  readonly #keybindings: KeybindingsManager;
  readonly #colors: Theme;
  readonly #options: LiveVisualizerOptions;
  #phase: LivePhase = "connecting";
  #inputLevel = 0;
  #displayLevel = 0;
  #frame = 0;
  #userTranscript = "";
  #agentTranscript = "";
  #attachmentCount = 0;
  #workStatus: WorkStatus = { queued: 0, active: 0, failed: 0 };

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    colors: Theme,
    options: LiveVisualizerOptions,
  ) {
    super(tui, editorTheme, keybindings);
    this.#tui = tui;
    this.#keybindings = keybindings;
    this.#colors = colors;
    this.#options = options;
  }

  setPhase(phase: LivePhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#tui.requestRender();
  }

  setInputLevel(level: number): void {
    const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (this.#inputLevel === next) return;
    this.#inputLevel = next;
    this.#displayLevel = Math.max(this.#displayLevel, next);
  }

  setUserTranscript(text: string): void {
    this.#setTranscript("user", text);
  }

  setAgentTranscript(text: string): void {
    this.#setTranscript("agent", text);
  }

  #setTranscript(role: "user" | "agent", text: string): void {
    const normalized = text.replaceAll("\t", " ").replace(/\s+/g, " ").trim();
    if (role === "user") {
      if (this.#userTranscript === normalized) return;
      this.#userTranscript = normalized;
    } else {
      if (this.#agentTranscript === normalized) return;
      this.#agentTranscript = normalized;
    }
    this.#tui.requestRender();
  }

  setAttachmentCount(count: number): void {
    if (this.#attachmentCount === count) return;
    this.#attachmentCount = count;
    this.#tui.requestRender();
  }

  setWorkStatus(status: WorkStatus): void {
    if (
      this.#workStatus.queued === status.queued &&
      this.#workStatus.active === status.active &&
      this.#workStatus.failed === status.failed
    ) return;
    this.#workStatus = status;
    this.#tui.requestRender();
  }

  advanceFrame(): void {
    this.#frame += 1;
    this.#displayLevel = Math.max(this.#inputLevel, this.#displayLevel * 0.84);
    this.#tui.requestRender();
  }

  override handleInput(data: string): void {
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      this.#options.onDrop(data);
      return;
    }
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "ctrl+l")
    ) {
      this.#options.onStop();
      return;
    }
    if (matchesKey(data, "space")) {
      this.#options.onToggleMute();
      return;
    }
    if (this.onExtensionShortcut?.(data)) return;
    for (const [action, handler] of this.actionHandlers) {
      if (this.#keybindings.matches(data, action)) {
        handler();
        return;
      }
    }
  }

  override render(maxWidth: number): string[] {
    const width = Math.max(2, maxWidth);
    const innerWidth = width - 2;
    const border = (content: string) =>
      this.#colors.fg("border", "│") +
      content +
      (width > 1 ? this.#colors.fg("border", "│") : "");
    const top = this.#colors.fg(
      "border",
      `┌${"─".repeat(innerWidth)}${width > 1 ? "┐" : ""}`,
    );
    const spectrumColor: ThemeColor =
      this.#phase === "muted"
        ? "dim"
        : this.#phase === "error"
          ? "error"
          : "success";
    const spectrum = this.#generateSpectrum(innerWidth, 2).map((row) =>
      border(this.#colors.fg(spectrumColor, row)),
    );
    const attachmentRows = this.#attachmentCount > 0
      ? [this.#paddedBorder(
          `📎 ${this.#attachmentCount} image${this.#attachmentCount === 1 ? "" : "s"} attached`,
          innerWidth,
          "muted",
          border,
        )]
      : [];
    const userTranscriptRows = this.#renderTranscript(
      "You",
      this.#userTranscript,
      innerWidth,
      "accent",
      border,
    );
    const agentTranscriptRows = this.#renderTranscript(
      "Live",
      this.#agentTranscript,
      innerWidth,
      "success",
      border,
    );
    return [
      top,
      ...spectrum,
      ...attachmentRows,
      ...userTranscriptRows,
      ...agentTranscriptRows,
      this.#renderFooter(width, innerWidth),
    ];
  }

  #renderTranscript(
    label: string,
    transcript: string,
    width: number,
    color: ThemeColor,
    border: (content: string) => string,
  ): string[] {
    if (!transcript) return [];
    const badge = this.#colors.fg(
      color,
      this.#colors.inverse(` ${label} `),
    );
    const content = `${badge} ${this.#colors.fg(color, transcript)}`;
    return wrapTextWithAnsi(content, width).map((line) =>
      border(
        line + " ".repeat(Math.max(0, width - visibleWidth(line))),
      )
    );
  }

  #paddedBorder(
    text: string,
    width: number,
    color: ThemeColor,
    border: (content: string) => string,
  ): string {
    const line = truncateToWidth(text, width);
    return border(
      this.#colors.fg(color, line) +
        " ".repeat(Math.max(0, width - visibleWidth(line))),
    );
  }

  #renderFooter(width: number, innerWidth: number): string {
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const staticIcons: Record<LivePhase, string> = {
      connecting: "○",
      listening: "●",
      working: "○",
      speaking: "»",
      muted: "×",
      error: "!",
    };
    const phaseColors: Record<LivePhase, ThemeColor> = {
      connecting: "dim",
      listening: "success",
      working: "warning",
      speaking: "accent",
      muted: "dim",
      error: "error",
    };
    const icon =
      this.#phase === "working"
        ? spinners[this.#frame % spinners.length]
        : staticIcons[this.#phase];
    const work = [
      this.#workStatus.active > 0 ? `${this.#workStatus.active} active` : "",
      this.#workStatus.queued > 0 ? `${this.#workStatus.queued} queued` : "",
      this.#workStatus.failed > 0 ? `${this.#workStatus.failed} failed` : "",
    ].filter(Boolean).join(" · ");
    const workLabel = work ? ` · ${work}` : "";
    const fullLabel = ` ${icon} ${this.#phase}${workLabel} · space mute · esc end `;
    const shortLabel = ` ${icon} ${this.#phase}${workLabel} `;
    const label =
      innerWidth >= visibleWidth(fullLabel) + 1
        ? fullLabel
        : innerWidth >= visibleWidth(shortLabel) + 1
          ? shortLabel
          : "";
    if (!label) {
      return this.#colors.fg(
        "border",
        `└${"─".repeat(innerWidth)}${width > 1 ? "┘" : ""}`,
      );
    }
    const remaining = Math.max(0, innerWidth - visibleWidth(label) - 1);
    return (
      this.#colors.fg("border", "└─") +
      this.#colors.fg(
        phaseColors[this.#phase],
        truncateToWidth(label, innerWidth - 1),
      ) +
      this.#colors.fg(
        "border",
        `${"─".repeat(remaining)}${width > 1 ? "┘" : ""}`,
      )
    );
  }

  #generateSpectrum(width: number, rows: number): string[] {
    const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const output = Array.from({ length: rows }, () => "");
    const energy =
      this.#phase === "muted" ? 0 : Math.min(1, Math.sqrt(this.#displayLevel * 5));
    const maxHeight = rows * (blocks.length - 1);
    for (let column = 0; column < width; column += 1) {
      const carrier = 0.5 + 0.5 * Math.sin(this.#frame * 0.43 + column * 0.71);
      const shimmer = 0.5 + 0.5 * Math.sin(this.#frame * 0.19 - column * 1.17);
      const height = Math.round(
        energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight,
      );
      for (let row = 0; row < rows; row += 1) {
        const units = Math.max(
          0,
          Math.min(blocks.length - 1, height - (rows - row - 1) * 8),
        );
        output[row] += blocks[units];
      }
    }
    return output;
  }
}
