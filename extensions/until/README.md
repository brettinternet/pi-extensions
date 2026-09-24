# pi-until

Use a watch when a real condition may become true before its timeout. For a fixed delay, use a timer rather than polling the clock with a shell condition.

Watch shell conditions and schedule recurring follow-ups without blocking Pi. Exit code `0` indicates success. Background checks run without model turns.

```bash
pi install npm:pi-until
```

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

Set `wake` to `"notify"` to report success without waking the agent.

## Schedule recurring follow-ups

```ts
until({
  action: "repeat",
  instruction: "Review deployment logs and fix failures.",
  quickRef: "Deploy check",
  intervalSeconds: 3600,
  timeoutSeconds: 86400,
});
```

A finished turn does not complete recurring work. Complete or cancel it explicitly:

```ts
until({ action: "complete", id: "8f2c1a7d" });
until({ action: "cancel", id: "8f2c1a7d" });
```

## Commands

```text
/until start <side-effect-free shell condition>
/until list
/until status <id>
/until complete <id>
/until cancel <id>
/until stats
```

## Lifecycle

| Event | Result |
| --- | --- |
| Agent turn ends | Watch continues |
| `/reload` | Watches, delivery state, and receipts restore |
| `/new`, `/resume`, `/fork` | Watches stop |
| Pi exits or reboots | Watches stop |
| Print or JSON mode | New watches are rejected |

Use a durable scheduler when work must survive the owning Pi process.

## Safety

Checks run through the shell with Pi permissions. Use idempotent, side-effect-free commands. Output is discarded, checks time out, and cancellation stops the process group on macOS and Linux. Do not put secrets in conditions, labels, instructions, or context references.

Installing this extension grants shell access even when Pi's normal shell tool is disabled.

## Telemetry

Telemetry is off by default.

```bash
PI_UNTIL_TELEMETRY=1 PI_UNTIL_TELEMETRY_FILE=/path/events.jsonl pi
```

Logs contain watch metadata and 12-character condition hashes, never command text or recurring instructions. They rotate at 5 MiB with one backup.

## Development

```bash
bun install
bun run check
bun test test/until
```

Derived from Joel Hooks' `pi-until`. See [`LICENSE`](./LICENSE).
