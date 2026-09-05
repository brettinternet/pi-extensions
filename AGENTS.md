# Repository Guidelines

This repository contains TypeScript extensions for the Pi coding agent.

## Tools

- Use `bun` and `bunx` for dependencies, scripts, and tests.
- Prefer `rg`, `fd`, and `ast-grep` for repository navigation and structural searches.
- Run `bun run check` and the smallest relevant `bun test` target after changes.

## Preferences

- Keep changes simple, focused, and consistent with existing extension patterns.
- Reuse existing helpers and conventions before introducing new abstractions.
- Preserve unrelated work and update tests and documentation with behavior changes.
- Add argument completions to every extension command, including subcommands and common values, for ergonomic TUI use.
