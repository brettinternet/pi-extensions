# Workbench

Gives the agent a `workbench` tool that opens Neovim files, shows LazyGit, and runs visible foreground jobs in Herdr panes.

```text
open src/index.ts in a split       → editor.open
show lazygit                       → lazygit.open
run bun test in a pane             → job.start ["bun", "test"]
```

Private and local. Load it from this repository:

```sh
pi -e ./extensions/workbench/index.ts
```

Requires Herdr and its plugin. Changes require a trusted project. Jobs belong to the Pi session that started them.

## Confirmation

| Action | Confirmation |
| --- | --- |
| Read-only commands and routine checks | None |
| Cancelling an active job | None |
| Shell or interpreter indirection, unknown commands, mutations, publishing, deploys, destructive commands | Required |
| Force-closing an editor with unsaved changes or an active job | Required |

Confirmations go to voice mode first (see Live Codex), then the TUI. If neither is available, or intent or safety is unclear, the action is refused.
