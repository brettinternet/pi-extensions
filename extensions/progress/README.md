# pi-progress

Compact, passive activity progress for the [Pi coding agent](https://pi.dev).

The extension observes Pi's existing lifecycle events and renders at most two truncated lines below the editor. It does not register an LLM tool, alter prompts, call a model, or claim semantic task completion.

```text
progress · ● edit src/index.ts · ✓ bun test
 touched src/index.ts · test/index.test.ts
```

## Observed state

- Current main-agent tools, correlated by tool-call ID
- The two most recent recognized check commands and Pi's success/error result
- Up to eight successful `edit` and `write` targets from the current run
- Thinking and settled lifecycle states

Touched paths mean only that Pi reported a successful `edit` or `write` call. They are not an exhaustive Git diff and do not prove that file bytes changed. Check marks report tool success, not semantic correctness.

Delegated work is intentionally left to [`pi-subagents`](https://github.com/nicobailon/pi-subagents) FleetView rather than duplicated here.

## Install

Install the full personal extension package:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

Or load this extension directly during development:

```sh
pi -e ./extensions/progress/index.ts
```

## Development

```sh
bun run check
bun test test/progress
```
