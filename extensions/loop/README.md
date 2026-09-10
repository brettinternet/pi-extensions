# Pi Loop

`@brettinternet/pi-loop` runs one prompt for a bounded number of iterations or wall-clock duration. Every iteration gets a new Pi session, so files remain available while conversation history does not.

## Commands

```text
/loop <count> [--delay <duration>] <prompt>       Start a counted loop; count must be positive
/loop for <duration> --delay <duration> <prompt>  Start a timed loop with a required non-zero delay
/loop <count>                                    While a counted loop is active or stopping, replace its future-iteration budget
/loop +<count>                               Add future iterations while active or stopping
/loop -<count>                               Remove future iterations while active or stopping
/loop delay <duration>                       Set the delay for an active, stopping, or paused loop
/loop prompt <text>                          Replace the prompt for future iterations
/loop append <text>                          Append instructions to the prompt for future iterations
/loop status                                 Show run, iteration, budget, retries, delay, and pause diagnostics
/loop                                         Gracefully end after the active iteration
/loop end                                    Gracefully end, or end a paused loop immediately
/loop resume                                 Retry a paused iteration in the same session, or cancel a pending end
/loop next                                   Complete a paused iteration and start the next one in a fresh session
```

Durations use a number followed by `ms`, `s`, `m`, `h`, or `d` (for example `1000ms`, `2s`, `1m`, or `2d`). Delays must be at least `1s` and no more than `24h`. Counted loops may use `/loop delay off`; timed loops require a non-zero delay so they cannot accidentally spin until their deadline. A timed loop may run for up to `30d`, persists an absolute deadline across sessions and reloads, and starts no new iteration once that deadline is reached. An iteration already running may finish normally. The delay starts after a settled iteration and never delays the first iteration. While a delay is pending, ending the loop cancels it immediately; prompt, budget, and delay updates are applied to the next iteration safely.

A retune changes only a counted loop's next-boundary future budget; it never changes the prompt. Timed loops have no iteration budget to retune. Retuning or resuming while a graceful end is pending cancels it and reuses the loop's prompt. A subtraction may reduce that budget to zero, ending the loop after the active iteration. Invalid or ambiguous forms are rejected instead of guessing.

Prompt updates never affect the active iteration or change its budget. `prompt` replaces the complete prompt, including prior appended instructions. `append` adds a blank line and the supplied text. Updates persist across all not-yet-started iterations and may also be made while paused for the retried iteration. Updating a stopping loop preserves the pending end. Ordinary messages still belong only to the current session; use these commands to configure future fresh sessions.

Loops continue only after `agent_settled`. An aborted or error assistant output is not considered terminal while Pi is automatically retrying or continuing after a permission prompt. After Pi fully settles with an error, the loop retries the same iteration in the same session up to three times, waiting 30 seconds, 1 minute, then 2 minutes. An explicit abort pauses immediately. Exhausted retries also pause without consuming the iteration; `/loop status` includes the retry count, reason, timestamp, and timed-loop deadline when applicable. Manual `/loop resume` resets the retry allowance.

Every active loop session receives stable system guidance about its unattended-loop context and can call the `loop_pause` tool when useful work cannot continue without human input, credentials, permissions, or another non-transient external dependency. The guidance deliberately omits iteration and deadline values to preserve a stable prompt prefix for provider caching. The tool records the supplied reason, pauses without consuming the iteration, and terminates that agent turn. Temporary conditions expected to resolve in a later iteration should not pause the loop.

An active loop restored after an abrupt restart, session resume, tree navigation, or `/reload` continues its interrupted iteration in the same session. Persisted delay and retry deadlines are restored instead of repeating an iteration that had already settled. An intentional process exit ends automatic recovery by marking the current owner inactive. If a mid-run `/loop` command interrupts the assistant, the extension continues that iteration in the same session so completed work and conversation context are preserved. `/loop resume` continues a paused iteration in place; `/loop next` treats it as complete and advances to the next iteration in a fresh session. Only the boundary between completed iterations creates a fresh session. State is stored in custom session entries, and each replacement records its parent session while keeping conversational messages out of the new session. The compact status widget is shown only while a loop is active, stopping, or paused. It counts down (`loop active 4/4`, then `3/4`), shows the configured delay, and shows the prompt after a middle dot, truncated to one line at the current terminal width.

Prompts that begin with an extension command, skill command, or prompt template are dispatched on every iteration. This allows chains such as:

```text
/loop 10 /wait 10m /skill:myskill skill argument here
```

Here `/loop` dispatches `/wait` for each iteration, and `/wait` dispatches `/skill:myskill` after the timeout. Built-in interactive commands such as `/model` and `/settings` cannot be chained because Pi does not expose them through programmatic prompt dispatch.

The extension does not use dialogs and is safe to load in print, JSON, and RPC modes.

Install it with:

```sh
pi install npm:@brettinternet/pi-loop
```
