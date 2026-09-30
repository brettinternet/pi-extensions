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

The questionnaire replaces the prompt in the bottom editor dock, not an overlay. The dock uses at most 60% of terminal height or 16 rows; the chat above remains scrollable to the latest reply. Single-select choices use radio buttons, while multi-select choices use checkboxes.

| Control | Action |
| --- | --- |
| Tab / Shift+Tab or ← / → | Change tabs when there are multiple questions; no effect with one |
| ↑ / ↓, Ctrl+P / Ctrl+N, or k / j | Move focus |
| Space on an option | Select without submitting |
| Enter on an option | With one question, select and submit; with multiple, select in place |
| Enter on `Type something.` | Open a full-width editor beneath the row; Enter submits nonblank text for one question or saves it for multiple; Shift+Enter adds a newline |
| `n` | Open this question’s optional note editor; Enter saves the note and returns |
| Escape | In the custom-answer editor, keep the draft and return to choices without submitting; in the note editor, discard edits and return; otherwise cancel all answers, even while collapsed |
| Ctrl+C | Clear the focused editor via `app.clear` |
| Ctrl+] | Collapse to a one-line hint; press again to restore answers, draft, tab, and scroll position |
| Alt+PgUp / Alt+PgDn | Scroll the question or preview |
| PgUp / PgDn | Scroll the conversation in fullscreen; scroll the question in regular mode |

Choice labels remain visible while typing; descriptions are hidden to make room.

For a single multi-select question, Space toggles choices; Enter includes the focused option without removing checked choices, then submits. With multiple questions, use the explicit **Submit answers** row after answering them all. Inside an editor, `n` types the letter rather than opening a note.

Previews are optional framed Markdown for single-select questions. They appear beside choices at widths of at least 100 columns, or below them at narrower widths. A question reserves space for its largest visible preview even when the focused option has none, leaving that space blank without a placeholder or duplicate note hint. Questions without previews reserve no preview space. In fullscreen, the mouse wheel scrolls the questionnaire or conversation according to pointer position.

Notes are not answers; an optional `note` string appears in results and compact transcript receipts. RPC mode uses native select, input, and final confirm dialogs, without a note editor. The tool is disabled in print and JSON modes. See [UPSTREAM-REVIEW.md](./UPSTREAM-REVIEW.md) for deferred features.

## Development

```sh
bun test test/ask-user-question
bun run check
```