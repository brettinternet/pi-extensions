# pi-title

Title each session from its first request, and optionally refresh it as the conversation develops. Manual titles are never replaced automatically.

```sh
pi install npm:pi-title
```

```text
/title                          show title and config
/title My custom title          set a title
/title set status               set a title that matches a subcommand
/title regenerate               retitle from recent messages
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
  "maxLength": 60,
  "refreshTurns": 0    // retitle every N answered turns; 0 = title once
}
```

## Refreshing titles

```text
"refreshTurns": 4

turn 1  → initial title from the first request
turn 5  → refreshed from recent messages
turn 9  → refreshed again
```

Refreshes read the last 8 user and assistant messages (up to 4,000 characters, no tool output).
Naming the session yourself stops them.

## Model fallback

The configured model is tried first. If it is unavailable, fails, or returns no usable
title, the active session model is tried next. Each distinct model is attempted once;
the extension does not retry. Cancellation stops the chain.

Fallback is automatic, including for explicitly configured models. **The session
model may cost more than the configured title model.** Both calls use the title
token budget. Using `/title model active` uses only the session model.

When fallback succeeds, the UI warning names the failed model and the model used.
If neither model works, the error includes both failures.
