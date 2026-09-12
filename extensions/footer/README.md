# Pi Footer

A responsive two-line footer for [Pi](https://pi.dev), designed for terminals with a Nerd Font.

```text
󰉋 ~/dev/project   main  +18 -4 ●2 ✚1   +1                 Refine footer
󰘦 ████░░░░░░ 42k/114k 37%    󰍉 86k  󰍌 4.2k  󰒍 R61k  󰆼 $0.124  󰚩 openai/gpt-5.4   high
```

It shows:

- path, branch, current diff lines, staged/unstaged/untracked file counts, and session commits
- a color-coded context gauge with current tokens, capacity, and percentage
- cumulative input/output/cache tokens, latest cache hit rate, cost, provider/model, and thinking level
- the Pi session title and statuses published by other extensions

Git data refreshes every two seconds. The commit count is relative to the first commit recorded for the Pi session and survives reloads. It describes commits made during the session; it cannot prove which process or person authored them.

The footer progressively removes lower-priority cache details on narrow terminals while preserving context, input/output usage, cost, and model information where space allows.

## Install

```sh
pi install npm:@brettinternet/pi-footer
```
