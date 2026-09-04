# Pi Herdr Workbench

A typed Pi tool for the [`brettinternet.workbench`](https://github.com/brettinternet/herdr-plugins) Herdr plugin. It opens and reuses visible Neovim and LazyGit panes and runs observable foreground jobs without terminal keystroke simulation.

## Requirements

- Pi must be running inside Herdr.
- The Herdr workbench plugin must be installed and enabled.
- The Pi project must be trusted for pane or process mutations.

Install the extension:

```sh
pi install npm:pi-herdr-workbench
```

The extension registers one `workbench` tool. Read-only layout, status, list, and log operations are available without project trust. Mutations are restricted to resources created by or returned to the current Pi session; job lifecycle operations and closes cannot target another session's resources.

`job.start` returns immediately after creating the visible pane. The extension monitors the job, shows a bounded completion notification, treats a nonzero exit code as failure, and emits provider-neutral lifecycle events:

```text
pi:background-activity:v1:started
pi:background-activity:v1:finished
pi:background-activity:v1:cancel
pi:background-activity:v1:cancel-reply:<requestId>
pi:background-activity:v1:snapshot
pi:background-activity:v1:snapshot-reply:<requestId>
```

The event payload contract is exported from `protocol.ts`. Identity is scoped by provider, activity ID, Pi session, and Herdr workspace. Cancellation replies mean that cancellation was accepted; the terminal `finished` event reports the final outcome. Snapshot requests let consumers discover jobs that were already running before the consumer started. Workbench replies only for an exact current Pi session and caps each reply at 100 activities.

## Command confirmation policy

`job.start` classifies direct argv immediately before execution. Ordinary direct commands (including tests, builds, formatters, and linters) and the Git read-only allowlist (`status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`) run without confirmation. Shell interpreters, destructive filesystem or system commands, all other Git operations, package/release publishing, and recognized deployment or infrastructure mutations require confirmation. Cancellation of an explicitly owned job remains confirmation-free. `editor.close` and `job.close` accept an optional `force: true`; force-closing requires confirmation after ownership checks. The confirmation names the editor pane or job and warns that unsaved changes or remaining job pane/output state will be discarded. A normal close remains unforced, so the workbench plugin's dirty-editor refusal is returned unchanged. LazyGit close has no force mode.

A confirmation request is offered first to an active voice adapter, then to Pi's interactive TUI. It fails closed if neither is available. The dialog includes the complete bounded operation JSON and effective working directory. This is intentionally a narrow known-risk classifier rather than a general command sandbox: unknown direct executables are allowed, and scripts, aliases, uncommon launchers, or mutation flags on otherwise unknown tools may evade classification. Project trust and resource ownership checks still apply independently.
