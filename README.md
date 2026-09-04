# pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev).

### Live Codex

Realtime `gpt-live-1-codex` voice mode. Speak naturally; repository work is delegated to the active Pi session and results are read back.

![prompt with live voice enabled](docs/screenshot.png)

Start Pi in its interactive TUI, then run:

```text
/live
```

Use `/live <voice>` to select a voice. `Ctrl+L` toggles voice mode, `Space` mutes, and `Esc` ends the session. Drop image files into the terminal while live to attach them to your next spoken request.

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login (`/login openai-codex`). Only one Pi process can use live voice at a time.

### Title

Generates a concise session title once, after the first completed user/assistant exchange. The title is persisted as the Pi session name and used verbatim as the terminal title. Existing and manually named sessions are left unchanged.

Global configuration lives at `~/.pi/agent/pi-title.json` (or under `PI_CODING_AGENT_DIR`):

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
/title                                   Show the current title, status, and config path
/title My custom title                   Set a custom title
/title set status                        Set a custom title that matches a subcommand
/title on                                Enable automatic titles
/title off                               Disable automatic titles
/title model openai/gpt-5-nano           Select a dedicated title model
/title model auto                        Use the lightweight-model fallback
/title model active                      Use the active session model
/title regenerate                        Replace the current title automatically
```

## Colima sandbox

`bin/pi-sandbox` runs Pi's filesystem and shell tools in a disposable Colima container. Run it from a Git repository root:

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --
~/dev/me/pi-extensions/bin/pi-sandbox -- --model gpt-5 --thinking high
~/dev/me/pi-extensions/bin/pi-sandbox -- --print "inspect the tests"
```

It requires Docker's `colima` context and `~/.dotfiles/ai/pi/extensions/dcg-guard.ts`. The repository is mounted read-write at `/workspace`; host credentials and environment remain unavailable. Networking is disabled by default. Enable it with:

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --network=unrestricted --
```

Only built-in file and shell tools are available. Linked worktrees, launches below the repository root, custom tools, MCP, subagents, and project extensions are unsupported. Docker, Colima, and the Pi host remain trusted.

## Install

Install both extensions from the repository:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

Or install only Live Codex from npm:

```sh
pi install npm:pi-live-codex
```

Installed extensions are loaded from their package metadata.

## Development

```sh
bun install
bun run check
bun test
pi -e .
```
