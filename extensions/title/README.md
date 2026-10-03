# pi-title

Title each session automatically from its first request. Titles persist, and manual titles are never replaced. Refreshing the title as the work develops is off until you ask for it.

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

A session is titled from its first request. Refreshing is off by default, so that stays the only
title the session gets — the behaviour of every earlier version. Set `refreshTurns` to the number of
completed turns between refreshes and the title is then regenerated from a transcript of the most
recent messages instead of the original request, so a session that moved on from its opening
question ends up named for what it became. `1` refreshes after every completed turn; `4` refreshes
on the fifth turn, then every fourth turn after that.

One rule governs refreshing: a title the extension did not write is never replaced. That covers a
session that arrives already named (started with `--name`, named before the extension loaded, or
titled in an earlier session and resumed), and any title you set while the session runs. `/title
regenerate` still replaces a title on request.

Set `refreshTurns` to `0` (the default) to title a session once and leave it alone.

Refreshing is evaluated when a turn settles, and a turn counts once it has produced assistant
text, so a turn spent entirely on tool calls does not advance the cadence. Navigating the session
tree rebases the cadence on the branch you are on, and titles a still-unnamed session from that
branch. A refresh also waits for any title request already in flight, so a busy slot can push the
next refresh past the nominal cadence. `/title regenerate` replaces the title on request, including
one you set yourself, without resetting the cadence — and without handing automatic refreshing back:
a session you named stays yours, so the regenerated title persists until you ask for another one.

## Model fallback

The configured `model` is tried first, then the active session model. A configured model that
cannot be resolved is skipped instead of aborting the attempt.

The failure decides how fast the chain moves on:

- Deterministic failures — `401`/`403` auth, `402`/quota/billing, `404`/unknown model, and
  `400`/`422` invalid requests — try the next model immediately, because a second attempt on
  the same model cannot succeed.
- Transient failures — rate limits, transport errors, premature stream endings, and `5xx`
  responses — move to the next model, and a transient failure on the last available model is
  retried once with backoff before giving up. Pi's provider retry helper defaults its retry
  budget to `0` and this call path does not raise it, so the extension performs that retry
  itself.
- A failure that reports quota or billing exhaustion is deterministic even when it arrives as
  `429`, so it moves on immediately instead of being retried as a throttle.
- A status reported by the provider decides before the wording, whether it is a structured field
  or stated in the message text as a leading code, an `HTTP`/`status`/`code` prefix, or a
  parenthesised code. Wording is only consulted when no status is presented, so an explicit `400`
  is not retried merely because the message also says "provider returned error", and a URL value
  is not mistaken for a status.
- An aborted request never falls back.

When the fallback writes the title, Pi reports which configured model failed and which model was
used instead.
