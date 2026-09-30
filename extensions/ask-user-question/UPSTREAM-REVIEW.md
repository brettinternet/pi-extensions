# Upstream PR review

Reviewed the open PR list and relevant historical PRs in [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono), comparing their proposals with this independent Pi 0.99.1 implementation. PR numbers below refer to that repository. These are idea-level adaptations, not cherry-picks or a promise of rpiv API compatibility.

## Adopted

| PR | Decision |
| --- | --- |
| [#213](https://github.com/juicesharp/rpiv-mono/pull/213) — strict schemas | Reject undeclared properties at the root, question, and option levels. A misplaced question-level `preview` must fail rather than silently disappear. |
| [#224](https://github.com/juicesharp/rpiv-mono/pull/224) — Vim navigation | Add `j`/`k` option navigation; leave these characters untouched inside the editor. Our Submit tab has no picker to navigate. |
| [#172](https://github.com/juicesharp/rpiv-mono/pull/172) — Kitty keys | Use Pi's `matchesKey` for Space and new letter shortcuts, not raw byte comparisons. |
| [#241](https://github.com/juicesharp/rpiv-mono/pull/241) — draft clearing | Honor Pi's `app.clear` binding (normally Ctrl+C) inside the custom editor. Clear the whole multiline draft without cancelling or altering checked choices. |
| [#231](https://github.com/juicesharp/rpiv-mono/pull/231) — compact receipts | Render a short call title and answer receipt. Hide the presentation-only `(Recommended)` suffix on selected labels, but never modify custom text or model-facing results. Expanded, partial, malformed, and error results retain full text. |
| [#211](https://github.com/juicesharp/rpiv-mono/pull/211) — preview scrolling | Already scrollable; improve visibility of the scroll indicator and reset scroll on option navigation. Add bottom-clamping and immediate reverse-scroll regression checks. Retain the simpler whole-content viewport instead of upstream's preview-specific reducer. |

## Already covered or inapplicable

| PR | Assessment |
| --- | --- |
| [#196](https://github.com/juicesharp/rpiv-mono/pull/196), [#198](https://github.com/juicesharp/rpiv-mono/pull/198) — custom multi-select state | Selected labels and custom text already coexist in both TUI and RPC results; saved drafts survive tab navigation and can be withdrawn. We do not implement notes or browsing away from an uncommitted editor. |
| [#228](https://github.com/juicesharp/rpiv-mono/pull/228) — cancellation and resource ownership | Pre-abort and mid-dialog abort already discard answers; RPC checks cancellation after each response. Add a late-RPC-answer regression. We do not own an overlay handle or external-editor process, so do not import old-host overlay guards or subprocess teardown machinery. We only deactivate tools without UI and never automatically reactivate an intentionally excluded tool. |
| [#209](https://github.com/juicesharp/rpiv-mono/pull/209) — circular imports | Our dependency graph is acyclic (`index → dialog → model`, plus `index → model`); no builder/strategy cycle exists. |
| [#110](https://github.com/juicesharp/rpiv-mono/pull/110) — token usage | Already a concise description plus one prompt snippet, without duplicated guidelines. No additional prompt/configuration layer needed. |
| [#267](https://github.com/juicesharp/rpiv-mono/pull/267), [#269](https://github.com/juicesharp/rpiv-mono/pull/269), [#271](https://github.com/juicesharp/rpiv-mono/pull/271) — host-provided TypeBox | Already a peer dependency in the standalone package and a development/peer dependency at the repository root. |
| [#100](https://github.com/juicesharp/rpiv-mono/pull/100) — RPC support | Already implemented with native dialogs, cancellation signals, and final confirmation. |
| [#1](https://github.com/juicesharp/rpiv-mono/pull/1), [#12](https://github.com/juicesharp/rpiv-mono/pull/12), [#146](https://github.com/juicesharp/rpiv-mono/pull/146) — width/resize correctness | Width-aware rendering and scrolling already have narrow/wide/resize coverage. No side-by-side layout or fixed preview height cache to rebalance. |

## Deferred

- [#180](https://github.com/juicesharp/rpiv-mono/pull/180) and [#207](https://github.com/juicesharp/rpiv-mono/pull/207): programmatic answering. Useful for a concrete bridge, but an unrestricted global answer slot or inbound event could substitute automation for a user's decision. A future integration should use request/session identity, explicitly authorized responders, validated all-or-nothing answers, and stale-request rejection. No consumer requires that interface here yet.
- [#239](https://github.com/juicesharp/rpiv-mono/pull/239): automatic answering. Deliberately omitted: asking a person and asking another model are different operations.
- [#39](https://github.com/juicesharp/rpiv-mono/pull/39), [#129](https://github.com/juicesharp/rpiv-mono/pull/129), [#161](https://github.com/juicesharp/rpiv-mono/pull/161), [#165](https://github.com/juicesharp/rpiv-mono/pull/165): prompt/waiting events and terminal/Herdr attention. Worth a separate host-integration change with balanced lifecycle events and child-session scoping; do not pretend to implement rpiv's public event contract. Native RPC dialogs already generate Pi UI lifecycle events.
- [#99](https://github.com/juicesharp/rpiv-mono/pull/99), [#111](https://github.com/juicesharp/rpiv-mono/pull/111), [#131](https://github.com/juicesharp/rpiv-mono/pull/131), [#132](https://github.com/juicesharp/rpiv-mono/pull/132), [#139](https://github.com/juicesharp/rpiv-mono/pull/139), [#153](https://github.com/juicesharp/rpiv-mono/pull/153): notes, external editor, collapse controls, and overlay placement. Keep out until requested; they add lifecycle and state that this simpler non-overlay questionnaire does not need.
