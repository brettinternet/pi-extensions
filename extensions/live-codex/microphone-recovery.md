# Microphone recovery follow-up

Upstream: [can1357/oh-my-pi#11617](https://github.com/can1357/oh-my-pi/issues/11617) covers runtime default-input changes, device loss, and async failure reporting. The related [#6846](https://github.com/can1357/oh-my-pi/issues/6846) was a separate macOS build regression, fixed by [#6849](https://github.com/can1357/oh-my-pi/pull/6849).

## Current mitigation

The native API can't report device changes, so `controller.ts` runs a watchdog:

| Condition | Action |
| --- | --- |
| No capture callback for 5 seconds | Recreate `AudioCapture` once per connection, possibly on a new default input; log `microphone-restarted` |
| Replacement also stalls | End voice mode and tell the user to restart Pi |
| Callback from a stopped or replaced recorder | Ignore it |
| Pause or stop | Clear the watchdog |

It can't detect a device that keeps sending silent frames, because silence is valid input. That needs the native layer.

## Required native behavior

The macOS `AudioCapture` should:

1. Observe default-input changes and device invalidation.
2. Reopen capture on the current default input without a restart.
3. Report unrecoverable async failures through the callback or another explicit API.
4. Keep stop and teardown idempotent during recovery.

## After an upstream release

1. Verify the released API's recovery and error semantics.
2. Bump `@oh-my-pi/pi-natives` in `package.json`, `extensions/live-codex/package.json`, and `bun.lock`.
3. Remove redundant watchdog behavior, but keep a visible failure when native recovery fails.
4. Preserve pause, resume, stop, stale-callback rejection, and single-recorder ownership.
5. Update `README.md` and controller tests to describe native behavior.

## Acceptance checks

- Changing the default input during capture moves capture to the new device.
- Unplugging and replugging an input recovers or ends voice mode with a clear error.
- Handoff pause and resume release and recreate capture.
- Muting doesn't trigger stall recovery; callbacks remain the heartbeat.
- No timers, recorder handles, or stale callbacks survive pause, stop, failed startup, or recovery.
- `bun run check`, `bun test test/live-codex/controller.test.ts`, and `bun test` pass.
