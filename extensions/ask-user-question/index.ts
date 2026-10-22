import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { Questionnaire } from "./dialog.js";
import { answered, chat, newSnapshot, outputSchema, parameters, result, select, summary, validate, type Question, type Result, type Snapshot } from "./model.js";
import { readState, RECOVERY_MESSAGE, STATE_ENTRY, type QuestionState } from "./state.js";

const CHAT_LABEL = "Chat about this";

export async function askNative(questions: Question[], ctx: ExtensionContext, signal?: AbortSignal,
  initial = newSnapshot(questions), onChange?: (snapshot: Snapshot) => void): Promise<Result> {
  const drafts = initial.drafts.map((draft) => ({ ...draft, selected: new Set(draft.selected) }));
  // Native hosts do not expose keystrokes; only accepted input can be saved.
  if (initial.editing && initial.tab < questions.length) drafts[initial.tab]![initial.editing] = initial.text;
  const checkpoint = (tab: number) => onChange?.({ drafts: drafts.map((draft) => ({ ...draft, selected: [...draft.selected] })), tab, cursor: 0, text: "" });
  const cancel = () => result(questions, drafts, true);
  for (const [index, q] of questions.entries()) {
    if (index < initial.tab && answered(drafts[index]!)) continue;
    const draft = drafts[index]!;
    while (true) {
      if (signal?.aborted) return cancel();
      const options = q.options.map((o, i) => `${draft.selected.has(i) ? "[✓] " : ""}${i + 1}. ${o.label} — ${o.description}${o.preview ? `\n${o.preview}` : ""}`);
      options.push("Type something.");
      if (q.multiSelect && answered(draft)) options.push("Continue");
      options.push(CHAT_LABEL);
      const choice = await ctx.ui.select(q.question, options, { signal });
      if (signal?.aborted || choice === undefined) return cancel();
      if (choice === CHAT_LABEL) return chat();
      const selected = options.indexOf(choice);
      if (selected < 0) throw new Error("Host returned an unknown option.");
      if (selected < q.options.length) select(q, draft, selected);
      else if (selected === q.options.length) {
        const custom = await ctx.ui.input(`${q.header}: your answer`, draft.custom || undefined, { signal });
        if (signal?.aborted || custom === undefined) return cancel();
        draft.custom = custom.trim();
        if (!draft.custom) { checkpoint(index); continue; }
        if (!q.multiSelect) draft.selected.clear();
      } else break;
      checkpoint(index);
      if (!q.multiSelect) break;
    }
    checkpoint(questions.length > 1 ? index + 1 : 0);
  }
  if (signal?.aborted) return cancel();
  const value = result(questions, drafts, false);
  const confirmed = await ctx.ui.confirm("Submit answers?", summary(value), { signal });
  return confirmed && !signal?.aborted ? value : cancel();
}

export default function askUserQuestion(pi: ExtensionAPI): void {
  let active: AbortController | undefined;
  let recovering = false;
  const delivering = new Set<string>();
  const persist = (state: QuestionState) => pi.appendEntry(STATE_ENTRY, structuredClone(state));

  async function show(state: QuestionState, ctx: ExtensionContext, signal?: AbortSignal): Promise<Result | undefined> {
    if (active) throw new Error("A questionnaire is already open.");
    const controller = new AbortController();
    active = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let previous = JSON.stringify(state.snapshot);
    const checkpoint = (snapshot: Snapshot) => {
      if (combined.aborted) return;
      const encoded = JSON.stringify(snapshot);
      if (encoded === previous) return;
      state.snapshot = snapshot;
      persist(state);
      previous = encoded;
    };
    const complete = (value: Result) => {
      if (!combined.aborted) { state.result = value; persist(state); }
      return value;
    };
    const blocked = ctx.mode === "tui" && !combined.aborted;
    if (blocked) pi.events.emit("herdr:blocked", { active: true, scope: "root", label: "Waiting for user" });
    try {
      if (combined.aborted) return;
      const value = ctx.mode === "tui"
        ? await ctx.ui.custom<Result>((tui, theme, keys, done) => new Questionnaire(state.questions, tui, theme,
          (value) => done(complete(value)), combined, keys, state.snapshot, checkpoint))
        : complete(await askNative(state.questions, ctx, combined, state.snapshot, checkpoint));
      return combined.aborted ? undefined : value;
    } finally {
      if (active === controller) active = undefined;
      if (blocked) pi.events.emit("herdr:blocked", { active: false, scope: "root" });
    }
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || recovering) return;
    const state = readState(ctx.sessionManager.getBranch());
    if (!state || delivering.has(state.toolCallId)) return;
    recovering = true;
    try {
      const value = state.result ?? await show(state, ctx);
      if (!value) return;
      // sendMessage is fire-and-forget. Suppress repeated session_start events
      // while delivery is queued, but retain durable state until its receipt.
      delivering.add(state.toolCallId);
      pi.sendMessage({ customType: RECOVERY_MESSAGE, display: true,
        content: `Recovered ask_user_question (${state.toolCallId}) after interruption.\n${state.questions.map((q) => `${q.header}: ${q.question}`).join("\n")}\n\n${summary(value)}`,
        details: { toolCallId: state.toolCallId, result: value },
      }, { triggerTurn: !value.chat, deliverAs: "followUp" });
    } finally { recovering = false; }
  }

  function startRecovery(ctx: ExtensionContext): Promise<void> | void {
    if (ctx.mode !== "rpc") return restore(ctx);
    // RPC attaches its stdin reader only after session_start finishes.
    void restore(ctx).catch((error) => ctx.ui.notify(`Question recovery failed: ${String(error)}`, "error"));
  }

  pi.on("session_shutdown", () => { active?.abort(); });
  pi.on("session_before_tree", () => active ? { cancel: true } : undefined);
  pi.on("session_tree", (_event, ctx) => { delivering.clear(); return startRecovery(ctx); });
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
      const text = value.chat ? "Chose to chat about this" : value.cancelled ? "Cancelled — no answers submitted" : value.answers.map((answer) => {
        const selected = answer.selected.map((label) => label.replace(/\s*\(Recommended\)\s*$/i, ""));
        return `${answer.question}\n  ${answer.header}: ${[...selected, ...(answer.custom ? [answer.custom] : []), ...(answer.note ? [`Note: ${answer.note}`] : [])].join("; ")}`;
      }).join("\n\n");
      return new Text(theme.fg(value.cancelled ? "muted" : "toolOutput", text), 0, 0);
    },
    async execute(id, params, signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("ask_user_question requires an interactive TUI or RPC host.");
      validate(params.questions);
      if (signal?.aborted) throw new Error("Questionnaire interrupted before opening.");
      if (active) throw new Error("A questionnaire is already open.");
      const state: QuestionState = { version: 1, toolCallId: id, questions: params.questions, snapshot: newSnapshot(params.questions) };
      persist(state);
      const value = await show(state, ctx, signal);
      if (!value) throw new Error("Questionnaire interrupted. Draft saved; resume this session to answer it.");
      // Chat hands the prompt back to the user instead of letting the model continue.
      return { content: [{ type: "text", text: summary(value) }], details: value, structuredContent: value, ...(value.chat ? { terminate: true } : {}) };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
    else await startRecovery(ctx);
  });
}
