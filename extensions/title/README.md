# pi-title

Title each session automatically from its first request. Titles persist, and manual titles are never replaced.

```sh
pi install npm:pi-title
```

```text
/title                          show title and config
/title My custom title          set a title
/title set status               set a title that matches a subcommand
/title regenerate               generate a new title
/title on                       enable automatic titles
/title off                      disable automatic titles
/title model openai/gpt-5-nano  use a specific model
/title model auto               use a lightweight model
/title model active             use the session's model
```

## Configuration

```jsonc
// ~/.pi/agent/pi-title.jsonc
{
  "enabled": true,
  "model": null,       // null = session model, "auto", or "provider/model[:effort]"
  "maxTokens": 30,
  "maxLength": 60
}
```
