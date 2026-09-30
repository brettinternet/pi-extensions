import { getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, Markdown, isKeyRepeat, matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { answered, newDrafts, result, select, type Question, type Result } from "./model.js";

/** One interaction owns its drafts, editor, and cancellation listener. */
export class Questionnaire implements Focusable {
  focused = false;
  private tab = 0;
  private cursor = 0;
  private editing = false;
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
      draft.custom = text.trim();
      if (draft.custom && !questions[this.tab]!.multiSelect) draft.selected.clear();
      this.editing = false;
      this.followCursor = true;
      this.tui.requestRender();
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
    if (this.questions.length === 1) {
      const submit = this.questions[0]!.options.length + 1;
      this.cursor = this.cursor === submit ? 0 : submit;
    } else {
      this.tab = (this.tab + delta + this.questions.length) % this.questions.length;
      this.cursor = 0;
    }
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
    if (matchesKey(data, Key.escape)) { this.finish(true); return; }
    if (matchesKey(data, Key.ctrl("]"))) {
      if (!isKeyRepeat(data)) {
        this.collapsed = !this.collapsed;
        this.editor.focused = this.focused && this.editing && !this.collapsed;
        this.tui.requestRender();
      }
      return;
    }
    if (this.collapsed) return;
    if (this.editing) {
      this.followCursor = true;
      if (this.keys ? this.keys.matches(data, "app.clear") : matchesKey(data, Key.ctrl("c"))) this.editor.setText("");
      else this.editor.handleInput(data);
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
      const submit = q.options.length + 1;
      const up = matchesKey(data, Key.up) || matchesKey(data, "k");
      const down = matchesKey(data, Key.down) || matchesKey(data, "j");
      if (up || down) {
        this.cursor = (this.cursor + (up ? -1 : 1) + submit + 1) % (submit + 1);
        this.offset = 0;
        this.followCursor = true;
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        const draft = this.drafts[this.tab]!;
        if (this.cursor < q.options.length) {
          select(q, draft, this.cursor);
          this.offset = 0;
          this.followCursor = true;
        } else if (matchesKey(data, Key.enter) && !isKeyRepeat(data)) {
          if (this.cursor === q.options.length) {
            this.editing = true;
            this.followCursor = true;
            this.editor.setText(draft.custom);
          } else if (this.drafts.every(answered)) this.finish(false);
        }
      }
    }
    this.tui.requestRender();
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
    const preview = this.editing ? undefined : q.options[this.cursor]?.preview;
    const sideBySide = !!preview && width >= 100;
    const listWidth = sideBySide ? Math.floor(width * 0.4) : width;
    let lines: string[] = [];
    const add = (text: string) => lines.push(...wrapTextWithAnsi(text, listWidth));
    add(theme.fg("text", theme.bold(q.question)));
    let anchor = 0;
    if (this.editing) {
      add(theme.fg("muted", "Your answer (Enter saves; Shift+Enter inserts a newline):"));
      this.editor.focused = this.focused;
      lines.push(...this.editor.render(width));
      const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      anchor = cursorLine < 0 ? Math.max(0, lines.length - 1) : cursorLine;
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
        if (q.options[i]) add(theme.fg("muted", `    ${q.options[i]!.description}`));
        else if (draft.custom) add(theme.fg("muted", `    ${draft.custom}`));
      });
      const active = this.cursor === q.options.length + 1;
      if (active) anchor = lines.length;
      const ready = this.drafts.every(answered);
      const label = this.questions.length === 1 ? "Submit answer" : "Submit answers";
      add(`${active ? theme.fg("accent", "❯ ") : "  "}${theme.fg(active ? "accent" : ready ? "success" : "dim", active ? theme.bold(label) : label)}`);
      if (!ready && this.questions.length > 1) add(theme.fg("dim", `Unanswered: ${this.questions.filter((_, i) => !answered(this.drafts[i]!)).map((question) => question.header).join(", ")}`));
      if (preview) {
        const previewWidth = sideBySide ? width - listWidth - 2 : width;
        let markdown = this.previews.get(preview);
        if (!markdown) { markdown = new Markdown(preview, 0, 0, getMarkdownTheme()); this.previews.set(preview, markdown); }
        const previewLines: string[] = [];
        if (previewWidth >= 5) {
          previewLines.push(theme.fg("accent", `┌${truncateToWidth("─ Preview " + "─".repeat(previewWidth), previewWidth - 2, "")}┐`));
          for (const line of markdown.render(previewWidth - 4)) {
            previewLines.push(theme.fg("accent", "│ ") + truncateToWidth(line, previewWidth - 4, "", true) + theme.fg("accent", " │"));
          }
          previewLines.push(theme.fg("accent", `└${"─".repeat(previewWidth - 2)}┘`));
        } else previewLines.push(...markdown.render(previewWidth));
        if (sideBySide) {
          const choices = lines;
          lines = Array.from({ length: Math.max(choices.length, previewLines.length) }, (_, i) =>
            truncateToWidth(choices[i] ?? "", listWidth, "", true) + "  " + (previewLines[i] ?? ""));
        } else lines.push(...previewLines);
      }
    }
    // In-flow bottom dock: leave room for the transcript; never pad short content.
    const height = Math.max(1, Math.min(12, Math.floor(this.tui.terminal.rows / 2)) - 2);
    if (this.followCursor) {
      if (anchor < this.offset) this.offset = anchor;
      if (anchor >= this.offset + height) this.offset = anchor - height + 1;
    }
    this.maxOffset = Math.max(0, lines.length - height);
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    const help = this.editing ? "Enter save · Shift+Enter newline · Ctrl+] hide · Esc cancel"
      : `↑↓/j/k move · Space/Enter select · Tab ${this.questions.length === 1 ? "submit" : "questions"} · Ctrl+] hide · Esc cancel`;
    const scroll = lines.length > height ? `${this.offset + 1}–${Math.min(this.offset + height, lines.length)}/${lines.length} · Alt+PgUp/PgDn scroll · ` : "";
    return [truncateToWidth(heading, width), ...lines.slice(this.offset, this.offset + height),
      theme.fg("dim", truncateToWidth(`${scroll}${help}`, width)),
    ].map((line) => truncateToWidth(line, width));
  }
}
