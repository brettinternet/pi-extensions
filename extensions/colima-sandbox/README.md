# Colima sandbox

Runs Pi with its filesystem and shell tools inside a disposable Colima container. The current Git repository is mounted read-write at `/workspace`, so repository changes persist, while host credentials and the rest of the host filesystem stay unavailable to tools.

The container has a read-only root filesystem, limited resources, and no network access by default. It is removed when Pi exits. Pi itself and its model credentials remain on the host.

## Requirements

- Colima running with Docker's `colima` context
- `~/.dotfiles/ai/pi/extensions/dcg-guard.ts`
- A main Git checkout; linked worktrees are not supported

## Use

Run the launcher from the repository root. The `--` separates launcher options from normal Pi arguments.

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --
~/dev/me/pi-extensions/bin/pi-sandbox -- --model gpt-5 --thinking high
~/dev/me/pi-extensions/bin/pi-sandbox -- --print "inspect the tests"
```

Allow network access when needed:

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --network=unrestricted --
```

Only Pi's built-in `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools are available. Custom tools, MCP, subagents, project extensions, and launches below the repository root are not supported. Docker, Colima, Pi, and the launcher remain trusted host components.
