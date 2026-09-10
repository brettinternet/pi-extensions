# herdr-agent-state

Reports aggregate Pi lifecycle state to Herdr so the pane stays active while async subagent children run after the parent turn settles.

## Why

Herdr's managed Pi integration (v8) tracks only the parent process and does not consume `herdr:busy` from pi-subagents. Async work appears idle before it finishes. This extension replaces the managed integration as the sole lifecycle reporter. Uninstall the managed integration first:

```
herdr integration uninstall pi
```

## State precedence

1. **blocked** — the parent is waiting for user input
2. **working** — parent or any subagent is working; subagent attention stays working with a warning label
3. **idle** — everything else

Session identity and restore are preserved by reporting under `herdr:pi` before lifecycle state.

## Upstream

- [herdr/herdr#3796](https://github.com/herdrdev/herdr/issues/3796) (closed, classified as feature request)
- [herdr/herdr#3323](https://github.com/herdrdev/herdr/discussions/3323) (open discussion tracking native support)
