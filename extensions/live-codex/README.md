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

Use `/live <voice>` to select a voice. `Ctrl+L` toggles voice mode, `Space` mutes, and `Esc` ends the session. Drop image files into the terminal while live to attach them to your next spoken request.

Only one Pi process can use live voice at a time.
