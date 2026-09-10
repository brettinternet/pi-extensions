# Microphone recovery follow-up

Upstream tracking: [can1357/oh-my-pi#11617](https://github.com/can1357/oh-my-pi/issues/11617)

The related [#6846](https://github.com/can1357/oh-my-pi/issues/6846) was a separate macOS build regression fixed by [#6849](https://github.com/can1357/oh-my-pi/pull/6849). The new issue covers runtime default-input changes, device loss, and asynchronous failure reporting.

## Current mitigation

The extension-only watchdog in `controller.ts` is the immediate mitigation we chose while the native API cannot report device changes:

- Treat five seconds without a capture callback as a stalled microphone.
- Stop and recreate `AudioCapture` once per active connection. This may select a repaired or newly default input.
- Record `microphone-restarted` in session activity.
- End voice mode with restart-Pi guidance if the replacement capture stalls.
- Reject callbacks from stopped or replaced recorders and clear the watchdog during pause or stop.

This cannot detect a failed device that continues delivering silent frames. Silence is valid microphone input, so default-device observation and reliable device-loss recovery must happen in the native layer.

## Required native behavior

The macOS `AudioCapture` implementation should:

1. Observe default-input changes and input-device invalidation.
2. Reopen capture on the current default input without requiring a process restart.
3. Surface unrecoverable asynchronous capture failures through the JavaScript callback or another explicit API contract.
4. Keep stop and teardown idempotent while recovery is in progress.

## Follow-up after an upstream release

1. Inspect the released native API and verify its exact recovery and error semantics.
2. Bump `@oh-my-pi/pi-natives` in the root `package.json`, `extensions/live-codex/package.json`, and `bun.lock`.
3. Refactor or remove redundant watchdog behavior. Keep a visible terminal failure when native recovery cannot succeed.
4. Preserve pause, resume, stop, stale-callback rejection, and single-recorder ownership.
5. Update `README.md` and the controller tests to describe the native behavior rather than the temporary mitigation.

## Acceptance checks

- Changing the default input during active voice capture moves capture to the new device.
- Disconnecting and reconnecting an input either recovers automatically or ends voice mode with a clear error.
- Voice handoff pause and resume still release and recreate capture correctly.
- Muting does not trigger false stall recovery because capture callbacks remain the heartbeat.
- No watchdog timers, recorder handles, or stale callbacks survive pause, stop, failed startup, or recovery.
- `bun run check`, `bun test test/live-codex/controller.test.ts`, and `bun test` pass.
