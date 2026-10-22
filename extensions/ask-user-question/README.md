# Ask User Question

A standalone extension for Pi 0.99.1+ that registers `ask_user_question`. It is included in the root package but is not published to npm.

```sh
pi -e ./extensions/ask-user-question/index.ts
# or
pi install ./extensions/ask-user-question
```

Disable `@juicesharp/rpiv-ask-user-question` before `/reload`: it registers the same tool name.

## Ask a question

```json
{
  "questions": [{
    "question": "Where should session data live?",
    "header": "Storage",
    "options": [
      {"label": "Memory (Recommended)", "description": "Keep data in this process."},
      {"label": "Redis", "description": "Share data across processes.", "preview": "Requires a running Redis server."}
    ]
  }]
}
```

Use 1–4 questions with 2–4 options each. Set `multiSelect: true` for multiple choices. Headers are limited to 16 characters and option labels to 60; unknown properties are rejected. `Type something.` is always provided, so do not add it as an option.

The questionnaire replaces the prompt in the bottom editor dock, not an overlay. The dock uses at most 60% of terminal height or 16 rows; the chat above remains scrollable to the latest reply. Choices are numbered; a chosen single-select answer turns green with `✓`, while multi-select choices use `[✓]` checkboxes and end with a **Submit** row. **Chat about this** sits below a rule after the choices.

| Control | Action |
| --- | --- |
| Tab / Shift+Tab or ← / → | Change question tabs and the final Review tab when there are multiple questions; no effect with one |
| Ctrl+H / Ctrl+B; Ctrl+L / Ctrl+F | Previous; next question or Review tab, outside editors only; no effect with one question |
| ↑ / ↓, Ctrl+P / Ctrl+N, or k / j | Move focus |
| 1–9 | Act on that numbered row as if focused and Enter was pressed |
| Space on an option | Select or toggle without submitting |
| Enter on a single-select option | With one question, select and submit; with multiple, select and advance to the next question or Review |
| Enter on a multi-select option | Toggle it |
| Enter on **Submit** | Once the question is answered, submit (one question) or advance |
| `c` or Enter on **Chat about this** | Close without answers and hand the prompt back to you; the agent stops and waits for your message |
| Enter on `Type something.` | Open a full-width editor beneath the row; Shift+Enter adds a newline. For single-select, Enter submits nonblank text (one question) or saves it and advances; for multi-select, Enter saves it as another checked answer |
| `n` | Open this question’s optional note editor; Enter saves the note and returns |
| Escape | In the custom-answer editor, keep the draft and return to choices without submitting; in the note editor, discard edits and return; otherwise cancel all answers, even while collapsed |
| Ctrl+C | Clear the focused editor via `app.clear` |
| Ctrl+] | Collapse to a one-line hint; press again to restore answers, draft, tab, and scroll position |
| Alt+PgUp / Alt+PgDn | Scroll the question or preview |
| PgUp / PgDn | Scroll the conversation in fullscreen; scroll the question in regular mode |

Choice labels remain visible while typing; descriptions are hidden to make room.

Multi-select questions are confirmed only from their **Submit** row, so Enter never adds or removes a choice by accident. Confirming nonblank single-select custom text advances; saving a note or blank custom text stays on the question. Confirmation on the last question advances to **Review**, never auto-submits: it lists each question with its answer, custom text, and note, or marks it unanswered. Review ends with **1. Submit answers** (available once every question is answered) and **2. Cancel**. Use Tab / Shift+Tab, ← / →, or Ctrl+H/B (previous) and Ctrl+L/F (next) to revisit and edit answers. Navigation shortcuts retain their normal text-editing behavior inside editors. Some legacy terminals encode Backspace as Ctrl+H, so that key also navigates backward outside editors. On Review, ↑ / ↓ and j / k move between Submit and Cancel; long summaries scroll with Alt+PgUp / Alt+PgDn or the mouse wheel. Inside an editor, `n`, `c`, and digits type normally.

Previews are optional framed Markdown for single-select questions. They appear beside choices at widths of at least 100 columns, or below them at narrower widths. A question reserves space for its largest visible preview even when the focused option has none, leaving that space blank without a placeholder or duplicate note hint. Questions without previews reserve no preview space. In fullscreen, the mouse wheel scrolls the questionnaire or conversation according to pointer position.

After submission, the compact transcript receipt shows each full question above its header and answer, with a blank line between questions. Selected choices, custom answers, and notes remain visible without expanding the tool result.

Notes are not answers; an optional `note` string appears in results and compact transcript receipts.

**Chat about this** returns `{ "cancelled": true, "chat": true, "answers": [] }`, tells the model to wait for your next message, and sets the tool result's `terminate` flag so the agent stops instead of guessing. Use it when the options are wrong or you need to talk the decision through in the normal prompt.

RPC mode uses native select, input, and final confirm dialogs, without a note editor; each question's select list ends with **Chat about this**. The tool is disabled in print and JSON modes. See [UPSTREAM-REVIEW.md](./UPSTREAM-REVIEW.md) for deferred features.

## Restart recovery

Pending questionnaires are saved in the session and reopen when you resume it, reload extensions, or return to that branch. TUI recovery preserves choices, saved notes, the current question and unfinished custom-answer or note text. Layout details such as collapse and scroll position reset. RPC recovery preserves accepted choices and input; native hosts do not expose unfinished typing.

Escape cancellation and submitted answers are recorded so completed questionnaires do not reopen. Process shutdown or tool abort preserves the draft instead of cancelling it. Recovery requires a saved session and an interactive TUI or RPC host; noninteractive sessions leave pending questions untouched.

The original tool execution cannot survive a process restart. After recovery, the extension sends a visible message containing the questions and answers (or cancellation), then requests an agent continuation, except after **Chat about this**, which waits for your message. Saved submission records and transcript receipts prevent replay after delivery, including a restart between submission and the original tool result being recorded.

Drafts, including unfinished text, are stored as session entries on each changed input event. They are excluded from model context until submission, but remain in the session file even after cancellation; do not enter secrets you do not want saved there.

## Development

```sh
bun test test/ask-user-question
bun run check
```