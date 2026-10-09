# pi-agent-state

Reports Pi and async subagent activity using the terminal-neutral [Program Status Protocol (OSC 7501, revision 0.3)](https://www.superlogical.com/rex/docs/build/program-status). Also retains Herdr socket reporting and session identity for restore.

| State | When |
| --- | --- |
| `blocked` | Pi waits on an input prompt, an `ask_user_question` questionnaire, or an extension confirmation |
| `working` | Pi or any subagent is working; subagent attention and custom UI show a warning label |
| `idle` | Otherwise |

OSC reports address the root record with `app=pi`. Messages are control-free, UTF-8 base64, limited to 2048 decoded bytes. Each report replaces the previous status; shutdown clears it. Settled interactive turns report `idle`, not `done`, because Pi is waiting for the next instruction.

Reports are emitted only in interactive TUI mode with TTY stdout. No capability query is needed: the protocol permits unsolicited reports, and unsupported terminals ignore them. JSON, RPC, print, and redirected output never receive escape sequences.

## Install

```sh
pi install npm:pi-agent-state
```

If you already load Agent State through the full `pi-extensions` package or a local path, disable that copy before installing this package to avoid duplicate reports.

## Herdr compatibility

Inside Herdr, the extension additionally reports under `herdr:pi` through its socket API, preserving session identity and restore. After initial session registration, OSC state updates do not wait for socket delivery.

Herdr's built-in Pi integration (v8) tracks only the parent process, so async work looks idle too early. Uninstall that integration to avoid conflicting state reports:

```sh
herdr integration uninstall pi
```

## Extension events

Existing `herdr:busy` and `herdr:blocked` event names remain supported for current producers. Busy events use paired `active: true`/`false` values and an optional `label`. Blocked events additionally require `scope: "root"`; clear them in `finally`. `rpiv:ask-user:blocked` is also supported.

Native input prompts are tracked automatically. Generic custom UI is not treated as blocked because it also includes non-blocking inspectors.

## Migration

Renamed from `herdr-agent-state`. Package installs use the updated manifest automatically; explicit extension paths or package filters must change to `extensions/agent-state/index.ts`. Do not load both versions.
