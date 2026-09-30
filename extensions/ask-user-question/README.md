# Ask User Question

A standalone extension for Pi 0.99.1+ that registers `ask_user_question`. It has no `rpiv` dependency and is included in the root package, but is not published to npm.

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

Use 1–4 questions with 2–4 options each. Set `multiSelect: true` on a question to allow multiple choices. Each option needs a label and description; optional `options[].preview` is framed Markdown for single-select questions, shown beside the choices at widths of 100 columns or more and below them at narrower widths. Headers are limited to 16 characters and labels to 60. Unknown properties are rejected. The `Type something.` row is always provided, so do not add it as an option.

The questionnaire replaces the prompt in the bottom editor dock, not an overlay. It uses at most 60% of the terminal height or 16 rows, without reserving blank space. The chat above remains scrollable to the latest reply. Focus and preview borders are cyan; the active label is bold, descriptions are muted, and the selected tab follows the Pi theme.

| Control | Action |
| --- | --- |
| Tab / Shift+Tab or ← / → | Change question tabs when there are multiple questions; keep all answers |
| Tab | With one question, switch focus between the first option and Submit answer |
| ↑ / ↓ or j / k | Move focus |
| Space / Enter on an authored option | Select in place, without advancing; single choice uses ○/●, multi-select uses checkboxes |
| Enter on `Type something.` | Open the editor; Enter saves the text to this question, without submitting |
| Enter on `Submit answer` / `Submit answers` | Submit only when every question is answered |
| Ctrl+] | Collapse to a one-line hint; press again to restore answers, draft, tab, and scroll position |
| Escape | Discard all answers, even while collapsed |
| Alt+PgUp / Alt+PgDn | Scroll the question or preview |
| PgUp / PgDn | Scroll the conversation in fullscreen; scroll the question in regular mode |

The inline Submit row appears on every question; there is no review screen. In fullscreen, the mouse wheel scrolls the questionnaire or conversation according to pointer position. In multi-select questions, saved custom text and selected options can coexist.

RPC mode uses native select, input, and final confirm prompts rather than the inline UI. The tool is disabled in print and JSON modes. See [UPSTREAM-REVIEW.md](./UPSTREAM-REVIEW.md) for deferred features.

## Development

```sh
bun test test/ask-user-question
bun run check
```