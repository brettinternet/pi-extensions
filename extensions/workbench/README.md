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
