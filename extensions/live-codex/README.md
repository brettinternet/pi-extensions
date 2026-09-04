# pi-live-codex

Realtime `gpt-live-1-codex` voice mode for the [Pi coding agent](https://pi.dev). Speak naturally; repository work is delegated to the active Pi session and results are read back.

## Install

```sh
pi install npm:pi-live-codex
```

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login (`/login openai-codex`).

## Use

Start Pi in its interactive TUI, then run:

```text
/live
```

Use `/live <voice>` to select a voice. `Ctrl+L` toggles voice mode, `Space` mutes, and `Esc` ends the voice session. Drop image files into the terminal while live to attach them to your next spoken request.

You can make additional requests while work is running. Independent requests are dispatched to Pi in order, while detached subagent jobs continue concurrently. Their completion is correlated with the request that launched them and announced through the live session. A clear request to stop the current foreground operation aborts that Pi turn; named background cancellation is handled by Pi against the owned job.

Only one Pi process can use live voice at a time.
