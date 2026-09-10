# Pi Wait

`@brettinternet/pi-wait` queues one prompt and sends it after a timeout.

```text
/wait <duration> <prompt>  Queue a message, replacing any existing queued message
/wait status             Show the queued message and remaining time
/wait cancel             Cancel the queued message
/wait                    Show status
```

Durations use `ms`, `s`, `m`, `h`, or `d`, such as `500ms`, `30s`, `5m`, `1h`, or `1d`. The maximum is 24 days.

While a message is queued, a countdown widget above the prompt editor shows its text and the cancellation command. If Pi is working when the timer expires, the message is queued as a follow-up and runs after the current agent settles. Waits are session-scoped and are cancelled when the session shuts down or extensions reload.

Install it with:

```sh
pi install npm:@brettinternet/pi-wait
```
