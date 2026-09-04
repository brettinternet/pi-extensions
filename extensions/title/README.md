# pi-title

Automatic session titles for the [Pi coding agent](https://pi.dev).

A concise title is generated from the first request as soon as the agent starts, concurrently with the main agent work. It is persisted as the Pi session name and used as the terminal title. Existing and manually named sessions are left unchanged.

## Install

```sh
pi install npm:pi-title
```

## Configure

Global configuration lives at `~/.pi/agent/pi-title.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "enabled": true,
  "model": null,
  "maxTokens": 30,
  "maxLength": 60
}
```

By default, an omitted or `null` model uses the active session model. Set `"model": "auto"` to use an available lightweight model, or set an explicit `provider/model[:effort]` reference.

Commands:

```text
/title                                   Show the current title, status, and config path
/title My custom title                   Set a custom title
/title set status                        Set a custom title that matches a subcommand
/title on                                Enable automatic titles
/title off                               Disable automatic titles
/title model openai/gpt-5-nano           Select a dedicated title model
/title model auto                        Use the lightweight-model fallback
/title model active                      Use the active session model
/title regenerate                        Replace the current title automatically
```
