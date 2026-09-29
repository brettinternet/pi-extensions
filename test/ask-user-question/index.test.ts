import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import extension, { askNative } from "../../extensions/ask-user-question/index.js";
import { Questionnaire } from "../../extensions/ask-user-question/dialog.js";
import { parameters, validate, type Question, type Result } from "../../extensions/ask-user-question/model.js";

const question: Question = { header: "Store", question: "Which store?", options: [
  { label: "SQLite", description: "Embedded storage" }, { label: "Postgres", description: "Remote storage" },
] };
const theme = { fg: (_: string, s: string) => s } as Theme;
function dialog(questions = [question], signal?: AbortSignal) {
  const results: Result[] = [];
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const ui = new Questionnaire(questions, tui as unknown as TUI, theme, (value) => results.push(value), signal);
  return { ui, results, tui };
}
const enter = "\r", down = "\x1b[B", tab = "\t", escape = "\x1b";

describe("schema", () => {
  test("limits question count, option count and labels", () => {
    expect(Value.Check(parameters, { questions: [question] })).toBe(true);
    for (const questions of [[], Array(5).fill(question), [{ ...question, header: "x".repeat(17) }], [{ ...question, options: [question.options[0]] }]]) {
      expect(Value.Check(parameters, { questions })).toBe(false);
    }
  });
  test("rejects reserved, duplicate, blank and multi-preview options", () => {
    for (const label of ["Other", " TYPE SOMETHING. ", "", "Postgres"]) {
      expect(() => validate([{ ...question, options: [{ ...question.options[0]!, label }, question.options[1]!] }])).toThrow();
    }
    expect(() => validate([{ ...question, multiSelect: true, options: question.options.map((o) => ({ ...o, preview: "hi" })) }])).toThrow();
  });
});

describe("terminal questionnaire", () => {
  test("requires explicit review and submission", () => {
    const { ui, results } = dialog();
    ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("Enter to submit");
    ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["SQLite"]);
    ui.handleInput(escape);
    expect(results).toHaveLength(1);
  });
  test("cannot submit incomplete questions", () => {
    const { ui, results } = dialog([question, { ...question, header: "Second" }]);
    ui.handleInput(enter); ui.handleInput(tab); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    expect(ui.render(80).join("\n")).toContain("Unanswered: Second");
    ui.dispose();
  });
  test("multi-select toggles, preserves choices across tabs, and continues", () => {
    const { ui, results } = dialog([{ ...question, multiSelect: true }]);
    ui.handleInput(enter); ui.handleInput(enter); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput(tab); ui.handleInput(tab);
    expect(ui.render(80).join("\n")).toContain("[✓] Postgres");
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter); ui.handleInput(enter);
    expect(results[0]?.answers[0]?.selected).toEqual(["Postgres"]);
  });
  test("custom answer supports typing and does not submit until reviewed", () => {
    const { ui, results } = dialog();
    ui.handleInput(down); ui.handleInput(down); ui.handleInput(enter);
    ui.handleInput("Redis"); ui.handleInput(enter);
    expect(results).toHaveLength(0);
    ui.handleInput(enter);
    expect(results[0]?.answers[0]).toMatchObject({ selected: [], custom: "Redis" });
  });
  test("escape discards partial answers and abort closes exactly once", () => {
    const controller = new AbortController();
    const { ui, results } = dialog([question], controller.signal);
    ui.handleInput(enter); controller.abort(); ui.handleInput(enter);
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
test("RPC cancellation and declined review discard all answers", async () => {
  expect(await askNative([question], native([undefined]))).toEqual({ cancelled: true, answers: [] });
  expect(await askNative([question], native(["SQLite"], "", false))).toEqual({ cancelled: true, answers: [] });
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
});
