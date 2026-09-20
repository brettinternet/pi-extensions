# pi-until

Watch a shell condition or run recurring follow-ups without blocking Pi.

- Exit code `0` means true.
- Checks run in the background without model turns.
- Watches belong to one live Pi session.

## Install

```bash
pi install npm:pi-until
```

Restart Pi or run `/reload`.

## Watch a condition

```ts
until({
  action: "start",
  condition: "test -f .deploy-finished",
  label: "deployment",
  intervalSeconds: 30,
  wake: "agent",
});
```

Pi checks immediately, then every 30 seconds. Success wakes the agent once.

```ts
until({
  action: "start",
  condition: "ssh host 'test -f ~/migration/verify.done'",
  label: "migration verification",
  wake: "notify",
});
```

`wake: "notify"` reports success without starting an agent turn.

| `start` option | Default | Limit |
| --- | --- | --- |
| `intervalSeconds` | `30` | `1` to `86400` |
| `checkTimeoutSeconds` | `30` | `1` to `3600` |
| `timeoutSeconds` | `86400` (24h) | 30 days |
| `cwd` | Pi working directory | Existing directory |
| `label` | `condition` | 120 characters |
| `wake` | `agent` | `agent` or `notify` |

## Run recurring work

```ts
until({
  action: "repeat",
  instruction: "Review the deployment and fix remaining failures.",
  quickRef: "Release 42 verification",
  contextRefs: [{ label: "Runbook", target: "docs/release.md" }],
  intervalSeconds: 21_600,
  timeoutSeconds: 86_400,
  condition: "test -f .deploy-finished",
  immediate: false,
});
```

The optional `condition` must exit `0` before that tick wakes the agent. It does not complete the recurrence.

Recurring watches:

- stay in the same session;
- keep cadence anchored to the original schedule;
- send one immutable task packet at a time;
- count overlapping ticks as `missedTicks` instead of stacking turns;
- require `timeoutSeconds`, `instruction`, and `quickRef`;
- always wake the agent.

Finish explicitly:

```ts
until({ action: "complete", id: "8f2c1a7d" }); // goal achieved
until({ action: "cancel", id: "8f2c1a7d" });   // stop without success
```

A finished turn does not complete a recurring watch.

## Tool actions

| Action | Result |
| --- | --- |
| `start` | Watch a shell condition |
| `repeat` | Schedule recurring follow-ups |
| `list` | List active and recent watches |
| `status` | Inspect one watch |
| `complete` | Complete recurring work |
| `cancel` | Stop any watch |

Up to 32 watches may be active.

## Commands

```text
/until start <side-effect-free shell condition>
/until list
/until status <id>
/until complete <id>
/until cancel <id>
/until stats
```

The first argument is always an action, so shell conditions cannot conflict with command names. Completion suggests actions, common conditions, and relevant active watch IDs.

## Session display

```text
╭─ UNTIL · deployment ────────────────────────────────────╮
│ ◷ next 12s · 2m14s elapsed · 5 checks                  │
╰─ 8f2c1a7d · wakes agent · /until list ─────────────────╯
```

`/until list` opens active and recent watches. Other extensions can observe active watches:

```ts
pi.events.on("pi-until:watches", (watches) => {
  // [{ id, label, kind, status, nextDueAt, attempts, ... }]
});
```

## Lifecycle

| Event | Result |
| --- | --- |
| Agent turn ends | Watch continues |
| `/reload` | Watches, delivery state, and recent receipts restore |
| `/new`, `/resume`, `/fork` | Watches stop |
| Pi exits or the machine reboots | Watches stop |
| Print or JSON mode | New watches are rejected |

Use a durable scheduler when work must survive the owning Pi process.

## Telemetry

Telemetry is off by default.

```bash
PI_UNTIL_TELEMETRY=1 pi
PI_UNTIL_TELEMETRY_FILE=/path/events.jsonl pi
```

The JSONL file contains watch metadata and 12-character condition hashes, never command text or recurring instructions. It rotates at 5 MiB and keeps one `.1` backup.

## Safety

Conditions run through the inherited shell with Pi's permissions. Use side-effect-free, idempotent commands.

- stdout and stderr are discarded;
- each check has a timeout;
- cancellation stops the process group on macOS and Linux;
- secrets do not belong in commands, labels, instructions, or context references;
- installing this extension grants shell access even if Pi's normal shell tool is disabled.

## Architecture

One machine owns each watch:

```text
waiting -> checking -> satisfied
   ^          |
   |          v
   +------ not ready

recurring due -> queued -> running -> waiting
                     |
                     +-> missed ticks coalesce
```

One session queue serializes delivery:

```text
ready -> queued -> message_start -> agent_settled -> ready
```

## Development

```bash
bun install
bun run check
bun test test/until
```

## Contributions

This extension is derived from Joel Hooks' `pi-until`. See [`LICENSE`](./LICENSE).

This version adds Pi 0.86 support, stricter process cleanup and bounds, reload-safe delivery and history restoration, opt-in rotating telemetry, command completions, and expanded tests.
