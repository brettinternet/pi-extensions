# ask-user-question

A standalone structured-question tool for Pi 0.99.1+. No rpiv dependency.

## Load

From this repository:

```sh
pi -e ./extensions/ask-user-question/index.ts
```

Or install the local package:

```sh
pi install ./extensions/ask-user-question
```

Also included in this repository's root Pi package. Disable or remove `@juicesharp/rpiv-ask-user-question` before loading this extension: both register `ask_user_question`. Restart Pi after changing installed extensions. This package has not been published to npm.

## Tool

`ask_user_question` accepts 1–4 questions. Each has:

- `question`: full question text.
- `header`: short tab label, at most 16 characters.
- `options`: 2–4 choices, each with a `label` (at most 60 characters) and `description`.
- `multiSelect`: optional boolean, default false.
- `options[].preview`: optional Markdown, only for single-select questions.

Unknown fields are rejected, including `preview` placed on a question instead of an option.

A **Type something.** row is always included. Authored `Other` and `Type something` labels, blank text, and duplicate option labels are rejected. Recommended choices should come first and include `(Recommended)` in their label.

```json
{
  "questions": [{
    "question": "Where should we store the cache?",
    "header": "Cache",
    "options": [
      { "label": "Memory (Recommended)", "description": "Simple, process-local caching." },
      { "label": "Redis", "description": "Shared cache across instances." }
    ]
  }]
}
```

## Terminal controls

| Key | Action |
| --- | --- |
| Tab / Shift+Tab or ← / → | Move between questions and Submit |
| ↑ / ↓ or k / j | Focus a choice |
| Enter / Space | Select or toggle the focused choice |
| Enter on Continue | Advance after a multi-select answer |
| Enter while typing | Save the custom answer and advance |
| Shift+Enter while typing | Add a newline |
| Ctrl+C while typing | Clear the whole draft (follows Pi's `app.clear` binding) |
| Page Up / Page Down | Scroll long questions or previews |
| Enter on Submit | Submit only when every question is answered |
| Escape | Cancel the whole questionnaire; discard all answers |

Selections are preserved while navigating tabs. Single-select custom answers replace the selected option; multi-select custom answers can accompany selected options. Reopen the custom row, clear its text, and press Enter to withdraw a custom answer without losing selected options. A single question still requires confirmation on the Submit tab. Previews render below the focused option list and can be scrolled. Rendering adapts to terminal width and height.

## Results and hosts

The transcript shows compact answer receipts; expand the tool to see the full response. Selected labels omit `(Recommended)` in the compact view only. Error messages remain fully visible.

The model receives a readable answer summary. `details` and `structuredContent` contain:

```json
{
  "cancelled": false,
  "answers": [{
    "question": "Where should we store the cache?",
    "header": "Cache",
    "selected": ["Memory (Recommended)"],
    "custom": ""
  }]
}
```

Cancelled interactions return `cancelled: true` and an empty `answers` array, never partial answers. Abort signals close an active questionnaire. The tool is model-only and sequential to avoid competing dialogs.

RPC hosts use native select, input, and confirmation dialogs. Multi-select repeats the picker until Continue; previews appear as plain option text. Print/JSON sessions deactivate the tool, and direct execution without UI fails explicitly.

This is a focused replacement, not an rpiv fork. It intentionally omits rpiv localization, notes, collapse shortcuts, configuration, events, external-editor integration, and side-by-side preview layout.

See [upstream PR review](UPSTREAM-REVIEW.md) for adopted ideas and deferred features.

## Development

From the repository root:

```sh
bun test test/ask-user-question
bun run check
```
