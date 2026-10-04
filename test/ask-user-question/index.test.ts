import { describe, expect, test } from "bun:test";
import { initTheme, type KeybindingsManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Text, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
// Exercise the installed host's actual fixed-dock layout, not an overlay mock.
import { createChatViewport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { Value } from "typebox/value";
import extension, { askNative } from "../../extensions/ask-user-question/index.js";
import { Questionnaire } from "../../extensions/ask-user-question/dialog.js";
import { parameters, summary, validate, type Question, type Result } from "../../extensions/ask-user-question/model.js";

const question: Question = { header: "Store", question: "Which store?", options: [
  { label: "SQLite", description: "Embedded storage" }, { label: "Postgres", description: "Remote storage" },
] };
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as Theme;
function dialog(questions = [question], signal?: AbortSignal, keys?: Pick<KeybindingsManager, "matches">) {
  const results: Result[] = [];
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const ui = new Questionnaire(questions, tui as unknown as TUI, theme, (value) => results.push(value), signal, keys);
  return { ui, results, tui };
}
const enter = "\r", down = "\x1b[B", tab = "\t", escape = "\x1b";
const wheel = (wheelDelta: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: "wheel", button: "none", x: 5, y: 5, screenX: 5, screenY: 5, width: 80, height: 20,
  shift: false, alt: false, ctrl: false, wheelDelta, ...overrides,
});

describe("schema", () => {
  test("limits question count, option count and labels", () => {
    expect(Value.Check(parameters, { questions: [question] })).toBe(true);
    for (const questions of [[], Array(5).fill(question), [{ ...question, header: "x".repeat(17) }], [{ ...question, options: [question.options[0]] }]]) {
      expect(Value.Check(parameters, { questions })).toBe(false);
    }
  });
  test("rejects unknown fields at every input level, including misplaced previews", () => {
    for (const params of [
      { questions: [question], extra: true },
      { questions: [{ ...question, preview: "wrong level" }] },
      { questions: [{ ...question, options: question.options.map((o) => ({ ...o, extra: true })) }] },
    ]) expect(Value.Check(parameters, params)).toBe(false);
    expect(Value.Check(parameters, { questions: [{ ...question, options: question.options.map((o) => ({ ...o, preview: "correct level" })) }] })).toBe(true);
  });
  test("rejects reserved, duplicate, blank and multi-preview options", () => {
    for (const label of ["Other", " TYPE SOMETHING. ", "", "Postgres"]) {
      expect(() => validate([{ ...question, options: [{ ...question.options[0]!, label }, question.options[1]!] }])).toThrow();
    }
    expect(() => validate([{ ...question, multiSelect: true, options: question.options.map((o) => ({ ...o, preview: "hi" })) }])).toThrow();
  });
});

describe("terminal questionnaire", () => {
  test("Ctrl+] collapses without losing choices, tabs, or unfinished text", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }]);
    ui.focused = true;
    ui.handleInput(" "); ui.handleInput("j"); ui.handleInput("j"); ui.handleInput(enter);
    ui.handleInput("unfinished");
    ui.handleInput("\x1d");
    expect(ui.render(80)).toEqual(["Questions hidden · Ctrl+] show · Esc cancel"]);
    expect(ui.handleMouse(wheel(3))).toBeUndefined();
    ui.handleInput("accidental typing"); ui.handleInput(tab); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput("\x1d");
    expect(ui.render(80).join("\n")).toContain("unfinished");
    ui.handleInput(" answer"); ui.handleInput(enter);
    expect(results).toHaveLength(1);
    expect(results[0]?.answers[0]).toMatchObject({ selected: ["SQLite"], custom: "unfinished answer" });
  });
  test("n saves an optional note without submitting or changing the selection", () => {
    const { ui, results } = dialog();
    ui.handleInput(" "); ui.handleInput("n"); ui.handleInput("Keep backups");
    ui.handleInput("\x1d"); ui.handleInput("\x1d"); ui.handleInput(" nightly");
    ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("● SQLite");
    expect(ui.render(80).join("\n")).toContain("Note: Keep backups nightly");
    ui.handleInput("\x1b[13;1:2u");
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ selected: ["SQLite"], note: "Keep backups nightly" });
    expect(summary(results[0]!)).toContain("Note: Keep backups nightly");
  });
  test("notes can be edited, discarded with Escape, or removed without losing the answer", () => {
    const { ui, results } = dialog();
    ui.handleInput(" "); ui.handleInput("n"); ui.handleInput("original"); ui.handleInput(enter);
    ui.handleInput("n"); ui.handleInput(" changed"); ui.handleInput(escape);
    expect(ui.render(80).join("\n")).toContain("Note: original");
    expect(ui.render(80).join("\n")).not.toContain("changed");
    ui.handleInput("n"); ui.handleInput("\x03"); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ selected: ["SQLite"] });
    expect(results[0]?.answers[0]?.note).toBeUndefined();
  });
  test("notes are scoped to questions and do not count as answers", () => {
    const { ui, results } = dialog([question, { ...question, header: "Second" }]);
    ui.handleInput("n"); ui.handleInput("First note"); ui.handleInput(enter);
    ui.handleInput(tab); ui.handleInput(tab); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("Unanswered: Store, Second");
    ui.handleInput(tab); ui.handleInput(enter);
    ui.handleInput("n"); ui.handleInput("Second note"); ui.handleInput(enter);
    ui.handleInput(enter); ui.handleInput(enter);
    expect(results[0]?.answers.map((a) => a.note)).toEqual(["First note", "Second note"]);
  });
  test("preview and empty options keep the same height and column width", () => {
    initTheme("dark", false);
    const questions = [{ ...question, options: [
      { label: "Plain", description: "No extra detail" },
      { label: "Short", description: "Small detail", preview: "Short preview" },
      { label: "Long", description: "Large detail", preview: "Long preview\n\n".repeat(40) },
    ] }];
    for (const width of [80, 120]) {
      const { ui } = dialog(questions);
      const plain = ui.render(width);
      expect(plain.join("\n")).not.toContain("┌─ Preview");
      expect(plain.join("\n")).not.toContain("No preview available");
      ui.handleInput(down); const short = ui.render(width);
      ui.handleInput(down); const long = ui.render(width);
      ui.handleInput(down); const custom = ui.render(width);
      expect(short.length).toBe(plain.length);
      expect(long.length).toBe(plain.length);
      expect(custom.length).toBe(plain.length);
      expect(short.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(long.every((line) => visibleWidth(line) <= width)).toBe(true);
      ui.dispose();
    }
  });
  test("collapse retains scroll position and ignores held shortcut repeats", () => {
    const { ui } = dialog([{ ...question, question: "Question\n".repeat(40) }]);
    ui.render(80); ui.handleMouse(wheel(3));
    const before = ui.render(80);
    ui.handleInput("\x1b[93;5u");
    ui.handleInput("\x1b[93;5:2u");
    expect(ui.render(80)).toHaveLength(1);
    ui.handleInput("\x1b[93;5u");
    expect(ui.render(80)).toEqual(before);
    ui.dispose();
  });
  test("collapsed questionnaire still cancels on Escape or abort", () => {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const { ui, results } = dialog([question], controller.signal);
      ui.handleInput("\x1d");
      if (abort) controller.abort(); else ui.handleInput(escape);
      expect(results).toEqual([{ cancelled: true, answers: [] }]);
    }
  });
  test("dock reserves transcript space and collapse reveals more of the reply", () => {
    const { ui, tui } = dialog([{ ...question, question: "Question\n".repeat(40) }]);
    const document = new Container();
    document.addChild(new Text(Array.from({ length: 80 }, (_, i) => `Agent reply line ${i}`).join("\n"), 0, 0));
    const editor = new Container(); editor.addChild(ui);
    const viewport = createChatViewport({ document, editor, pendingMessages: new Container(), status: new Container(), footer: new Container() });
    const frame = () => renderLayoutFrame(viewport.root, 80, tui.terminal.rows, () => {});
    for (const rows of [12, 24, 50]) {
      tui.terminal.rows = rows;
      const expanded = frame();
      expect(ui.render(80).length).toBe(Math.min(16, Math.floor(rows * 0.6)));
      expect(expanded.lines.join("\n")).toContain("Agent reply line 79");
      const expandedHeight = viewport.transcript.viewportHeight;
      expect(expandedHeight).toBeGreaterThanOrEqual(Math.ceil(rows * 0.4));
      ui.handleInput("\x1d");
      const collapsed = frame();
      expect(viewport.transcript.viewportHeight).toBeGreaterThan(expandedHeight);
      expect(collapsed.lines.join("\n")).toContain("Agent reply line 79");
      viewport.transcript.scrollToStart();
      expect(frame().lines.join("\n")).toContain("Agent reply line 0");
      viewport.transcript.scrollToEnd();
      expect(frame().lines.join("\n")).toContain("Agent reply line 79");
      ui.handleInput("\x1d");
    }
    ui.dispose();
  });
  test("uses themed focus, selection, tabs and previews without padding short lists", () => {
    initTheme("dark", false);
    const calls: [string, string][] = [];
    const styled = { ...theme,
      fg: (color: string, text: string) => { calls.push([color, text]); return text; },
      bg: (color: string, text: string) => { calls.push([color, text]); return text; },
      bold: (text: string) => { calls.push(["bold", text]); return text; },
    } as Theme;
    const tui = { requestRender() {}, terminal: { rows: 40 } } as unknown as TUI;
    const ui = new Questionnaire([question], tui, styled, () => {});
    ui.handleInput(" ");
    const lines = ui.render(80);
    expect(lines.length).toBeLessThan(12);
    expect(lines).not.toContain("");
    expect(calls).toContainEqual(["accent", "●"]);
    expect(calls).toContainEqual(["accent", "❯ "]);
    expect(calls).toContainEqual(["bold", "SQLite"]);
    expect(calls).toContainEqual(["muted", "    Embedded storage"]);
    expect(calls).toContainEqual(["selectedBg", " ■ Store "]);
    ui.dispose();
    const preview = new Questionnaire([{ ...question, options: [{ ...question.options[0]!, preview: "# Example" }, question.options[1]!] }], tui, styled, () => {});
    preview.render(80);
    expect(calls.some(([color, text]) => color === "accent" && text.startsWith("┌─ Preview"))).toBe(true);
    preview.dispose();
  });
  test("Space selects in place; Enter submits the focused single choice", () => {
    const { ui, results } = dialog();
    const height = ui.render(80).length;
    ui.handleInput(" ");
    expect(ui.render(80).join("\n")).toContain("■ Store");
    expect(ui.render(80).join("\n")).toContain("❯ ● SQLite");
    expect(ui.render(80).join("\n")).not.toContain("Review your answers");
    ui.handleInput(down); ui.handleInput(" ");
    expect(ui.render(80).join("\n")).toContain("❯ ● Postgres");
    expect(ui.render(80).length).toBe(height);
    expect(ui.render(80).join("\n")).not.toContain("Submit answer");
    expect(ui.render(80).join("\n")).not.toContain("[ ]");
    ui.handleInput(tab);
    expect(ui.render(80).join("\n")).toContain("❯ ● Postgres");
    expect(results).toHaveLength(0);
    ui.handleInput("k"); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
  });
  test("Space cannot accidentally open custom editing and multi-select Enter keeps checked choices", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }]);
    ui.handleInput(" "); ui.handleInput(down); ui.handleInput(down); ui.handleInput(" ");
    expect(ui.render(80).join("\n")).not.toContain("Your answer");
    ui.handleInput(down); ui.handleInput(" ");
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
    ui.dispose();
  });
  test("Enter submits once and ignores repeat events before confirmation", () => {
    const { ui, results } = dialog();
    ui.handleInput("\x1b[13;1:2u");
    expect(results).toHaveLength(0);
    ui.handleInput(enter); ui.handleInput(enter); ui.handleInput(escape);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
    expect(results).toHaveLength(1);
  });
  test("vim keys navigate without intercepting literal editor input", () => {
    const { ui, results } = dialog();
    ui.handleInput("j"); ui.handleInput("k");
    expect(ui.render(80).join("\n")).toContain("❯ ○ SQLite");
    ui.handleInput("j"); ui.handleInput("j"); ui.handleInput(enter);
    ui.handleInput("j"); ui.handleInput("k"); ui.handleInput(enter); ui.handleInput(tab); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.custom).toBe("jk");
  });
  test("Ctrl+N/P navigate by default, including Kitty encoded keys", () => {
    const { ui, results } = dialog();
    ui.handleInput("\x1b[110;5u");
    expect(ui.render(80).join("\n")).toContain("❯ ○ Postgres");
    ui.handleInput("\x1b[112;5:1u");
    expect(ui.render(80).join("\n")).toContain("❯ ○ SQLite");
    ui.handleInput("\x0e"); ui.handleInput("\x10"); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
  });
  test("respects configured selection navigation such as Ctrl+P and Ctrl+N", () => {
    const { ui, results } = dialog([question], undefined, {
      matches: (data, action) => action === "tui.select.up" && data === "\x10" || action === "tui.select.down" && data === "\x0e",
    });
    ui.handleInput("\x0e");
    expect(ui.render(80).join("\n")).toContain("❯ ○ Postgres");
    ui.handleInput("\x10");
    expect(ui.render(80).join("\n")).toContain("❯ ○ SQLite");
    ui.handleInput("\x0e"); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["Postgres"]);
  });
  test("Kitty-encoded Space toggles a multi-select choice", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }]);
    ui.handleInput("\x1b[32u"); ui.handleInput(tab); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
  });
  test("app.clear clears the entire multiline draft with default or remapped binding", () => {
    for (const key of ["ctrl+c", "ctrl+x"] as const) {
      const { ui, results } = dialog([question], undefined, { matches: (data, action) => action === "app.clear" && data === (key === "ctrl+c" ? "\x03" : "\x18") });
      ui.handleInput("j"); ui.handleInput("j"); ui.handleInput(enter);
      ui.handleInput("\x1b[200~first\nsecond\x1b[201~");
      ui.handleInput(key === "ctrl+c" ? "\x03" : "\x18");
      expect(results).toHaveLength(0);
      ui.handleInput("replacement"); ui.handleInput(enter); ui.handleInput(tab); ui.handleInput(enter);
      expect(results[0]?.answers[0]?.custom).toBe("replacement");
    }
  });
  test("Enter advances through questions to Review without submitting or accepting repeats", () => {
    const { ui, results } = dialog([question, { ...question, question: "Second question?", header: "Second" }]);
    ui.handleInput(" ");
    expect(ui.render(120).join("\n")).toContain("Which store?");
    ui.handleInput(enter);
    expect(ui.render(120).join("\n")).toContain("Second question?");
    ui.handleInput("\x1b[13;1:2u");
    expect(ui.render(120).join("\n")).toContain("Second question?");
    ui.handleInput(enter);
    expect(ui.render(120).join("\n")).toContain("Review your answers");
    ui.handleInput("\x1b[13;1:2u");
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers.map((a) => a.selected)).toEqual([["SQLite"], ["SQLite"]]);
  });
  test("multi-question Enter confirms checked choices without toggling or adding focused options", () => {
    for (const focusChecked of [false, true]) {
      const { ui, results } = dialog([{ ...question, multiSelect: true }, question]);
      ui.handleInput(" ");
      if (!focusChecked) ui.handleInput(down);
      ui.handleInput(enter); ui.handleInput(enter);
      expect(results).toHaveLength(0);
      ui.handleInput(enter);
      expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
    }
    const { ui, results } = dialog([{ ...question, multiSelect: true }, question]);
    ui.handleInput(down); ui.handleInput(enter); ui.handleInput(enter); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["Postgres"]);
  });
  test("Ctrl+H/L/B/F navigate questions and Review in legacy and Kitty encodings", () => {
    for (const [previous, next] of [["\x08", "\x0c"], ["\x02", "\x06"],
      ["\x1b[104;5u", "\x1b[108;5u"], ["\x1b[98;5u", "\x1b[102;5u"]]) {
      const { ui, results } = dialog([question, { ...question, question: "Second question?" }]);
      ui.handleInput(next!);
      expect(ui.render(120).join("\n")).toContain("Second question?");
      ui.handleInput(next!);
      expect(ui.render(120).join("\n")).toContain("Review your answers");
      ui.handleInput(previous!);
      expect(ui.render(120).join("\n")).toContain("Second question?");
      ui.handleInput(previous!);
      expect(ui.render(120).join("\n")).toContain("Which store?");
      expect(results).toHaveLength(0);
      ui.dispose();
      const single = dialog();
      single.ui.handleInput(previous!); single.ui.handleInput(next!);
      expect(single.ui.render(120).join("\n")).toContain("Which store?");
      single.ui.dispose();
    }
  });
  test("question shortcuts stay inside custom and note editors", () => {
    for (const note of [false, true]) {
      const { ui, results } = dialog([question, { ...question, question: "Second question?" }]);
      if (note) ui.handleInput("n");
      else { ui.handleInput("k"); ui.handleInput(enter); }
      ui.handleInput("abc");
      for (const key of ["\x02", "\x06", "\x08", "\x0c", "\x1b[104;5u", "\x1b[108;5u", "\x1b[98;5u", "\x1b[102;5u"]) {
        ui.handleInput(key);
        expect(ui.render(120).join("\n")).toContain("Which store?");
        expect(ui.render(120).join("\n")).not.toContain("Second question?");
      }
      expect(results).toHaveLength(0);
      ui.dispose();
    }
  });
  test("blank custom confirmation stays put; nonblank confirmation advances to Review", () => {
    const { ui, results } = dialog([question, question]);
    ui.handleInput(enter); ui.handleInput("k"); ui.handleInput(enter); ui.handleInput(enter);
    expect(ui.render(120).join("\n")).not.toContain("Review your answers");
    ui.handleInput(enter); ui.handleInput("Redis"); ui.handleInput(enter);
    expect(ui.render(120).join("\n")).toContain("Review your answers");
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers[1]?.custom).toBe("Redis");
  });
  test("cannot submit incomplete questions", () => {
    const { ui, results } = dialog([question, { ...question, header: "Second" }]);
    ui.handleInput(enter); ui.handleInput(tab); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("Unanswered: Second");
    ui.handleInput("\x1b[Z"); ui.handleInput(down); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers.map((answer) => answer.selected)).toEqual([["SQLite"], ["Postgres"]]);
  });
  test("only the final Review tab submits and shows updated choices, custom answers and notes", () => {
    const { ui, results } = dialog([question, { ...question, header: "Second", multiSelect: true }]);
    expect(ui.render(100).join("\n")).not.toContain("Submit answers");
    ui.handleInput(enter);
    ui.handleInput(" "); ui.handleInput(down); ui.handleInput(" ");
    ui.handleInput(down); ui.handleInput(enter); ui.handleInput("Redis"); ui.handleInput(enter);
    ui.handleInput("\x1b[Z"); ui.handleInput("n"); ui.handleInput("Keep backups"); ui.handleInput(enter);
    expect(ui.render(100).join("\n")).not.toContain("Submit answers");
    ui.handleInput(tab);
    const review = ui.render(100).join("\n");
    expect(review).toContain("Review your answers");
    expect(review).toContain("Store: SQLite");
    expect(review).toContain("Second: SQLite; Postgres; User wrote: Redis; Note: Keep backups");
    expect(review).toContain("❯ Submit answers");
    ui.handleInput("n"); ui.handleInput(" "); ui.handleInput("\x1b[13;1:2u");
    expect(ui.render(100).join("\n")).toBe(review);
    expect(results).toHaveLength(0);
    ui.handleInput(tab); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput(tab);
    expect(ui.render(100).join("\n")).toContain("Store: Postgres");
    ui.handleInput(enter); ui.handleInput(enter);
    expect(results).toHaveLength(1);
    expect(results[0]?.answers[1]).toMatchObject({ selected: ["SQLite", "Postgres"], custom: "Redis", note: "Keep backups" });
  });
  test("review scrolls long summaries, stays bounded on resize and cancels without submitting", () => {
    const { ui, results, tui } = dialog([question, { ...question, header: "Second" }]);
    ui.handleInput(enter);
    ui.handleInput("k"); ui.handleInput(enter);
    ui.handleInput(`\x1b[200~${"世界 answer\n".repeat(30)}\x1b[201~`); ui.handleInput(enter);
    expect(ui.render(80).join("\n")).toContain("Review your answers");
    ui.handleInput("j");
    expect(ui.render(80).join("\n")).not.toContain("Review your answers");
    ui.handleMouse(wheel(1000));
    expect(ui.render(80).join("\n")).toContain("Submit answers");
    ui.handleInput("\x1d"); ui.handleInput("\x1d");
    expect(ui.render(80).join("\n")).toContain("Submit answers");
    for (const width of [1, 12, 120]) {
      tui.terminal.rows = 12;
      const lines = ui.render(width);
      expect(lines.length).toBeLessThanOrEqual(7);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    ui.handleInput(escape);
    expect(results).toEqual([{ cancelled: true, answers: [] }]);
  });
  test("single multi-select uses Space to toggle and Enter adds the focused option then submits", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }]);
    ui.handleInput(" "); ui.handleInput(" "); ui.handleInput(down); ui.handleInput(" ");
    expect(ui.render(80).join("\n")).toContain("[✔] Postgres");
    expect(results).toHaveLength(0);
    ui.handleInput("k"); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite", "Postgres"]);
  });
  test("Enter submits a nonblank custom answer for one question", () => {
    const { ui, results } = dialog();
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput(enter); ui.handleInput("Redis"); ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ selected: [], custom: "Redis" });
  });
  test("custom text can be cleared without losing multi-select choices", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }, { ...question, header: "Second" }]);
    ui.handleInput(" "); ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput("Redis"); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput("\x1b[Z"); ui.handleInput("k"); ui.handleInput(enter);
    ui.handleInput("\x15"); ui.handleInput(enter);
    expect(ui.render(80).join("\n")).toContain("[✔] SQLite");
    ui.handleInput(tab); ui.handleInput(enter); ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ selected: ["SQLite"], custom: "" });
  });
  test("custom text edits inline below its row while choices remain visible", () => {
    const { ui, results } = dialog([{ ...question, options: question.options.map((o) => ({ ...o, preview: "Preview detail" })) }]);
    ui.focused = true;
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput("first line"); ui.handleInput("\x1b[13;2u"); ui.handleInput("second line");
    expect(results).toHaveLength(0);
    for (const width of [40, 80, 120]) {
      const lines = ui.render(width);
      const text = lines.join("\n");
      expect(text).toContain("○ SQLite");
      expect(text).toContain("○ Postgres");
      expect(text).toContain("❯ ○ Type something.");
      expect(text.indexOf("first line")).toBeGreaterThan(text.indexOf("Type something."));
      expect(text).toContain("second line");
      expect(text).not.toContain("┌─ Preview");
      expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ custom: "first line\nsecond line", selected: [] });
  });
  test("Escape leaves inline editing and preserves the draft without submitting", () => {
    const { ui, results } = dialog();
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    const text = Array.from({ length: 20 }, (_, i) => `Pasted line ${i}`).join("\n");
    ui.handleInput(`\x1b[200~${text}\x1b[201~`);
    ui.handleInput("\x1b");
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("❯ ● Type something.");
    ui.handleInput(enter);
    ui.handleInput(enter);
    expect(results[0]?.answers[0]?.custom).toBe(text);
    expect(results[0]?.cancelled).toBe(false);
  });
  test("a second Escape from the choices cancels after leaving inline input", () => {
    const { ui, results } = dialog();
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput("unfinished"); ui.handleInput("\x1b");
    expect(results).toHaveLength(0);
    ui.handleInput("\x1b");
    expect(results[0]?.cancelled).toBe(true);
    expect(results[0]?.answers).toEqual([]);
  });
  test("notes retain their separate editor rather than the inline answer field", () => {
    const { ui, results } = dialog();
    ui.handleInput("n"); ui.handleInput("A note");
    const text = ui.render(80).join("\n");
    expect(text).toContain("Note (Enter saves");
    expect(text).not.toContain("Type something.");
    ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("Type something.");
    ui.dispose();
  });
  test("opening editor after paging brings the focused cursor into view", () => {
    const { ui } = dialog([{ ...question, question: "Long question\n".repeat(30) }]);
    ui.focused = true;
    ui.handleInput(down); ui.handleInput(down); ui.render(80);
    for (let i = 0; i < 10; i++) ui.handleInput("\x1b[5~");
    ui.render(80); ui.handleInput(enter);
    expect(ui.render(80).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    ui.dispose();
  });
  test("wide terminals show the framed preview beside choices; narrow terminals stack it", () => {
    initTheme("dark", false);
    const { ui } = dialog([{ ...question, options: [{ ...question.options[0]!, preview: "# Example\n\nPreview content" }, question.options[1]!] }]);
    const wide = ui.render(120);
    expect(wide.some((line) => line.includes(question.question) && line.includes("┌─ Preview"))).toBe(true);
    expect(wide.join("\n")).toContain("Example");
    expect(wide.join("\n")).not.toContain("Submit answer");
    expect(wide.every((line) => visibleWidth(line) <= 120)).toBe(true);
    const narrow = ui.render(80);
    expect(narrow.some((line) => line.includes(question.question) && line.includes("┌─ Preview"))).toBe(false);
    expect(narrow.join("\n")).toContain("Example");
    expect(narrow.every((line) => visibleWidth(line) <= 80)).toBe(true);
    ui.dispose();
  });
  test("previews render Markdown and scroll within the viewport", () => {
    initTheme("dark", false);
    const { ui } = dialog([{ ...question, options: [{ ...question.options[0]!, preview: "# Example\n\n" + "preview line\n".repeat(30) }, question.options[1]!] }]);
    expect(ui.render(80).join("\n")).toContain("Example");
    ui.handleInput("\x1b[6~");
    const lines = ui.render(20);
    expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(ui.render(80).at(-1)).toContain("PgUp/PgDn");
    for (let i = 0; i < 20; i++) { ui.handleInput("\x1b[6~"); ui.render(80); }
    const bottom = ui.render(80).join("\n");
    ui.handleInput("\x1b[6~"); expect(ui.render(80).join("\n")).toBe(bottom);
    ui.handleInput("\x1b[5~"); expect(ui.render(80).join("\n")).not.toBe(bottom);
    ui.handleInput(down); ui.render(80); ui.handleInput("k");
    expect(ui.render(80).join("\n")).toContain("Example");
    ui.handleMouse(wheel(1000)); ui.render(80); ui.handleInput(" ");
    expect(ui.render(80).join("\n")).toContain("● SQLite");
    expect(ui.render(80).join("\n")).toContain("○ Postgres");
    ui.dispose();
  });
  test("mouse wheel scrolls only inside the questionnaire and clamps at both ends", () => {
    const { ui, results } = dialog([{ ...question, question: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n") }]);
    ui.render(80);
    ui.handleMouse(wheel(-1000));
    const top = ui.render(80).join("\n");
    expect(ui.handleMouse(wheel(3))).toEqual({ handled: true });
    expect(ui.render(80).join("\n")).not.toBe(top);
    ui.handleMouse(wheel(-3)); expect(ui.render(80).join("\n")).toBe(top);
    ui.handleMouse(wheel(1000)); const bottom = ui.render(80).join("\n");
    ui.handleMouse(wheel(1000)); expect(ui.render(80).join("\n")).toBe(bottom);
    ui.handleMouse(wheel(-1)); expect(ui.render(80).join("\n")).not.toBe(bottom);
    ui.handleMouse(wheel(-1000)); expect(ui.render(80).join("\n")).toBe(top);
    for (const ignored of [{ x: -1 }, { y: 20 }, { x: 80 }, { shift: true }, { alt: true }, { ctrl: true }, { type: "click" as const }, { wheelDelta: NaN }]) {
      expect(ui.handleMouse(wheel(3, ignored))).toBeUndefined();
      expect(ui.render(80).join("\n")).toBe(top);
    }
    expect(results).toHaveLength(0);
    ui.handleInput(escape);
    expect(ui.handleMouse(wheel(3))).toBeUndefined();
  });
  test("typing after mouse scrolling brings the editor cursor back into view", () => {
    const { ui } = dialog([{ ...question, question: "Long question\n".repeat(30) }]);
    ui.focused = true;
    ui.handleInput("j"); ui.handleInput("j"); ui.handleInput(enter); ui.render(80);
    ui.handleMouse(wheel(-100)); ui.render(80);
    ui.handleInput("answer");
    expect(ui.render(80).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    ui.dispose();
  });
  test("escape discards partial answers and abort closes exactly once", () => {
    const controller = new AbortController();
    const { ui, results } = dialog([question], controller.signal);
    ui.handleInput(" "); controller.abort(); ui.handleInput(enter);
    expect(results).toEqual([{ cancelled: true, answers: [] }]);
    const other = dialog(); other.ui.handleInput(escape);
    expect(other.results).toEqual([{ cancelled: true, answers: [] }]);
  });
  test("wide text, narrow widths, resizing and small terminals stay bounded", () => {
    const { ui, tui } = dialog([{ ...question, question: "世界 👋 ".repeat(50) }]);
    for (const width of [80, 12, 1, 120]) {
      tui.terminal.rows = 12;
      const lines = ui.render(width);
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    ui.dispose();
  });
});

function native(choices: (string | undefined)[], input = "custom", confirm = true) {
  return { hasUI: true, mode: "rpc", ui: {
    select: async (_title: string, options: string[]) => { const choice = choices.shift(); return choice === undefined ? undefined : options.find((o) => o.includes(choice)); },
    input: async () => input, confirm: async () => confirm,
  } } as unknown as ExtensionContext;
}
test("RPC supports multiple selections and custom text", async () => {
  const value = await askNative([{ ...question, multiSelect: true }], native(["SQLite", "Postgres", "Type something", "Continue"]));
  expect(value.answers[0]).toMatchObject({ selected: ["SQLite", "Postgres"], custom: "custom" });
});
test("RPC can withdraw custom text while retaining selected options", async () => {
  const ctx = native(["SQLite", "Type something", "Type something", "Continue"]);
  const inputs = ["Redis", ""];
  ctx.ui.input = async () => inputs.shift();
  const value = await askNative([{ ...question, multiSelect: true }], ctx);
  expect(value.answers[0]).toMatchObject({ selected: ["SQLite"], custom: "" });
});
test("RPC cancellation and declined review discard all answers", async () => {
  expect(await askNative([question], native([undefined]))).toEqual({ cancelled: true, answers: [] });
  expect(await askNative([question], native(["SQLite"], "", false))).toEqual({ cancelled: true, answers: [] });
});
test("RPC ignores an answer returned after abort and opens no follow-up dialog", async () => {
  const controller = new AbortController();
  const ctx = native([]);
  let followUps = 0;
  ctx.ui.select = async (_title, options) => { controller.abort(); return options[0]; };
  ctx.ui.confirm = async () => { followUps++; return true; };
  const value = await askNative([question, question], ctx, controller.signal);
  expect(value).toEqual({ cancelled: true, answers: [] });
  expect(followUps).toBe(0);
});
test("RPC pre-abort never opens a dialog", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await askNative([question], {} as ExtensionContext, controller.signal)).toEqual({ cancelled: true, answers: [] });
});
test("registers sequential model-only tool and removes it without UI", async () => {
  let tool: any;
  let start: any;
  let active = ["read", "ask_user_question"];
  extension({ registerTool: (value: unknown) => { tool = value; }, on: (_event: string, handler: unknown) => { start = handler; },
    getActiveTools: () => active, setActiveTools: (value: string[]) => { active = value; },
  } as unknown as ExtensionAPI);
  expect(tool.exposure).toBe("model-only"); expect(tool.executionMode).toBe("sequential");
  await start({}, { hasUI: false }); expect(active).toEqual(["read"]);
  await expect(tool.execute("id", { questions: [question] }, undefined, undefined, { hasUI: false })).rejects.toThrow("requires");
  const response = await tool.execute("id", { questions: [question] }, undefined, undefined, native(["SQLite"]));
  expect(Value.Check(tool.outputSchema, response.structuredContent)).toBe(true);
  expect(response.details).toEqual(response.structuredContent);
  const render = (value: unknown, expanded = false, isError = false, isPartial = false) =>
    tool.renderResult(value, { expanded, isPartial }, theme, { isError }).render(120).map((line: string) => line.trimEnd()).join("\n").trim();
  const receipt = { content: [{ type: "text", text: "Full model-facing answer" }], details: {
    cancelled: false, answers: [{ header: "Store", question: "Which?", selected: ["SQLite (Recommended)", "Postgres"], custom: "custom (Recommended)" }],
  } };
  expect(render(receipt)).toBe("Which?\n  Store: SQLite; Postgres; custom (Recommended)");
  const secondAnswer = { header: "Deploy", question: "Where should it run?", selected: [], custom: "On my server" };
  expect(render({ ...receipt, details: { cancelled: false, answers: [...receipt.details.answers, secondAnswer] } }))
    .toBe("Which?\n  Store: SQLite; Postgres; custom (Recommended)\n\nWhere should it run?\n  Deploy: On my server");
  const narrow = tool.renderResult(receipt, { expanded: false, isPartial: false }, theme, { isError: false }).render(20);
  expect(narrow.join("\n")).toContain("Which?");
  expect(narrow.every((line: string) => visibleWidth(line) <= 20)).toBe(true);
  expect(render({ ...receipt, details: { ...receipt.details, answers: [{ ...receipt.details.answers[0], note: "Keep backups" }] } })).toContain("Note: Keep backups");
  expect(receipt.details.answers[0]?.selected[0]).toBe("SQLite (Recommended)");
  expect(render(receipt, true)).toBe("Full model-facing answer");
  expect(render(receipt, false, true)).toBe("Full model-facing answer");
  expect(render(receipt, false, false, true)).toBe("Full model-facing answer");
  expect(render({ content: receipt.content, details: {} })).toBe("Full model-facing answer");
  expect(render({ content: [], details: { cancelled: true, answers: [] } })).toContain("Cancelled");
  expect(tool.renderCall({}, theme).render(80).join("\n").trim()).toBe("Questions");
});
