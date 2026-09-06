# pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev).

Slash-command descriptions show each command's argument shape. Press `Tab` to complete subcommands, common values, voices, and model references. Thinking levels complete after `:`.

## Extensions

| Extension | What it does | Details |
|---|---|---|
| **Approval Status** | Reports custom confirmation waits as blocked to Herdr. | — |
| **Live Codex** | Realtime `gpt-live-1-codex` voice mode for Pi. | [`docs`](extensions/live-codex/global-voice-broker.md) |
| **Loop** | Runs a prompt a bounded number of times in fresh Pi sessions. | [`README`](extensions/loop/README.md) |
| **Herdr Workbench** | Provides visible Neovim, LazyGit, and foreground-job panes. | [`README`](extensions/workbench/README.md) |
| **Progress** | Shows compact, passive main-agent activity below the editor. | [`README`](extensions/progress/README.md) |
| **Title** | Generates and persists a concise session title. | Configuration below |

### Live Codex

Start Pi in its interactive TUI:

```text
/live
/live <voice>
```

![prompt with live voice enabled](docs/screenshot.png)

Known realtime voices support completion; custom voice names are also accepted. `Ctrl+L` toggles voice mode and `Esc` ends it.

While live, printable non-whitespace input opens the editor. Bare `Space` mutes only while the editor is empty. Press `Enter` with nonblank text to stage a verbatim note, limited to 4,000 characters, for the next spoken request. Dropped images and staged notes are sent with that request.

Only one Pi session owns live voice at a time. Starting `/live` elsewhere offers an authenticated handoff. Existing Pi work continues, but the previous voice surface stops. Queued voice requests and pending voice-routed confirmations must be resolved in the old session first.

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login:

```text
/login openai-codex
```

### Loop

Each iteration gets a fresh Pi session. Filesystem changes carry forward; conversational messages do not.

```text
/loop <count> <prompt>   Start
/loop <count>            Retune future iterations
/loop prompt <text>       Replace the future prompt
/loop append <text>       Append to the future prompt
/loop status             Inspect
/loop                    Request graceful stop
/loop stop               Request graceful stop
/loop resume             Retry a paused iteration
```

Aborted or failed output pauses the run. State and session ownership are persisted in custom entries, with a compact active/paused widget.

### Herdr Workbench

Registers a typed `workbench` tool for visible Neovim, LazyGit, and foreground-job panes managed by the `brettinternet.workbench` Herdr plugin.

Jobs run asynchronously, remain cancellable, and emit session- and workspace-scoped background activity events. The tool only mutates trusted projects and limits follow-up operations to resources owned by the current Pi session.

### Progress

Shows up to two truncated lines of passive activity below the editor. It observes active tools, recent check outcomes, and successful edit/write targets. When explicitly configured, bounded advisory inference adds a debounced current activity during longer runs and a settled current/completed/blocker summary; it does not register an LLM tool, change prompts, or provide semantic verification.

`pi-subagents` FleetView remains the source for delegated work.

### Title

Generates one session title in the background after the first assistant message containing text is finalized. The title does not wait for later tool results or the full run. It appears when generation finishes, is persisted as the Pi session name, and is used verbatim as the terminal title.

Existing and manually named sessions are unchanged.

Configuration: `~/.pi/agent/pi-title.jsonc` or the directory set by `PI_CODING_AGENT_DIR`.

```jsonc
{
  "enabled": true,
  "model": null,
  "maxTokens": 30,
  "maxLength": 60
}
```

Comments and trailing commas are supported. The legacy `pi-title.json` is read only when `.jsonc` does not exist; `.jsonc` takes precedence. `/title` configuration changes preserve comments.

Model behavior:

- Omitted or `null`: use the active session model.
- `"auto"`: use an available lightweight model.
- Explicit `provider/model[:effort]`: use that model.

```text
/title                                   Show title, status, and config path
/title My custom title                   Set a custom title
/title set status                        Set a subcommand-shaped custom title
/title on                                Enable automatic titles
/title off                               Disable automatic titles
/title model openai/gpt-5-nano           Select a dedicated title model
/title model auto                        Use the lightweight-model fallback
/title model active                      Use the active session model
/title regenerate                        Replace the title automatically
```

## Colima sandbox

`bin/pi-sandbox` runs Pi's filesystem and shell tools in a disposable Colima container. Run it from a Git repository root:

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --
~/dev/me/pi-extensions/bin/pi-sandbox -- --model gpt-5 --thinking high
~/dev/me/pi-extensions/bin/pi-sandbox -- --print "inspect the tests"
```

Requirements:

- Docker's `colima` context
- `~/.dotfiles/ai/pi/extensions/dcg-guard.ts`

The repository is mounted read-write at `/workspace`. Host credentials and environment remain unavailable. Networking is disabled by default:

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --network=unrestricted --
```

Only built-in file and shell tools are available. Linked worktrees, launches below the repository root, custom tools, MCP, subagents, and project extensions are unsupported. Docker, Colima, and the Pi host remain trusted.

## Install

Install all extensions:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

Or install individual extensions from npm:

```sh
pi install npm:pi-live-codex
pi install npm:@brettinternet/pi-progress
pi install npm:@brettinternet/pi-loop
pi install npm:pi-title
pi install npm:pi-herdr-workbench
```

Installed extensions are loaded from their package metadata.

## Development

```sh
bun install
bun run check
bun test
pi -e .
```
