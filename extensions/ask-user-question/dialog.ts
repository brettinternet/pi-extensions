import { getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, Markdown, isKeyRepeat, matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { answered, newDrafts, result, select, summary, type Question, type Result } from "./model.js";

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
      if (!draft.custom) {
        this.editing = false;
        this.followCursor = true;
        this.tui.requestRender();
        return;
      }
      if (!questions[this.tab]!.multiSelect) draft.selected.clear();
      this.editing = false;
      this.moveTab(1);
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
    this.tab = (this.tab + delta + this.questions.length + 1) % (this.questions.length + 1);
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
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
      this.offset += matchesKey(data, Key.pageDown) ? 5 : -5;
      this.followCursor = false;
    } else {
      const q = this.questions[this.tab];
      if (!q) {
        if (matchesKey(data, Key.enter) && this.drafts.every(answered)) this.finish(false);
      } else {
        const last = q.options.length + (q.multiSelect ? 1 : 0);
        const up = matchesKey(data, Key.up) || matchesKey(data, "k");
        const down = matchesKey(data, Key.down) || matchesKey(data, "j");
        if (up || down) {
          this.cursor = (this.cursor + (up ? -1 : 1) + last + 1) % (last + 1);
          this.offset = 0;
          this.followCursor = true;
        } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
          const draft = this.drafts[this.tab]!;
          if (this.cursor < q.options.length) {
            select(q, draft, this.cursor);
            if (!q.multiSelect) this.moveTab(1);
          } else if (this.cursor === q.options.length) {
            this.editing = true;
            this.followCursor = true;
            this.editor.setText(draft.custom);
          } else if (answered(draft)) this.moveTab(1);
        }
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    if (this.collapsed) return [this.theme.fg("dim", truncateToWidth("Questions hidden · Ctrl+] show · Esc cancel", width))];
    const q = this.questions[this.tab];
    const tabs = [...this.questions.map((question, i) => `${answered(this.drafts[i]!) ? "✓" : "○"} ${question.header}`), "Submit"];
    const heading = truncateToWidth(tabs.map((label, i) => i === this.tab ? `[${label}]` : label).join(" · "), width);
    const lines: string[] = [];
    const add = (text: string) => lines.push(...wrapTextWithAnsi(text, width));
    let anchor = 0;
    if (q) {
      add(this.theme.fg("accent", q.question));
      const draft = this.drafts[this.tab]!;
      if (this.editing) {
        add("Your answer (Enter saves; Shift+Enter inserts a newline):");
        this.editor.focused = this.focused;
        lines.push(...this.editor.render(width));
        const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
        anchor = cursorLine < 0 ? Math.max(0, lines.length - 1) : cursorLine;
      } else {
        const labels = [...q.options.map((o) => o.label), "Type something.", ...(q.multiSelect ? ["Continue"] : [])];
        labels.forEach((label, i) => {
          if (i === this.cursor) anchor = lines.length;
          const checked = i < q.options.length ? draft.selected.has(i) : i === q.options.length && !!draft.custom;
          add(`${i === this.cursor ? "❯" : " "} ${checked ? "[✓]" : "[ ]"} ${label}`);
          if (q.options[i]) add(this.theme.fg("muted", `    ${q.options[i]!.description}`));
          else if (i === q.options.length && draft.custom) add(`    ${draft.custom}`);
        });
        const preview = q.options[this.cursor]?.preview;
        if (preview) {
          add(this.theme.fg("dim", "─ Preview ─"));
          let markdown = this.previews.get(preview);
          if (!markdown) { markdown = new Markdown(preview, 0, 0, getMarkdownTheme()); this.previews.set(preview, markdown); }
          lines.push(...markdown.render(width));
        }
      }
    } else {
      add("Review your answers");
      add(summary(result(this.questions, this.drafts, false)));
      const missing = this.questions.filter((_, i) => !answered(this.drafts[i]!));
      add(missing.length ? `Unanswered: ${missing.map((question) => question.header).join(", ")}` : "Enter to submit answers");
    }
    // This is an in-flow editor replacement, not an overlay. Leave the transcript
    // room above the dock even when an option contains a very long preview.
    const height = Math.max(1, Math.min(12, Math.floor(this.tui.terminal.rows / 2)) - 2);
    if (this.followCursor) {
      if (anchor < this.offset) this.offset = anchor;
      if (anchor >= this.offset + height) this.offset = anchor - height + 1;
    }
    this.maxOffset = Math.max(0, lines.length - height);
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
    const help = this.editing ? "Ctrl+] hide · Enter save · Shift+Enter newline · Esc cancel" : "Ctrl+] hide · Tab tabs · ↑↓/j/k choose · Enter/Space select · Esc cancel";
    const scroll = lines.length > height ? `${this.offset + 1}–${Math.min(this.offset + height, lines.length)}/${lines.length} · PgUp/PgDn scroll · ` : "";
    return [this.theme.fg("accent", heading), ...lines.slice(this.offset, this.offset + height),
      this.theme.fg("dim", truncateToWidth(`${scroll}${help}`, width)),
    ].map((line) => truncateToWidth(line, width));
  }
}
