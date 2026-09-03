# pi-live-codex

[![npm version](https://img.shields.io/npm/v/pi-live-codex)](https://www.npmjs.com/package/pi-live-codex)

Realtime `gpt-live-1-codex` voice mode for the [Pi coding agent](https://pi.dev). Speak naturally; repository work is delegated to the active Pi session and results are read back. This is modeled after omp's implementation to fit Pi.

![prompt with live voice enabled](https://raw.githubusercontent.com/brettinternet/pi-live-codex/main/docs/screenshot.png)

## Install

```sh
pi install npm:pi-live-codex
```

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login:

```text
/login openai-codex
```

## Use

Start Pi in its interactive TUI, then run:

```text
/live
```

Use `/live <voice>` to select a voice. `Ctrl+L` toggles voice mode, `Space` mutes, and `Esc` ends the session.

## Development

```sh
bun install
bun run check
bun test
pi -e .
```

