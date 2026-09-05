# Future global voice broker

## Idea and motivation

Today `pi-live-codex` has one cooperative owner per host. The owner is an atomic lock directory with a short-lived loopback control endpoint. That keeps voice handoff local, explicit, and easy to recover when a process dies. A future global voice broker could make voice a shared Pi capability across sessions, workspaces, and providers: one broker would own the audio connection, route controls to the selected Pi session, and expose consistent status to other voice clients.

The motivation is continuity. Users should be able to move between Pi sessions without treating the voice transport as a second execution engine or interrupting work already running in the original session. A broker could also support discoverable ownership, richer handoff UX, and clients other than this extension.

## Boundaries

The broker would own voice transport, ownership, authentication, and routing. It would not own Pi turns, foreground or background jobs, tool policy, confirmation policy, session history, or workspace authority. Pi sessions would remain responsible for their own work and would explicitly report whether a handoff is safe.

The current loopback protocol is deliberately narrower: it authenticates a same-host requester, asks the current owner to stop only its `LiveSession`, and leaves Pi work running. It refuses handoff while voice requests are queued or voice-routed confirmations are pending; active/running work is not itself a blocker.

## Migration path

1. Keep the directory lock and loopback protocol as the compatibility fallback for one-host installations.
2. Define a versioned broker protocol with the same authenticated request/response and bounded-payload rules.
3. Add a broker client behind the existing acquire/handoff boundary; do not change `LiveSession` or Pi work ownership.
4. Let the broker advertise its endpoint and lease identity, then migrate one client at a time.
5. Retain stale lock recovery and a local fallback until broker adoption is reliable; remove the fallback only after an explicit compatibility decision.

## Unresolved questions

- Should the broker be per-user, per-host, or account-backed, and how should multiple users on one host be isolated?
- What transport and credential storage provide secure local and remote operation without making Pi startup depend on a daemon?
- How should a broker represent a disconnected session, lease expiry, process identity, and recovery after broker restart?
- Should handoff blockers be globally standardized, or should each Pi client provide an actionable explanation?
- How should audio device selection, mute state, model/voice settings, and provider authentication follow the selected session?
- What observability and audit trail are appropriate without persisting sensitive voice content?
