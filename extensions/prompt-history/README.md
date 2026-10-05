# Prompt History

Press `Ctrl+R` (or run `/prompt-history`) to search prompts from saved Pi sessions. Enter inserts the full prompt at the editor cursor, preserving existing text without sending it. The insertion appears in the same redraw that closes the picker.

| Key | Action |
| --- | --- |
| Type | Filter |
| `Up`/`Down`, `Ctrl+P`/`Ctrl+N`, `Ctrl+K`/`Ctrl+J`, `PageUp`/`PageDown` | Select |
| `Enter` | Insert prompt |
| `Tab` | Toggle **Project** (this directory) and **Global** (all directories) |
| `Ctrl+C` | Clear the search input without closing history |
| `Esc` or `Ctrl+R` | Close and keep the original editor text |

An empty query lists newest first. Search ranks exact phrases, then all words, then fuzzy matches, and highlights matches. Global results show each prompt's directory.

Pi binds `Ctrl+R` to rename in `/resume`. To avoid the conflict warning, remap it and run `/reload`:

```jsonc
// ~/.pi/agent/keybindings.json
{ "app.session.rename": "alt+r" }
```

## Index

Prompts come from session JSONL files, including abandoned branches but not ephemeral or deleted sessions. Project scope matches the session's exact working directory.

Expanded skill messages are reconstructed as `/skill:name` plus their arguments, including in older sessions. Search and selection use the command rather than the skill instructions. Original whitespace removed by Pi's expansion cannot be recovered; prompt-template expansions remain as saved.

A private, owner-only index in `~/.pi/agent/prompt-history/` caches prompt text. It refreshes changed sessions and drops deleted ones. Deleting it is safe; it rebuilds from the sessions.

## Install

Not published to npm. Install the repository package or load it directly:

```sh
pi -e ./extensions/prompt-history/index.ts
```
