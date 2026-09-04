# Progress inference layer

## Status

Proposed follow-up to the deterministic `pi-progress` observer. The deterministic layer remains complete and useful without this feature.

## Goal

Add optional semantic labels such as the current phase and recently completed outcomes without changing the main agent's behavior. A separately configured inexpensive model would summarize a bounded activity digest after substantive turns.

The inference layer is advisory UI metadata. It must never become execution state, verification evidence, or prompt context for the main agent.

## Activation

Inference is disabled unless the user configures an explicit model in `~/.pi/agent/pi-progress.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "model": "openai/gpt-5-nano",
  "maxInputChars": 12000,
  "maxTokens": 180,
  "timeoutMs": 15000
}
```

There should be no `auto` mode and no fallback to the active session model. Missing, unavailable, or unauthenticated models leave deterministic progress running normally and produce at most one bounded warning per session.

An explicit model may use a `:off` or `:minimal` thinking suffix if supported. Reasoning should default to off because this is classification and summarization, not planning.

## Input boundary

Send the minimum information needed to interpret observed activity:

- the current user request, truncated;
- the previous accepted inference snapshot;
- tool name, compact arguments, outcome, and duration for the completed turn;
- successful edit/write target paths;
- recognized check commands and Pi's success/error result;
- bounded subagent lifecycle summaries when available;
- a truncated final assistant text excerpt;
- optional Git diffstat gathered without file contents.

Do not send system prompts, reasoning blocks, full tool output, file contents, diffs, environment variables, credentials, or the full session transcript. Redact common credential shapes before dispatch and document that paths, commands, and user-request excerpts are still disclosed to the configured provider.

Use a fresh request session ID and disable prompt-cache retention, following the existing `pi-title` completion pattern.

## Output contract

Require one small structured object:

```json
{
  "phase": "Verification",
  "current": "Checking profile configuration",
  "completed": ["Configured FleetView"],
  "blocked": [],
  "confidence": 0.91
}
```

Constraints:

- `phase` and `current`: short display labels, not instructions;
- `completed`: at most three outcome labels grounded in supplied events;
- `blocked`: only blockers explicitly present in supplied activity;
- `confidence`: number from 0 to 1;
- unknown fields rejected;
- strings length-bounded and normalized to one line.

Invalid, empty, low-confidence, timed-out, or aborted responses are discarded without changing deterministic state.

The model cannot emit `verified`. Verification remains exclusively derived from observed check results.

## Scheduling and lifecycle

1. Accumulate a bounded per-run activity digest in the deterministic reducer.
2. At `agent_settled`, skip inference when no meaningful mutation, check, delegation, or user-visible outcome occurred.
3. Start inference asynchronously; never await it from the Pi lifecycle hook.
4. Allow one request in flight. If newer activity settles, abort the old request and evaluate only the newest coalesced digest.
5. Tag each request with the current session generation. Discard responses after session switch, tree navigation, reload, shutdown, or a newer accepted result.
6. Preserve the last accepted inference snapshot in a custom session entry that is not included in model context. Restore only entries belonging to the active branch.
7. Clear stale semantic labels when a new user request starts; deterministic observed state continues updating immediately while inference catches up.

Failures must not retry automatically. A later substantive turn may make a fresh attempt.

## UI

Keep the existing two-line budget. Deterministic facts have visual priority:

```text
progress · Verification inferred · ● edit src/index.ts · ✓ bun test
 touched src/index.ts · test/index.test.ts
```

Rules:

- label semantic text as `inferred` or render it with a distinct dim style;
- never replace observed active-tool or check information;
- omit inferred text first when terminal width is constrained;
- show no spinner for background inference;
- expose configuration and the last inference error through `/progress status`, not persistent UI;
- do not duplicate `pi-subagents` FleetView.

## Implementation shape

Extend `extensions/progress/` with:

- `config.ts` — strict config loading and explicit model resolution;
- `digest.ts` — bounded activity collection, redaction, and meaningful-change detection;
- `inference.ts` — request construction, provider call, schema validation, and normalization;
- additions to `state.ts` for advisory semantic state and request generations;
- additions to `index.ts` for asynchronous scheduling and lifecycle cancellation.

Reuse the model-resolution and background-request patterns from `extensions/title/`, but keep progress-specific configuration and state independent.

## Tests

Add deterministic tests for:

- absent model disables all provider calls;
- exact explicit model resolution and authentication failure;
- input truncation, redaction, and exclusion of tool/file contents;
- structured output bounds and rejection paths;
- meaningful-turn filtering;
- single-flight coalescing and stale-result rejection;
- cancellation on shutdown, reload, session switch, and tree navigation;
- inference failure leaving deterministic UI unchanged;
- narrow rendering dropping inferred labels before observed facts;
- no `context` hook, prompt mutation, or LLM-callable tool registration.

Run the full repository typecheck and test suite before enabling the feature by default for any configured model.

## Non-goals

- planning work for the main agent;
- estimating percentage complete or remaining time;
- deciding whether the user's overall request is complete;
- changing todo/task state;
- controlling, steering, or automatically continuing agents;
- replacing test, review, or acceptance evidence;
- sending the full conversation to another model.
