# Pi Wait

`@brettinternet/pi-wait` queues one prompt and sends it after a timeout.

```text
/wait <duration> <prompt>  Queue a message, replacing any existing queued message
/wait status             Show the queued message and remaining time
/wait cancel             Cancel the queued message
/wait                    Show status
```

Durations use `ms`, `s`, `m`, `h`, or `d`, such as `500ms`, `30s`, `5m`, `1h`, or `1d`. The maximum is 24 days.

While a message is queued, a widget above the prompt editor shows its state, text, and the cancellation command. Submitting `/wait` as a follow-up with Pi's queue key (for example, `Ctrl+Q` when configured) waits for the current agent to settle before starting the timer. Submitting it as an Enter steering message starts the timer immediately. If Pi is working when an active timer expires, the message is queued as a follow-up and runs after the current agent settles.

Delivered prompts dispatch extension commands, skill commands, and prompt templates, so `/wait 10m /skill:myskill skill argument here` works as a command chain. Built-in interactive commands such as `/model` and `/settings` cannot be chained because Pi does not expose them through programmatic prompt dispatch. Waits are session-scoped and are cancelled when the session shuts down or extensions reload.

Install it with:

```sh
pi install npm:@brettinternet/pi-wait
```
