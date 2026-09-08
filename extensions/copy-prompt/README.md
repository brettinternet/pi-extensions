# pi-copy-prompt

Copy the complete current prompt editor text to the system clipboard with `Alt+C`.

The shortcut preserves the editor text exactly. Empty prompts are reported without changing the clipboard, and clipboard failures are shown as errors.

## Install

```sh
pi install npm:@brettinternet/pi-copy-prompt
```

Or load it directly during development:

```sh
pi -e ./extensions/copy-prompt/index.ts
```
