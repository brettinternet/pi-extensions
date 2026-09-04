# pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev).

## Extensions

### Live Codex

Realtime `gpt-live-1-codex` voice mode. Speak naturally; repository work is delegated to the active Pi session and results are read back.

![prompt with live voice enabled](docs/screenshot.png)

Start Pi in its interactive TUI, then run:

```text
/live
```

Use `/live <voice>` to select a voice. `Ctrl+L` toggles voice mode, `Space` mutes, and `Esc` ends the session. Drop image files into the terminal while live to attach them to your next spoken request.

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login (`/login openai-codex`). Only one Pi process can use live voice at a time.

### Session Title

Generates a concise session title once, after the first completed user/assistant exchange. The title is persisted as the Pi session name and used verbatim as the terminal title. Existing and manually named sessions are left unchanged.

Global configuration lives at `~/.pi/agent/pi-session-title.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "enabled": true,
  "model": null,
  "maxTokens": 30,
  "maxLength": 60
}
```

By default, an omitted or `null` model uses the active session model. Set `"model": "auto"` to use an available lightweight model, or set an explicit `provider/model[:effort]` reference.

Commands:

```text
/session-title                           Show status and config path
/session-title on                        Enable automatic titles
/session-title off                       Disable automatic titles
/session-title model openai/gpt-5-nano   Select a dedicated title model
/session-title model auto                Use the lightweight-model fallback
/session-title model active              Use the active session model
/session-title regenerate                Replace the current title
```

## Install

Install the repository or reference a local checkout in Pi's `packages` setting:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

Both extensions are loaded from the package metadata.

## Development

```sh
bun install
bun run check
bun test
pi -e .
```
