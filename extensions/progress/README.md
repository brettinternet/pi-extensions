# pi-progress

Compact, passive activity progress for the [Pi coding agent](https://pi.dev).

The extension observes Pi's lifecycle events and renders at most two truncated lines below the editor. Settled progress remains visible until the next user-initiated run begins.

```text
progress · Verification inferred · ● edit src/index.ts · ✓ bun test
 touched src/index.ts · test/index.test.ts
```

## Observed state

- Current main-agent tools, correlated by tool-call ID
- The two most recent recognized check commands and Pi's success/error result
- Up to eight successful `edit` and `write` targets from the current run
- Thinking and settled lifecycle states

Touched paths mean only that Pi reported a successful `edit` or `write` call. They are not an exhaustive Git diff and do not prove that file bytes changed. Check marks report tool success, not semantic correctness.

Delegated work remains available through [`pi-subagents`](https://github.com/nicobailon/pi-subagents) FleetView rather than being duplicated here.

## Optional inference

Semantic phase labels are disabled unless an explicit model is configured in `~/.pi/agent/pi-progress.jsonc` (or `$PI_CODING_AGENT_DIR/pi-progress.jsonc`):

```json
{
  "model": "openai/gpt-5-nano",
  "maxInputChars": 12000,
  "maxTokens": 180,
  "timeoutMs": 15000
}
```

The configuration accepts JSON with comments and trailing commas. A legacy `pi-progress.json` file is used only when `pi-progress.jsonc` is absent. The model reference must resolve exactly and have configured authentication. `:off` and `:minimal` thinking suffixes are supported; reasoning defaults to off. There is no automatic model selection or fallback to the active session model.

Inference receives only a bounded, redacted activity digest: a truncated user request and final response excerpt, previous inference, compact tool names/arguments/outcomes/durations, edit/write paths, and recognized check commands. It does not receive system prompts, reasoning, tool output, file contents, diffs, environment variables, credentials, or the full transcript. Paths, commands, and request/response excerpts are disclosed to the configured model provider. Requests use fresh IDs with prompt-cache retention disabled.

Inference is advisory UI metadata. It does not alter model context, register an LLM-callable tool, control execution, or provide verification evidence. Invalid, low-confidence, failed, timed-out, cancelled, and stale responses are discarded.

```text
/progress status                              Show configuration and the last error
/progress model                               Show the configured inference model
/progress model openai/gpt-5-nano:minimal     Set the inference model
/progress model off                           Disable inference
```

Input, token, and timeout limits remain file-only safeguards.

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
