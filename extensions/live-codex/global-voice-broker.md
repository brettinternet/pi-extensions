# Future global voice broker

## Today

One Pi session per host owns audio. Ownership is an atomic lock directory plus a short-lived loopback control endpoint.

```text
session A (owner)  ← handoff request ─  session B
  pauses audio, releases lock            acquires lock, opens audio
  keeps LiveSession, transcript,
  drafts, and Pi work running
```

Handoff is refused while voice-routed confirmations are pending. Queued or active work does not block it.

## Idea

A broker would own the audio connection for all sessions, route controls to the selected session, and report status to any voice client. Users could move between sessions, workspaces, and providers without interrupting work in the original session.

| Broker owns | Pi sessions own |
| --- | --- |
| Voice transport | Turns and jobs |
| Ownership and authentication | Tool and confirmation policy |
| Routing | Session history and workspace authority |
| | Reporting whether handoff is safe |

## Migration

1. Keep the lock and loopback protocol as the one-host fallback.
2. Define a versioned broker protocol with the same authentication and bounded payloads.
3. Add a broker client behind the existing acquire/handoff boundary without changing `LiveSession` or work ownership.
4. Have the broker advertise its endpoint and lease identity; migrate one client at a time.
5. Keep stale-lock recovery and the local fallback until the broker is reliable. Remove them only by explicit decision.

## Open questions

- Per user, per host, or account-backed? How are users on one host isolated?
- Which transport and credential storage work locally and remotely without making Pi startup depend on a daemon?
- How are disconnected sessions, lease expiry, process identity, and broker restarts represented?
- Standard handoff blockers, or per-client explanations?
- How do audio device, mute, model, voice, and provider auth follow the selected session?
- What observability and audit trail are appropriate without storing voice content?
