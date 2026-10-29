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
| Type or paste, then `Enter` | Share text with voice without starting work |

Shared text appears in the live transcript and reaches voice immediately as silent reference context. Then describe what you want aloud; the next backend request includes the text. Enter alone does not request analysis or approve an action.

Drop image files into the session to attach them to the next backend request. Voice receives the filenames, not the image contents; it can discuss the images after the backend returns its findings. Dropping images does not start work. Clipboard image paste is not supported by the live editor.

Requests made while one is running are queued, with status updates and cancellation. Voice also tracks background work such as subagents, can cancel it, and can answer confirmation requests from other extensions.

Only one Pi session owns the microphone at a time. Starting voice in another session pauses the first; it keeps its transcript and drafts, and its work keeps running.

## Over SSH

Voice uses the microphone and speaker of the machine Pi runs on. To talk to a remote Pi (plain SSH or Herdr) through your local machine, run a relay locally and forward its socket:

```text
/live-relay            in a local Pi; keep it open
```

```sh
ssh -N -R /home/you/.pi/live-codex-relay.sock:$HOME/.pi/live-codex-relay.sock remote
```

Then `/live` on the remote. Audio flows directly between your machine and OpenAI; only control messages cross SSH. Any Pi that can reach `~/.pi/live-codex-relay.sock` uses the relay, one session at a time, including local ones.

The remote `~/.pi` directory must exist. Set `StreamLocalBindUnlink yes` in the remote `sshd_config`, or remove the stale socket, before reconnecting. Use a dedicated forward: Herdr's own SSH connection closes when idle.
