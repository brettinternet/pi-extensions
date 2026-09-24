# pi-until

Watch shell conditions and schedule recurring follow-ups without blocking Pi. A condition succeeds when it exits `0`. Checks run in the background without model turns.

```sh
pi install npm:pi-until
```

Use a watch when a condition may become true before its timeout. For a fixed delay, use `/wait` from `pi-wait` instead of polling the clock.

## Watch a condition

```ts
until({
  action: "start",
  condition: "test -f .deploy-finished",
  label: "deployment",
  intervalSeconds: 30,
  wake: "agent", // or "notify" to report without waking the agent
});
```

## Repeat a follow-up

```ts
until({
  action: "repeat",
  instruction: "Review deployment logs and fix failures.",
  quickRef: "Deploy check",
  intervalSeconds: 3600,
  timeoutSeconds: 86400,
});
```

Finishing a turn doesn't complete recurring work. End it explicitly:

```ts
until({ action: "complete", id: "8f2c1a7d" });
until({ action: "cancel", id: "8f2c1a7d" });
```

## Commands

```text
/until start test -f .deploy-finished
/until list
/until status <id>
/until complete <id>
/until cancel <id>
/until stats
```

## Lifecycle

| Event | Result |
| --- | --- |
| Agent turn ends | Watches continue |
| `/reload` | Watches, delivery state, and receipts restore |
| `/new`, `/resume`, `/fork` | Watches stop |
| Pi exits or the machine reboots | Watches stop |
| Print or JSON mode | New watches are rejected |

Use a durable scheduler for work that must outlive Pi.

## Safety

Checks run through the shell with Pi's permissions, so installing this grants shell access even when Pi's shell tool is disabled. Use idempotent, side-effect-free commands. Output is discarded, checks time out, and cancellation kills the process group on macOS and Linux. Keep secrets out of conditions, labels, instructions, and context references.

## Telemetry

Off by default:

```sh
PI_UNTIL_TELEMETRY=1 PI_UNTIL_TELEMETRY_FILE=/path/events.jsonl pi
```

Logs record watch metadata and 12-character condition hashes, never command text or instructions. They rotate at 5 MiB with one backup.

## Development

```sh
bun install
bun run check
bun test test/until
```

Derived from Joel Hooks' `pi-until`. See [`LICENSE`](./LICENSE).
