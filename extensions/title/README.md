# pi-title

Give the session a useful title automatically.

```bash
pi install npm:pi-title
```

The first request generates a persisted title. Manual titles are respected.

Optional configuration:

```jsonc
// ~/.pi/agent/pi-title.jsonc
{
  "enabled": true,
  "model": null,
  "maxTokens": 30,
  "maxLength": 60
}
```

`null` uses the active session model. `auto` uses a lightweight model. An explicit `provider/model[:effort]` can be selected.

```text
/title
/title My custom title
/title set status
/title on
/title off
/title model openai/gpt-5-nano
/title model auto
/title model active
/title regenerate
```
