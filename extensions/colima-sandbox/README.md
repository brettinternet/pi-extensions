# Colima Sandbox

Run Pi's file and shell tools in a disposable Colima container. Pi and its model credentials stay on the host.

```sh
~/dev/me/pi-extensions/bin/pi-sandbox --                                # no network
~/dev/me/pi-extensions/bin/pi-sandbox -- --model gpt-5 --thinking high  # Pi args after --
~/dev/me/pi-extensions/bin/pi-sandbox --network=unrestricted --         # allow network
```

Run it from the repository root. Inside, run `/sandbox` for container status.

| | Inside the container |
| --- | --- |
| Current repository | `/workspace`, read-write |
| Rest of host, credentials, Docker socket | Not available |
| Root filesystem | Read-only |
| Network | None unless `--network=unrestricted` |
| Tools | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| Lifetime | Removed when Pi exits |

## Requirements

- Colima running with the `colima` Docker context
- `~/.dotfiles/ai/pi/extensions/dcg-guard.ts`
- A main Git checkout (not a linked worktree)

Not supported: custom tools, MCP, subagents, project extensions, and launching below the repository root. Docker, Colima, Pi, and the launcher are trusted host components.
