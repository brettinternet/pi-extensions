# Prompt History

Press `Ctrl+R` or run `/prompt-history` to search prompts from saved Pi sessions. Type to filter; use Up/Down, `Ctrl+P/N`, `Ctrl+K/J`, or PageUp/PageDown to select; and press Enter to put the full prompt in the editor without sending it. Escape or `Ctrl+R` closes the picker and preserves the original editor text. Tab toggles between prompts from the current working directory (**Project**) and prompts from all saved directories (**Global**).

Pi binds `Ctrl+R` to rename in `/resume` by default. To avoid the shortcut-conflict warning, remap that action in `~/.pi/agent/keybindings.json` (for example, `"app.session.rename": "alt+r"`) and run `/reload`.

The picker reads project session JSONL files when opened and loads global history on the first Tab. It keeps a private, owner-only index under `~/.pi/agent/prompt-history/` (or the configured Pi agent directory), refreshing changed sessions and dropping deleted ones. The index duplicates prompt text; deleting it is safe because it is rebuilt from the JSONL sessions. It includes prompts from abandoned branches, but not ephemeral or deleted sessions. Project scope matches the session's exact working directory.

With an empty query, results are newest first. Search ranks exact phrases, then all query words, then close fuzzy matches; matches are highlighted in the preview. Global results show the source working directory. Multi-line prompts appear as one-line previews and are restored in full on selection.

The extension is included in this repository's Pi package but is not published separately to npm. During development, load it with `pi -e ./extensions/prompt-history/index.ts`.
