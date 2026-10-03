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
