# pi-wait

Continue a prompt after a delay.

```bash
pi install npm:pi-wait
```

```text
/wait <duration> <prompt>
/wait status
/wait cancel
/wait
```

Durations use `ms`, `s`, `m`, `h`, or `d`, up to 24 days. Press `Enter` to start the wait immediately.

Follow-up prompts queue after current work settles. If the timer expires while Pi is busy, the prompt waits in the queue.

`wait_then_continue` ends the current turn, then starts its timer after the turn settles. Do not use it during an active `/loop`.

Example:

```text
/wait 10m Check whether the deployment completed
```

Chain it with a loop:

```text
/loop 10 /wait 10m Check the deployment again
```
