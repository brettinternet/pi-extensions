# pi-wait

Send a prompt after a delay.

```sh
pi install npm:pi-wait
```

```text
/wait 10m Check whether the deployment completed
/loop 10 /wait 10m Check the deployment again
```

## Commands

```text
/wait <duration> <prompt>   queue a prompt
/wait <duration>            reset the queued prompt's timer
/wait now                   send it now
/wait pause                 freeze the countdown
/wait resume                continue the countdown
/wait cancel                drop it
/wait status                show it and the time left
/wait                       same as status
```

A new `/wait <duration> <prompt>` replaces the queued prompt and timer. While the agent is busy, `Enter` starts the timer now; submitting as a follow-up starts it after the agent settles. Durations use `ms`, `s`, `m`, `h`, or `d`, up to 24 days.

## Behavior

The prompt waits for current work to settle. If the timer fires while Pi is busy, it stays queued. Active and paused waits survive `/reload`.

The agent can call `wait_then_continue`, which ends its turn and starts the timer once the turn settles. During `/loop`, the iteration waits for the queued prompt and its turn before moving on.
