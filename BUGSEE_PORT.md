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
| P3a | Privacy | **maskAllText + selective text unmask**: `needMaskingText` rewritten to per-node nearest-ancestor-wins (a nearer `unmask` ancestor overrides `mask`); `maskAllText`/`unmaskTextClass`/`unmaskTextSelector` threaded through snapshot + record + mutation (replacing the inherited `needsMask` skip). | **DONE** — 7 tests + mutator |
| P3b | Privacy | **Selective unblock/unmask-input**: `unblockSelector` (un-block specific media) + `unmaskInputSelector` (un-mask specific inputs). | **DONE** — threaded through the block/input paths |
| P3c | Privacy | **One input-value resolution for every recording path**: `resolveInputValue` (rrweb-snapshot) is used by the full snapshot, the live input observer and the mutation observer's `value`-attribute and `<textarea>` paths. `unmaskInputSelector` previously reached the snapshot only, so a value typed (or set) while recording stayed masked on an un-masked input; and in the snapshot it bypassed the sensitive-input hard floor, so an unmask mark on a password or card field would have exposed it. A sensitive input is now masked first on every path, and a selector that throws fails closed. | **DONE** — 10 snapshot/utils tests + 6 record (jsdom `record()`) tests, 8-mutation loop, input/masking integration tests green |
| R1 | Robustness | "A recorder bug never breaks the host page." | **Already in upstream 2.1.0 — no port needed.** Verified present: `customElements.define` callback try/catch (record/observer.ts), cross-origin iframe try/catch (rrweb-snapshot/utils.ts), CSP-safe inline-style parsing via `createHTMLDocument()` w/ fallback (record/mutation.ts), blocked-element `rr_width`/`rr_height` dims (snapshot.ts), `ignoreCSSAttributes` for style mutations. **Residual (optional, deferred):** `ignoreCSSAttributes` is not applied to the INITIAL snapshot's inline styles (only mutations) — a consistency nicety for an option Bugsee does not currently configure. |
| S1 | Perf/size | Trim the record path. | **Primary win achieved.** The consumed artifact is a **record-only** bundle (the replay player is tree-shaken out): 565 KB → **~56 KB gzip**, comfortably under the 90 KB add-on budget. Canvas + cross-origin-iframe recording are already runtime-opt-out by default (`recordCanvas`/`recordCrossOriginIframes` = false). Deeper compile-time DCE of canvas/iframe/shadow-dom code would need invasive build-flag guards through rrweb for a ~10–15 KB gain that isn't needed (already ~38% under budget) — deferred. |

## Already present in upstream 2.1.0 — no change needed
- `getInputType` + `data-rr-is-password` (password-type-change protection).
- `needMaskingText` + `classMatchesRegex` (class/selector text masking).
- `recordCrossOriginIframes` + cross-origin iframe handling.
