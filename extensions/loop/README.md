# Pi Loop

`@brettinternet/pi-loop` runs one prompt for a bounded number of iterations. Every iteration gets a new Pi session, so files remain available while conversation history does not.

## Commands

```text
/loop <count> [--delay <duration>] <prompt>  Start a loop; count must be positive
/loop <count>                               While active or stopping, replace the future-iteration budget
/loop +<count>                               Add future iterations while active or stopping
/loop -<count>                               Remove future iterations while active or stopping
/loop delay <duration>                       Set the delay for an active, stopping, or paused loop
/loop prompt <text>                          Replace the prompt for future iterations
/loop append <text>                          Append instructions to the prompt for future iterations
/loop status                                 Show run, iteration, budget, pending retune, and delay
/loop                                         Gracefully stop after the active iteration
/loop stop                                   Gracefully stop, or stop a paused loop immediately
/loop resume                                 Retry a paused iteration, or cancel a pending stop
```

Durations use a number followed by `ms`, `s`, `m`, or `h` (for example `1000ms`, `2s`, or `1m`). Delays must be at least `1s` and no more than `24h`; `0ms` means no delay when reading older state. The delay starts after a settled iteration and never delays the first iteration. While a delay is pending, stop cancels it immediately; prompt, budget, and delay updates are applied to the next iteration safely.

A retune changes only the next boundary's future budget; it never changes the prompt. Retuning or resuming while a graceful stop is pending cancels the stop and reuses the loop's prompt. A subtraction may reduce that budget to zero, ending the loop after the active iteration. Invalid or ambiguous forms are rejected instead of guessing.

Prompt updates never affect the active iteration or change its budget. `prompt` replaces the complete prompt, including prior appended instructions. `append` adds a blank line and the supplied text. Updates persist across all not-yet-started iterations and may also be made while paused for the retried iteration. Updating a stopping loop preserves the pending stop. Ordinary messages still belong only to the current session; use these commands to configure future fresh sessions.

Loops continue only after `agent_settled`. Aborted or error assistant output pauses the loop without consuming an iteration. State is stored in custom session entries, and each replacement records its parent session while keeping conversational messages out of the new session. The compact status widget is shown only while a loop is active, stopping, or paused. It counts down (`loop active 4/4`, then `3/4`), shows the configured delay, and shows the prompt after a middle dot, truncated to one line at the current terminal width.

The extension does not use dialogs and is safe to load in print, JSON, and RPC modes.

Install it with:

```sh
pi install npm:@brettinternet/pi-loop
```
