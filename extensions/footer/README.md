# Footer

A responsive footer for [Pi](https://pi.dev). Requires a Nerd Font.

```text
~/dev/project   main  +18 -4 ●2 ✚1   +1                 Refine footer
━━━━────── 37%/114k    ↑86k ↓4.2k R61k $0.124 openai/gpt-5.4 high
```

| Line | Shows |
| --- | --- |
| 1 | Path, branch, diff lines, staged/unstaged/untracked counts, session commits, session title |
| 2 | Context gauge, input/output/cache tokens, cache hit rate, cost, model, thinking level |
| 3 | Statuses from other extensions, when any are set |

Git data refreshes every two seconds. Session commits count from the first commit seen in the session and survive `/reload`; they show commits made during the session, not who made them.

Narrow terminals drop usage, cache, and cost first and keep the model and thinking level.

## Install

Not published to npm. Install the repository package or load it directly:

```sh
pi -e ./extensions/footer/index.ts
```
