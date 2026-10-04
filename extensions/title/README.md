# pi-title

Title each session automatically from its first request, with optional refreshes as the conversation develops. Manual titles are never replaced automatically.

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
  "maxLength": 60,
  "refreshTurns": 0    // completed turns between refreshes; 0 (default) titles once and stops
}
```

## Refreshing titles

Set `refreshTurns` in the config file; `/title status` shows its value. `0` (the default)
titles once. With `4`, refreshes normally run after the fifth completed exchange, then every
fourth exchange. With `1`, they run after each completed exchange following the opening one.
Only user messages answered with assistant text count, and refreshes are evaluated at `agent_settled`.

Refreshes use recent user/assistant text, capped at 8 messages, 600 characters per message,
and 4,000 characters total. Tool output is excluded. Each evaluation uses one config snapshot.

A busy title request postpones refreshing until a later settled turn; a failed refresh spends
its cadence slot. Tree navigation cancels pending generation and rebases the cadence on the
active branch, generating an initial title if the session is still unnamed.

Sessions that arrive named—including resumed sessions—and manually renamed sessions are left
alone. A rename during generation wins. `/title regenerate` explicitly replaces a title even
when automatic titles are disabled, but does not reset the cadence or unpin a manually named session.

## Model fallback

The configured model is tried first. If it is unavailable, fails, or returns no usable
title, the active session model is tried next. Each distinct model is attempted once;
the extension does not retry. Cancellation stops the chain.

Fallback is automatic, including for explicitly configured models. **The session
model may cost more than the configured title model.** Both calls use the title
token budget. Using `/title model active` uses only the session model.

When fallback succeeds, the UI warning names the failed model and the model used.
If neither model works, the error includes both failures.
