# pi-loop

Run a prompt repeatedly, with a fresh session for every iteration. Each new session uses the model selected in the preceding session (including a custom non-default model); changing models mid-loop takes effect on the next iteration. If that model is unavailable, the loop pauses rather than falling back to the default.

```bash
pi install npm:@brettinternet/pi-loop
```

```text
/loop <count> [--delay <duration>] <prompt>
/loop for <duration> --delay <duration> <prompt>
/loop <count>
/loop +<count>
/loop -<count>
/loop time <duration>
/loop delay <duration>
/loop prompt <text>
/loop append <text>
/loop status
/loop
/loop pause
/loop end
/loop resume
/loop next
```

Durations use `ms`, `s`, `m`, `h`, or `d`. Delays range from 1 second to 24 hours. Timed loops run for at most 30 days. During a loop, `/loop time <duration>` switches to a deadline from now or resets the current deadline; timed mode requires a non-zero delay. `/loop <count>` switches back to a count of future iterations.

Errors retry after 30 seconds, 1 minute, and 2 minutes, then pause. Aborting pauses the loop. `/loop pause` pauses after the active iteration settles; if the loop is between iterations, it pauses immediately. Resuming then starts the next iteration. An agent `loop_pause` request pauses mid-iteration for human blockers, and resuming continues that iteration. Recovery preserves the loop so you can resume or advance it.

Chain commands in the prompt:

```text
/loop 10 /wait 10m /skill:myskill skill argument here
```

Built-in interactive commands cannot be chained.

While a loop is active, every child command receives its stable run ID as `PI_LOOP_RUN_ID`:

```text
PI_LOOP_RUN_ID=3992f183-e054-4068-a13e-11281d1747e2
```

The value is always the full UUID, remains unchanged across every iteration and replacement session in that loop, and differs between independent loops. When the loop ends or its session closes, pi-loop restores the previous value or removes the variable if it was previously unset.
