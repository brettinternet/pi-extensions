# pi-loop

Run a prompt repeatedly, each iteration in a fresh session.

```sh
pi install npm:@brettinternet/pi-loop
```

```text
/loop 5 Fix the next failing test
/loop 10 --delay 30m Check CI and fix failures
/loop for 2h Fix failing tests
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
/loop time 2h         stop 2h from now
/loop delay 5m        change the gap between iterations
/loop prompt <text>   replace the prompt
/loop append <text>   append to the prompt
/loop pause           pause after this iteration
/loop resume          resume
/loop next            skip a paused iteration and start the next
/loop end             stop gracefully
/loop                 same as end
```

Durations use `ms`, `s`, `m`, `h`, or `d`. Delays range from 1s to 24h; use `off` to disable a delay. Both counted and timed loops default to no delay between completed iterations. Timed loops run for at most 30 days and stop starting new iterations at the deadline; an active iteration can finish.

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
| Async subagent workflow or supervisor request | Originating session and iteration stay alive through completion delivery and the parent's result-processing turn |
| Subagent liveness provider disappears or is unavailable after an async launch | Loop pauses with a reload diagnostic instead of discarding the session |

Use `/loop delay` for a fixed gap, `/wait` for a same-session follow-up, and `until` for a condition that may become true sooner.

### Async subagents

A yielded assistant turn (for example, “review is running”) is not an iteration boundary while its subagent work remains outstanding. Loop uses pi-subagents' existing **pi-web session-liveness v1 registry** to wait through execution, supervisor questions, result delivery, and queued completion notifications. After the parent receives the result, it can apply fixes or commit in the same session; rollover occurs only after that parent turn settles and all blockers clear. Multiple workflows are covered together. Failure or cancellation still requires the producer's final disposition, not merely a stop request.

Use a pi-subagents build containing upstream #2683 and the queued-wake reload fix. The registry is `Symbol.for("@agegr/pi-web/session-liveness/v1")`; the former fork-only query/changed events are no longer used. Loop installs its adapter before session startup and forwards registrations if a compatible host registry already exists. Providers are matched by the session UUID, not the session-file path. A missing provider after an observed async launch pauses the loop rather than guessing. Older registry implementations cannot be version-detected, so install the required fixes and restart Pi. Loops without subagents need no additional package.

The gate checks immediately at settlement, automatic rollover (including after a configured loop delay), and recovery. While subagents block a boundary, it checks only the in-memory registry every 250 ms because the registry has no change notification; completion events also request an immediate recheck. There is no run-file polling, arbitrary grace period, or forced synchronous review. The check timer stops on parent turn start, pause, or shutdown. Explicit `/loop next` remains a manual skip for a paused iteration.

Cross-package SDK regression (a source checkout is required; no real model calls or child processes):

```sh
PI_SUBAGENTS_TEST_SOURCE=/path/to/pi-subagents bun test test/loop/subagents-sdk.test.ts
```

This exercises both extension load orders, parent yield and result processing, and reload with an accepted queued completion. The suite is skipped when that environment variable is absent.

## Run ID

Every command run during a loop gets the loop's ID:

```text
PI_LOOP_RUN_ID=3992f183-e054-4068-a13e-11281d1747e2
```

The UUID stays the same for every iteration of one loop and differs between loops. When the loop ends, the previous value is restored or the variable is removed.
