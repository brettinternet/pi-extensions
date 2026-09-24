# Pi Extensions

Extensions and a theme for the [Pi coding agent](https://pi.dev).

| Extension | What it does |
| --- | --- |
| [Colima Sandbox](extensions/colima-sandbox/README.md) | Runs Pi's file and shell tools in a disposable container |
| [Copy Prompt](extensions/copy-prompt/README.md) | `Alt+C` copies the editor text |
| [Footer](extensions/footer/README.md) | Shows context, cache, cost, and Git status |
| [Herdr Agent State](extensions/herdr-agent-state/README.md) | Keeps Herdr panes busy while async subagents run |
| [Live Codex](extensions/live-codex/README.md) | Voice mode backed by OpenAI Codex |
| [Loop](extensions/loop/README.md) | `/loop 10 <prompt>` runs a prompt in fresh sessions |
| [Progress](extensions/progress/README.md) | Shows agent activity below the editor |
| [Prompt History](extensions/prompt-history/README.md) | `Ctrl+R` searches past prompts |
| [Title](extensions/title/README.md) | Generates session titles |
| [Until](extensions/until/README.md) | Watches shell conditions and schedules follow-ups |
| [Wait](extensions/wait/README.md) | `/wait 10m <prompt>` sends a prompt later |
| [Workbench](extensions/workbench/README.md) | Opens Neovim, LazyGit, and jobs in Herdr panes |

Every command completes arguments with `Tab`, including subcommands, voices, and models. Thinking levels complete after `:`.

## Theme

Select `terminal` in `/settings` to use your terminal's ANSI palette.

## Install

Everything:

```sh
pi install git:github.com/brettinternet/pi-extensions
```

One published extension:

```sh
pi install npm:@brettinternet/pi-copy-prompt
pi install npm:@brettinternet/pi-loop
pi install npm:@brettinternet/pi-progress
pi install npm:pi-live-codex
pi install npm:pi-title
pi install npm:pi-until
pi install npm:pi-wait
```

One local extension:

```sh
pi -e ./extensions/footer/index.ts
```

## Development

```sh
bun install
bun run check
bun test
```
