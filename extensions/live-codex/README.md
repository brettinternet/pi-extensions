# pi-live-codex

Realtime `gpt-live-1-codex` voice mode for the [Pi coding agent](https://pi.dev). Speak naturally; repository work is delegated to the active Pi session and results are read back.

## Install

```sh
pi install npm:pi-live-codex
```

Requires Node.js 22.19+, microphone access, and an OpenAI Codex login (`/login openai-codex`).

## Use

Start Pi in its interactive TUI, then run:

```text
/live
```

Use `/live <voice>` to select a voice. Press `Tab` after `/live ` to choose a known Realtime voice; custom voice names remain accepted. The transcript keeps the latest four utterances; start Pi with `--live-transcript-limit <n>` to choose a different positive-integer limit. `Ctrl+L` toggles voice mode and `Esc` ends the voice session. While live, typing any printable non-whitespace character immediately opens the Pi editor; bare `Space` mutes only while that editor is empty, and inserts a space otherwise. Press `Enter` with nonblank editor text to stage a verbatim typed note (bounded to 4,000 characters) for the next ordinary spoken request. It is sent as a separate text block alongside any images and never starts a standalone Pi turn. Drop image files into the terminal while live to attach them to that request; a valid image drop also reveals the editor.

You can make additional requests while work is running. Independent requests are dispatched to Pi in order, while background activities continue concurrently. Their completion is correlated with the request that launched them and announced through the live session. A clear request to stop the current foreground operation aborts that Pi turn. A request to cancel an unambiguous background activity is routed only to its provider. Staged typed notes wait through confirmation and cancellation controls, block voice handoff, and are restored to the normal Pi editor when live mode is stopped. Existing subagent lifecycle events and stop RPC remain supported.

Only one Pi session owns live voice at a time. If another session owns it, `/live` asks whether to move voice here. Confirming sends an authenticated local request; the old session stops only its voice surface, releases ownership, and leaves its foreground/background Pi work running. Voice then starts here automatically. Handoff is refused while the old voice session has undispatched voice requests or pending voice-routed confirmations; resolve those in the old session first. Running work by itself does not block handoff. See [`global-voice-broker.md`](global-voice-broker.md) for the future broker design.

## Background activity wire contract

Separately installed extensions integrate through `pi.events`; no package imports are required. Live Codex keeps its own structural validation and types in `background-activity.ts`.

- `pi:background-activity:v1:started`: `{ version: 1, provider, activityId, kind, sessionId, sessionFile?, workspaceId?, originId?, label, cancellable, resumed? }`. Fresh activities require `originId`, which is the originating Pi tool-call ID. Only snapshot/replayed activities may set `resumed: true` and omit it.
- `pi:background-activity:v1:finished`: `{ version: 1, provider, activityId, kind, sessionId, sessionFile?, workspaceId?, outcome, exitCode?, summary }`, where outcome is `succeeded`, `failed`, or `cancelled`.
- `pi:background-activity:v1:cancel`: `{ version: 1, requestId, provider, activityId, sessionId, sessionFile?, workspaceId? }`. Reply on `pi:background-activity:v1:cancel-reply:<requestId>` with `{ version: 1, requestId, success, error? }`. Success means accepted; `finished` remains the terminal signal.
- `pi:background-activity:v1:snapshot`: `{ version: 1, requestId, sessionId, sessionFile?, limit }`. Each producer may reply on `pi:background-activity:v1:snapshot-reply:<requestId>` with `{ version: 1, requestId, provider, activities }`; entries use the started schema with `resumed: true`. Discovery accepts at most 100 entries during a 250 ms window.

Identity is always `(provider, activityId)`. `sessionId` must exactly match the active Pi session; a supplied session file and workspace are retained and must also match across start/finish/cancel events.

## Confirmation wire contract

Separately installed extensions can request one-operation authorization through a second versioned `pi.events` contract. Request and resolution text and pending counts are bounded; requests expire and are never persisted.

- `pi:confirmation:v1:requested`: `{ version: 1, requestId, sessionId, sessionFile?, provider, operationId, riskCategory, title, summary, expiresAt }`
- `pi:confirmation:v1:acknowledged:<requestId>`: echoes `{ version, requestId, sessionId, sessionFile?, provider, operationId }`
- `pi:confirmation:v1:resolved:<requestId>`: echoes that identity and adds `decision: "approved" | "denied"`
- `pi:confirmation:v1:released:<requestId>`: echoes the exact identity without a decision when voice ownership ends
- `pi:confirmation:v1:cancelled`: echoes the original request when the requester falls back to another confirmation surface

While `/live` is active, Live Codex acknowledges a structurally valid request for the exact active Pi session. It first describes the action and risk, then asks the question, and ends by requesting the exact one-word answer `approve` or `deny`. Only that finalized transcript resolves the current request; ambiguous phrasing is re-prompted, and concurrent requests are serialized. Wrong-session, expired, duplicate, unknown, and mismatched-operation controls are ignored. Manual voice stop and transport failure release pending requests after the editor is restored; Workbench then continues the same request through its serialized TUI prompt. Session shutdown releases no interactive handoff and remains fail closed.

Only one Pi process can use live voice at a time.
