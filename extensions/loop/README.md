# Pi Loop

`@brettinternet/pi-loop` runs one prompt for a bounded number of iterations. Every iteration gets a new Pi session, so files remain available while conversation history does not.

## Commands

```text
/loop <count> <prompt>   Start a loop; count must be positive
/loop <count>            While active, replace the future-iteration budget
/loop status             Show run, iteration, budget, and pending retune
/loop                    Gracefully stop after the active iteration
/loop stop               Gracefully stop, or stop a paused loop immediately
/loop resume             Retry the paused iteration in a fresh session
```

A retune changes only the next boundary's future budget; it never changes the prompt. Invalid or ambiguous forms are rejected instead of guessing.

Loops continue only after `agent_settled`. Aborted or error assistant output pauses the loop without consuming an iteration. State is stored in custom session entries, and each replacement records its parent session while keeping conversational messages out of the new session. The compact status widget is shown only while a loop is active, stopping, or paused.

The extension does not use dialogs and is safe to load in print, JSON, and RPC modes.

Install it with:

```sh
pi install npm:@brettinternet/pi-loop
```
