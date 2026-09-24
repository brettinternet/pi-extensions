# pi-loop

Run a prompt repeatedly, each iteration in a fresh session.

```sh
pi install npm:@brettinternet/pi-loop
```

```text
/loop 5 Fix the next failing test
/loop 10 --delay 30m Check CI and fix failures
/loop for 8h --delay 1h Review new issues
/loop 10 /wait 10m /skill:myskill skill argument here
```

The last example chains commands. Built-in interactive commands can't be chained.

## Control a running loop

```text
/loop status          show state
/loop 3               run 3 more iterations from now
/loop +2              add 2 iterations
/loop -1              remove 1 iteration
/loop time 2h         stop 2h from now (requires a delay)
/loop delay 5m        change the gap between iterations
/loop prompt <text>   replace the prompt
/loop append <text>   append to the prompt
/loop pause           pause after this iteration
/loop resume          resume
/loop next            skip a paused iteration and start the next
/loop end             stop gracefully
/loop                 same as end
```

Durations use `ms`, `s`, `m`, `h`, or `d`. Delays range from 1s to 24h. Timed loops require `--delay` and run at most 30 days.

## Behavior

| Event | Result |
| --- | --- |
| Model or thinking level changed mid-loop | The next iteration uses it; both initially match the session that invoked `/loop` |
| Model unavailable | Loop pauses; no fallback to the default |
| Error | Retries after 30s, 1m, and 2m, then pauses |
| Abort | Loop pauses |
| `/loop pause` between iterations | Pauses immediately |
| Agent calls `loop_pause` | Pauses mid-iteration; resume continues that iteration |
| Pending `/wait` or `until` watch | Iteration waits for its wake-up turn or cancellation |
| Paused wait or recurring watch | Iteration waits until resumed or completed |

Use `/loop delay` for a fixed gap, `/wait` for a same-session follow-up, and `until` for a condition that may become true sooner.

## Run ID

Every command run during a loop gets the loop's ID:

```text
PI_LOOP_RUN_ID=3992f183-e054-4068-a13e-11281d1747e2
```

The UUID stays the same for every iteration of one loop and differs between loops. When the loop ends, the previous value is restored or the variable is removed.
