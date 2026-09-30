import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { Questionnaire } from "./dialog.js";
import { answered, newDrafts, outputSchema, parameters, result, select, summary, validate, type Question, type Result } from "./model.js";

export async function askNative(questions: Question[], ctx: ExtensionContext, signal?: AbortSignal): Promise<Result> {
  const drafts = newDrafts(questions);
  const cancel = () => result(questions, drafts, true);
  for (const [index, q] of questions.entries()) {
    const draft = drafts[index]!;
    while (true) {
      if (signal?.aborted) return cancel();
      const options = q.options.map((o, i) => `${draft.selected.has(i) ? "[✓] " : ""}${i + 1}. ${o.label} — ${o.description}${o.preview ? `\n${o.preview}` : ""}`);
      options.push("Type something.");
      if (q.multiSelect && answered(draft)) options.push("Continue");
      const choice = await ctx.ui.select(q.question, options, { signal });
      if (signal?.aborted || choice === undefined) return cancel();
      const selected = options.indexOf(choice);
      if (selected < 0) throw new Error("Host returned an unknown option.");
      if (selected < q.options.length) select(q, draft, selected);
      else if (selected === q.options.length) {
        const custom = await ctx.ui.input(`${q.header}: your answer`, draft.custom || undefined, { signal });
        if (signal?.aborted || custom === undefined) return cancel();
        draft.custom = custom.trim();
        if (!draft.custom) continue;
        if (!q.multiSelect) draft.selected.clear();
      } else break;
      if (!q.multiSelect) break;
    }
  }
  if (signal?.aborted) return cancel();
  const value = result(questions, drafts, false);
  const confirmed = await ctx.ui.confirm("Submit answers?", summary(value), { signal });
  return confirmed && !signal?.aborted ? value : cancel();
}

export default function askUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user question",
    description: "Ask 1–4 structured questions when user input is needed. Give each question a short header and 2–4 distinct options with descriptions. A Type something. row is appended automatically: never author Other or Type something options. Use multiSelect for multiple valid choices. Markdown previews are supported on single-select options. Put recommended choices first with (Recommended) in the label. Group related questions in one call. Esc cancels without submitting answers.",
    promptSnippet: "Ask the user structured questions instead of guessing consequential requirements.",
    parameters,
    outputSchema,
    exposure: "model-only",
    executionMode: "sequential",
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(theme.fg("toolTitle", `Questions${count ? ` (${count})` : ""}`), 0, 0);
    },
    renderResult(response, { expanded, isPartial }, theme, context) {
      const fullText = response.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (expanded || isPartial || context.isError || !Value.Check(outputSchema, response.details)) {
        return new Text(theme.fg(context.isError ? "error" : "toolOutput", fullText), 0, 0);
      }
      const value = response.details;
      const text = value.cancelled ? "Cancelled — no answers submitted" : value.answers.map((answer) => {
        const selected = answer.selected.map((label) => label.replace(/\s*\(Recommended\)\s*$/i, ""));
        return `${answer.header}: ${[...selected, ...(answer.custom ? [answer.custom] : [])].join("; ")}`;
      }).join("\n");
      return new Text(theme.fg(value.cancelled ? "muted" : "toolOutput", text), 0, 0);
    },
    async execute(_id, params, signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("ask_user_question requires an interactive TUI or RPC host.");
      validate(params.questions);
      const value = signal?.aborted ? result(params.questions, [], true) : ctx.mode === "tui"
        ? await ctx.ui.custom<Result>((tui, theme, keys, done) => new Questionnaire(params.questions, tui, theme, done, signal, keys))
        : await askNative(params.questions, ctx, signal);
      return { content: [{ type: "text", text: summary(value) }], details: value, structuredContent: value };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
  });
}
