# pi-live-codex

Talk to OpenAI Codex from Pi.

```bash
pi install npm:pi-live-codex
```

Requires Node 22.19+ and a microphone. Sign in with:

```text
/login openai-codex
```

Use voice mode with:

```text
/live
/live <voice>
```

Press `Ctrl+L` to toggle live mode. Press `Esc` to end voice mode. When the editor is empty, press `Space` to mute or resume, or type a note and press `Enter`. You can also drop images into the session.

Concurrent requests are queued, with immediate status updates and cancellation. Audio has one owner at a time, with retained-state handoff when ownership changes.

Background activity and confirmation events are integrated into the live experience.
