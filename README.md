# pi-live-codex

[![npm version](https://img.shields.io/npm/v/pi-live-codex)](https://www.npmjs.com/package/pi-live-codex) [![CI](https://github.com/brettinternet/pi-live-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/brettinternet/pi-live-codex/actions/workflows/ci.yml)

Realtime `gpt-live-1-codex` voice mode for the [Pi coding agent](https://pi.dev). Speak naturally; repository work is delegated to the active Pi session and results are read back. This uses omp's implementation to fit Pi.

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

Only one Pi process can use live voice at a time. A second `/live` is rejected rather than queued, preventing one session's spoken output from being captured by another.

## Development

```sh
bun install
bun run check
bun test
pi -e .
```

