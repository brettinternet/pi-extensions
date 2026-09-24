# Pi Extensions

TypeScript extensions and themes for the [Pi coding agent](https://pi.dev).

Slash-command descriptions show argument shapes. Press `Tab` to complete subcommands, common values, voices, and model references. Thinking levels complete after `:`.

## Extensions

| Extension | What it does | Docs |
| --- | --- | --- |
| **Colima Sandbox** | Runs Pi filesystem and shell tools in a disposable Colima container. | [README](extensions/colima-sandbox/README.md) |
| **Copy Prompt** | Copies prompt editor text to the system clipboard with `Alt+C`. | [README](extensions/copy-prompt/README.md) |
| **Footer** | Renders context usage, cache metrics, and session Git status. | [README](extensions/footer/README.md) |
| **Herdr Agent State** | Syncs Pi lifecycle state to Herdr so panes stay active during async subagent work. | [README](extensions/herdr-agent-state/README.md) |
| **Live Codex** | Realtime voice interface backed by OpenAI Codex. | [README](extensions/live-codex/README.md) |
| **Loop** | Runs a prompt repeatedly across fresh Pi sessions. | [README](extensions/loop/README.md) |
| **Progress** | Displays compact agent activity below the editor. | [README](extensions/progress/README.md) |
| **Prompt History** | Searches saved prompts by project or globally with `Ctrl+R`. | [README](extensions/prompt-history/README.md) |
| **Title** | Generates and persists concise session titles. | [README](extensions/title/README.md) |
| **Until** | Watches background shell conditions and runs recurring follow-ups in one session. | [README](extensions/until/README.md) |
| **Wait** | Delays or queues follow-up prompts until current work settles. | [README](extensions/wait/README.md) |
| **Workbench** | Coordinates Neovim, LazyGit, and foreground jobs in Herdr. | [README](extensions/workbench/README.md) |

## Theme

Select `terminal` in `/settings` to use the terminal ANSI palette.

## Install

Install everything from this repository:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

Or install a published extension:

```sh
pi install npm:@brettinternet/pi-copy-prompt
pi install npm:pi-live-codex
pi install npm:@brettinternet/pi-progress
pi install npm:@brettinternet/pi-loop
pi install npm:pi-wait
pi install npm:pi-until
pi install npm:pi-title
```

Load a local extension directly:

```sh
pi -e ./extensions/footer/index.ts
```

## Development

```sh
bun install
bun run check
bun test
```
