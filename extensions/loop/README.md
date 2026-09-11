# pi-loop

Run a prompt repeatedly, with a fresh session for every iteration.

```bash
pi install npm:@brettinternet/pi-loop
```

```text
/loop <count> [--delay <duration>] <prompt>
/loop for <duration> --delay <duration> <prompt>
/loop <count>
/loop +<count>
/loop -<count>
/loop delay <duration>
/loop prompt <text>
/loop append <text>
/loop status
/loop
/loop end
/loop resume
/loop next
```

Durations use `ms`, `s`, `m`, `h`, or `d`. Delays range from 1 second to 24 hours. Timed loops run for at most 30 days.

Errors retry after 30 seconds, 1 minute, and 2 minutes, then pause. Aborting pauses the loop. A `loop_pause` request pauses for human blockers. Recovery preserves the loop so you can resume or advance it.

Chain commands in the prompt:

```text
/loop 10 /wait 10m /skill:myskill skill argument here
```

Built-in interactive commands cannot be chained.
