# Prompt History

Press `Ctrl+R` or run `/prompt-history` to search prompts from saved Pi sessions. Type to filter, use Up/Down (or PageUp/PageDown) to select, and press Enter to put the full prompt in the editor without sending it. Escape preserves the original editor text. Tab toggles between prompts from the current working directory (**Project**) and prompts from all saved directories (**Global**).

The picker reads session JSONL files when opened; it does not copy prompts into another database. It includes prompts from abandoned branches, but not ephemeral or deleted sessions. Project scope matches the session's exact working directory. Multi-line prompts appear as one-line previews and are restored in full on selection.

The extension is included in this repository's Pi package but is not published separately to npm. During development, load it with `pi -e ./extensions/prompt-history/index.ts`.
