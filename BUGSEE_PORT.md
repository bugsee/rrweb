# Bugsee rrweb — hardening changelog

This fork = upstream `rrweb-io/rrweb` **v2.1.0** + a curated set of Bugsee hardening patches for use by the
Bugsee JavaScript SDK via the `@bugsee/rrweb` wrapper. Upstream's MIT `LICENSE` is retained unchanged.

Patches focus on three themes, each landed as a single large commit:
1. **Privacy** — never leak user content into a recording, fail-closed.
2. **Robustness** — a recorder bug must never break the host page.
3. **Perf/size** — trim the record path (canvas/iframe/shadow-dom recording opt-in, dead-code elimination).

Work branch: `bugsee-port`. Each change is test-first with a per-entity mutator loop; tests live in each
package's own vitest suite. (Playwright record-integration snapshots are re-verified in browser CI.)

## Changes

| # | Theme | Change | Status |
|---|---|---|---|
| P1 | Privacy | **Sensitive-input hard-floor**: `type=password` is always masked even when global input-masking is off; an input whose `autocomplete` marks it as credit-card / password / one-time-code is always masked; `<option>` masks per its `<select>`; an untyped `<input>` defaults to the `text` option. (`shouldMaskInput` in `rrweb-snapshot/utils.ts`.) | **DONE** — 15 tests + mutator |
| P2 | Privacy | **Attribute-value masking**: a `maskAttributeFn` hook on `transformAttribute` (threaded through snapshot + record + mutation re-mask) lets a caller redact attribute values (`placeholder`/`title`/`aria-label`/`value`) that previously leaked. | **DONE** — 5 tests + mutator |
| P3 | Privacy | **Selective unmask/unblock**: `maskAllText` + `unmaskTextClass`/`unmaskTextSelector` + nearest-ancestor-wins resolution + `unblockSelector`/`unmaskInputSelector` (enables per-element opt-out). | DEFERRED — requires re-architecting the text-mask hot path to a per-node model (upstream threads `needsMask` down + skips children once masked; a nearer unmask ancestor can't win under that model). Own designed+reviewed slice; not a fail-closed gap. |
| R1 | Robustness | Swallow `customElements.define` exceptions; guard non-element `setAttribute`; blocked-image dimension fix; `ignoreCSSAttributes`. | TODO |
| S1 | Perf/size | Build flags to disable iframe/canvas/shadow-dom recording + DCE hooks/plugins; canvas recording off by default. | TODO |

## Already present in upstream 2.1.0 — no change needed
- `getInputType` + `data-rr-is-password` (password-type-change protection).
- `needMaskingText` + `classMatchesRegex` (class/selector text masking).
- `recordCrossOriginIframes` + cross-origin iframe handling.
