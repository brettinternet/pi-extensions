import { getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, Markdown, isKeyRepeat, matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { answered, newDrafts, result, select, type Question, type Result } from "./model.js";

/** One interaction owns its drafts, editor, and cancellation listener. */
export class Questionnaire implements Focusable {
  focused = false;
  private tab = 0;
  private cursor = 0;
  private editing: "custom" | "note" | undefined;
  private collapsed = false;
  private offset = 0;
  private maxOffset = 0;
  private followCursor = true;
  private finished = false;
  private readonly drafts;
  private readonly editor: Editor;
  private readonly previews = new Map<string, Markdown>();
  private readonly abort = () => this.finish(true);

  constructor(private readonly questions: Question[], private readonly tui: TUI, private readonly theme: Theme,
    private readonly done: (value: Result) => void, private readonly signal?: AbortSignal,
    private readonly keys?: Pick<KeybindingsManager, "matches">) {
    this.drafts = newDrafts(questions);
    this.editor = new Editor(tui, {
      borderColor: (s) => theme.fg("accent", s),
      selectList: { selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => theme.fg("warning", s) },
    });
    this.editor.onSubmit = (text) => {
      const draft = this.drafts[this.tab]!;
      const mode = this.editing;
      if (mode === "note") draft.note = text.trim();
      else {
        draft.custom = text.trim();
        if (draft.custom && !questions[this.tab]!.multiSelect) draft.selected.clear();
      }
      this.editing = undefined;
      this.followCursor = true;
      if (mode === "custom" && draft.custom && questions.length === 1) this.finish(false);
      else this.tui.requestRender();
    };
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) queueMicrotask(this.abort);
  }

  dispose(): void { this.signal?.removeEventListener("abort", this.abort); }
  invalidate(): void { this.editor.invalidate(); for (const preview of this.previews.values()) preview.invalidate(); }
  private finish(cancelled: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(result(this.questions, this.drafts, cancelled));
  }
  private moveTab(delta: number): void {
    if (this.questions.length === 1) return;
    this.tab = (this.tab + delta + this.questions.length) % this.questions.length;
    this.cursor = 0;
    this.offset = 0;
    this.followCursor = true;
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished || this.collapsed || event.type !== "wheel" || event.shift || event.alt || event.ctrl ||
      event.x < 0 || event.y < 0 || event.x >= event.width || event.y >= event.height ||
      !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return;
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + Math.trunc(event.wheelDelta)));
    this.followCursor = false;
    this.tui.requestRender();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape)) {
      if (this.editing === "note" && !this.collapsed) {
        this.editing = undefined;
        this.followCursor = true;
        this.tui.requestRender();
      } else this.finish(true);
      return;
    }
    if (matchesKey(data, Key.ctrl("]"))) {
      if (!isKeyRepeat(data)) {
        this.collapsed = !this.collapsed;
        this.editor.focused = this.focused && !!this.editing && !this.collapsed;
        this.tui.requestRender();
      }
      return;
    }
    if (this.collapsed) return;
    if (this.editing) {
      if (matchesKey(data, Key.enter) && isKeyRepeat(data)) return;
      this.followCursor = true;
      if (this.keys ? this.keys.matches(data, "app.clear") : matchesKey(data, Key.ctrl("c"))) this.editor.setText("");
      else this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "n")) {
      this.editing = "note";
      this.editor.setText(this.drafts[this.tab]!.note);
      this.followCursor = true;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { this.moveTab(1); return; }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { this.moveTab(-1); return; }
    // Fullscreen reserves unmodified PageUp/PageDown for the transcript.
    const pageDown = matchesKey(data, Key.alt("pageDown")) || matchesKey(data, Key.pageDown);
    const pageUp = matchesKey(data, Key.alt("pageUp")) || matchesKey(data, Key.pageUp);
    if (pageDown || pageUp) {
      this.offset += pageDown ? 5 : -5;
      this.followCursor = false;
    } else {
      const q = this.questions[this.tab]!;
      const last = q.options.length + (this.questions.length > 1 ? 1 : 0);
      const up = (this.keys?.matches(data, "tui.select.up") ?? matchesKey(data, Key.up)) || matchesKey(data, Key.ctrl("p")) || matchesKey(data, "k");
      const down = (this.keys?.matches(data, "tui.select.down") ?? matchesKey(data, Key.down)) || matchesKey(data, Key.ctrl("n")) || matchesKey(data, "j");
      if (up || down) {
        this.cursor = (this.cursor + (up ? -1 : 1) + last + 1) % (last + 1);
        this.offset = 0;
        this.followCursor = true;
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        if (isKeyRepeat(data)) return;
        const draft = this.drafts[this.tab]!;
        const submitSingle = this.questions.length === 1 && matchesKey(data, Key.enter);
        if (this.cursor < q.options.length) {
          if (submitSingle && q.multiSelect) draft.selected.add(this.cursor);
          else select(q, draft, this.cursor);
          if (submitSingle) { this.finish(false); return; }
          this.offset = 0;
          this.followCursor = true;
        } else if (matchesKey(data, Key.enter) && !isKeyRepeat(data)) {
          if (this.cursor === q.options.length) {
            this.editing = "custom";
            this.followCursor = true;
            this.editor.setText(draft.custom);
          } else if (this.drafts.every(answered)) this.finish(false);
        }
      }
    }
    this.tui.requestRender();
  }

  private renderPreview(text: string, width: number): string[] {
    let markdown = this.previews.get(text);
    if (!markdown) { markdown = new Markdown(text, 0, 0, getMarkdownTheme()); this.previews.set(text, markdown); }
    if (width < 5) return markdown.render(width);
    const border = (line: string) => this.theme.fg("accent", line);
    return [border(`┌${truncateToWidth("─ Preview " + "─".repeat(width), width - 2, "")}┐`),
      ...markdown.render(width - 4).map((line) => border("│ ") + truncateToWidth(line, width - 4, "", true) + border(" │")),
      border(`└${"─".repeat(width - 2)}┘`)];
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    const { theme } = this;
    if (this.collapsed) return [theme.fg("dim", truncateToWidth("Questions hidden · Ctrl+] show · Esc cancel", width))];
    const q = this.questions[this.tab]!;
    const draft = this.drafts[this.tab]!;
    const heading = this.questions.map((question, i) => {
      const label = ` ${answered(this.drafts[i]!) ? "■" : "□"} ${question.header} `;
      return i === this.tab ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(answered(this.drafts[i]!) ? "success" : "muted", label);
    }).join(" ");
    const height = Math.max(1, Math.min(16, Math.floor(this.tui.terminal.rows * 0.6)) - 2);
    const hasPreviews = !this.editing && q.options.some((option) => !!option.preview);
    const sideBySide = hasPreviews && width >= 100;
    const listWidth = sideBySide ? Math.floor(width * 0.4) : width;
    const previewWidth = sideBySide ? width - listWidth - 2 : width;
    const panels = hasPreviews ? q.options.map((option) => option.preview ? this.renderPreview(option.preview, previewWidth) : []) : [];
    const previewLines = panels[this.cursor] ?? [];
    const reservedPreviewHeight = Math.min(height, Math.max(0, ...panels.map((panel) => panel.length)));
    let lines: string[] = [];
    const add = (text: string) => lines.push(...wrapTextWithAnsi(text, listWidth));
    add(theme.fg("text", theme.bold(q.question)));
    let anchor = 0;
    const renderEditor = () => {
      this.editor.focused = this.focused;
      lines.push(...this.editor.render(width));
      const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      anchor = cursorLine < 0 ? Math.max(0, lines.length - 1) : cursorLine;
    };
    if (this.editing === "note") {
      add(theme.fg("muted", "Note (Enter saves; Esc discards changes):"));
      renderEditor();
    } else {
      const labels = [...q.options.map((o) => o.label), "Type something."];
      labels.forEach((label, i) => {
        const active = i === this.cursor;
        if (active) anchor = lines.length;
        const checked = i < q.options.length ? draft.selected.has(i) : !!draft.custom;
        const marker = q.multiSelect ? (checked ? "[✔]" : "[ ]") : (checked ? "●" : "○");
        const pointer = active ? theme.fg("accent", "❯ ") : "  ";
        const styledLabel = active ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
        add(`${pointer}${theme.fg(checked ? "accent" : "muted", marker)} ${styledLabel}`);
        if (i === q.options.length && this.editing === "custom") renderEditor();
        else if (this.editing !== "custom") {
          if (q.options[i]) add(theme.fg("muted", `    ${q.options[i]!.description}`));
          else if (draft.custom) add(theme.fg("muted", `    ${draft.custom}`));
        }
      });
      if (this.questions.length > 1) {
        const active = this.cursor === q.options.length + 1;
        if (active && !this.editing) anchor = lines.length;
        const ready = this.drafts.every(answered);
        add(`${active ? theme.fg("accent", "❯ ") : "  "}${theme.fg(active ? "accent" : ready ? "success" : "dim", active ? theme.bold("Submit answers") : "Submit answers")}`);
        if (!ready) add(theme.fg("dim", `Unanswered: ${this.questions.filter((_, i) => !answered(this.drafts[i]!)).map((question) => question.header).join(", ")}`));
      }
      if (draft.note) add(theme.fg("muted", `Note: ${draft.note}`));
      // Reserve the largest visible preview footprint even on options without one.
      // Keep the column width too, so descriptions do not rewrap on focus changes.
      if (sideBySide) {
        const choices = lines;
        lines = Array.from({ length: Math.max(choices.length, previewLines.length, reservedPreviewHeight) }, (_, i) =>
          truncateToWidth(choices[i] ?? "", listWidth, "", true) + "  " + (previewLines[i] ?? ""));
      } else if (hasPreviews) {
        const reservedHeight = Math.min(height, lines.length + reservedPreviewHeight);
        lines.push(...previewLines);
        while (lines.length < reservedHeight) lines.push("");
      }
    }
    if (this.followCursor) {
      if (anchor < this.offset) this.offset = anchor;
      if (anchor >= this.offset + height) this.offset = anchor - height + 1;
    }
    this.maxOffset = Math.max(0, lines.length - height);
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    const help = this.editing ? `Enter ${this.editing === "custom" && this.questions.length === 1 ? "submit" : "save"} · Shift+Enter newline · Ctrl+] hide · Esc ${this.editing === "note" ? "back" : "cancel"}`
      : this.questions.length === 1 ? "↑↓/j/k move · Space select · Enter submit · n note · Ctrl+] hide · Esc cancel"
      : "↑↓/j/k move · Space/Enter select · Tab questions · n note · Ctrl+] hide · Esc cancel";
    const scroll = lines.length > height ? `${this.offset + 1}–${Math.min(this.offset + height, lines.length)}/${lines.length} · Alt+PgUp/PgDn scroll · ` : "";
    return [truncateToWidth(heading, width), ...lines.slice(this.offset, this.offset + height),
      theme.fg("dim", truncateToWidth(`${scroll}${help}`, width)),
    ].map((line) => truncateToWidth(line, width));
  }
}
