# Ask User Question

A standalone question tool for Pi 0.99.1 and later. It registers `ask_user_question` without an `rpiv` dependency.

## Load

This extension is included in the root package. To load it directly from this repository:

```sh
pi -e ./extensions/ask-user-question/index.ts
```

Or install the local extension:

```sh
pi install ./extensions/ask-user-question
```

It is not published to npm. Disable `@juicesharp/rpiv-ask-user-question` first if you use it: both extensions register the same tool name.

## Ask a question

```json
{
  "questions": [
    {
      "question": "Where should session data live?",
      "header": "Storage",
      "options": [
        {
          "label": "Memory (Recommended)",
          "description": "Keep data in this process."
        },
        {
          "label": "Redis",
          "description": "Share data across processes.",
          "preview": "Requires a running Redis server."
        }
      ]
    }
  ]
}
```

The tool accepts `{questions:[{question,header,options:[{label,description,preview?}],multiSelect?}]}`. Provide 1–4 questions with 2–4 options each. Headers are at most 16 characters; labels are at most 60. Unknown properties are rejected. Put `(Recommended)` on the first choice when recommending it.

`preview` is optional Markdown for single-select questions. It appears below the options. A `Type something.` custom row is always provided, so do not add an `Other` or `Type something` option.

The questionnaire stays in the bottom editor dock, not an overlay, and uses at most half the terminal height or 12 rows. The chat above remains scrollable to the latest reply. Ctrl+] reduces the questionnaire to a one-line hint; press it again to restore selections, unfinished text, the active tab, and scroll position.

| Control | Action |
| --- | --- |
| Tab / Shift+Tab or ← / → | Change question tab |
| ↑ / ↓ or j / k | Choose an option |
| Space | Select an authored single option or toggle an authored multi-select option without advancing; ignored on the custom row |
| Enter | Select and advance on an authored single option; toggle a multi-select option; required on the custom row and Submit |
| Continue | Advance a multi-select question |
| Submit, then Enter | Submit, including for a single question |
| Escape | Discard all answers |
| Shift+Enter | Add a newline to custom text |
| Ctrl+C | Clear the entire draft with `app.clear` |
| Alt+PgUp / Alt+PgDn | Scroll the question or preview in either mode |
| PgUp / PgDn | Scroll the conversation in fullscreen; scroll the question in regular mode |
| Ctrl+] | Collapse to a one-line hint or restore the questionnaire; Escape still cancels while collapsed |

The dock height stays steady when selecting or changing tabs; only Ctrl+] collapses it.

In fullscreen, the mouse wheel scrolls the questionnaire when over it and the conversation when over a reply. In multi-select questions, saved custom text and selected options can coexist.

Successful answers contain `{question,header,selected:string[],custom:string}` entries. Cancellation returns `{cancelled:true,answers:[]}`. Compact transcript receipts can be expanded to show the full output.

In RPC mode, questions use native select, input, and confirm prompts. The tool is disabled in print and JSON modes.

See [UPSTREAM-REVIEW.md](./UPSTREAM-REVIEW.md) for deferred features.

## Development

```sh
bun test test/ask-user-question
bun run check
```