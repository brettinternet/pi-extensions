# pi-progress

```text
progress 25m · current: Updating the implementation inferred · ● edit src/index.ts · ✓ bun test
 touched src/index.ts · test/index.test.ts
```

```bash
pi install npm:@brettinternet/pi-progress
```

It shows observed tools, checks, successful edit-write paths, and work time. These signals describe activity, not semantic proof that the result is correct.

Optional configuration:

```jsonc
// ~/.pi/agent/pi-progress.jsonc
{
  "model": "provider/model",
  "maxInputChars": 12000,
  "maxTokens": 180,
  "timeoutMs": 15000
}
```

The bounded, redacted advisory digest excludes reasoning, tool output, file contents, diffs, environment data, credentials, and the full transcript.

```text
/progress steps
/progress steps recent
/progress steps all
/progress status
/progress model
/progress model <provider/model[:effort]>
/progress model off
```

```text
Alt+G          recent toggle
Alt+Shift+G    full history
```
