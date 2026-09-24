# pi-progress

Show what the agent is doing below the editor.

```text
progress 25m · agents 42m · current: Updating the implementation inferred · ● edit src/index.ts · ✓ bun test
 touched src/index.ts · test/index.test.ts
```

```sh
pi install npm:@brettinternet/pi-progress
```

| Segment | Meaning |
| --- | --- |
| `progress 25m` | Work time |
| `agents 42m` | Summed subagent runtime; hidden until a subagent reports |
| `current: … inferred` | Model-inferred step; off until you set a model |
| `● edit src/index.ts` | Running tool |
| `✓ bun test` | Finished check |
| `touched …` | Files edited or written successfully |

These show activity, not proof the result is correct. Inferred claims that something was "verified" are dropped without discarding other progress labels.

## Commands

```text
/progress status                        show inference state
/progress steps                         toggle recent history   (Alt+G)
/progress steps recent                  show the last eight steps
/progress steps all                     show full history       (Alt+Shift+G)
/progress model                         show the inference model
/progress model openai/gpt-5-nano:low   enable inference
/progress model off                     disable inference
```

## Configuration

```jsonc
// ~/.pi/agent/pi-progress.jsonc
{
  "model": null,           // "provider/model[:effort]" enables inference
  "maxInputChars": 12000,
  "maxTokens": 180,
  "timeoutMs": 15000
}
```

The inference model gets a bounded, redacted digest. It never sees reasoning, tool output, file contents, diffs, environment data, credentials, or the full transcript.
