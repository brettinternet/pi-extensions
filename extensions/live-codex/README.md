# pi-live-codex

Talk to OpenAI Codex from Pi.

```sh
pi install npm:pi-live-codex
```

Requires Node 22.19+ and a microphone.

```text
/login openai-codex
/live            start voice mode
/live <voice>    start with a voice
```

| Key | Action |
| --- | --- |
| `Ctrl+L` | Toggle live mode |
| `Esc` | End voice mode |
| `Space` (empty editor) | Mute or resume |
| Type, then `Enter` | Send a text note |

Drop images into the session to share them.

Requests made while one is running are queued, with status updates and cancellation. Voice also tracks background work such as subagents, can cancel it, and can answer confirmation requests from other extensions.

Only one Pi session owns the microphone at a time. Starting voice in another session pauses the first; it keeps its transcript and drafts, and its work keeps running.
