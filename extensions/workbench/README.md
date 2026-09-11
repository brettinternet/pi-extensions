# Workbench

Workbench is a private local extension for trusted projects.

Load it directly from this repository:

```bash
pi -e ./extensions/workbench/index.ts
```

Workbench requires Herdr, the plugin, and a trusted project for mutations. It opens Neovim and LazyGit panes and shows visible jobs. Jobs are scoped to their owner and session.

Recognized read-only commands and routine checks run directly. Shell or interpreter indirection, unknown commands, mutations, publishing or deployment, and destructive operations require confirmation.

Cancelling an active job is confirmation-free. Force that discards unsaved editor changes or an active job requires confirmation.

Voice requests are handled before TUI requests. When intent or safety is unclear, Workbench fails closed.
