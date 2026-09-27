<!-- i18n: language-switcher -->
[English](PLAN.md) | [日本語](PLAN.ja.md)

# Plan

## Current Architecture

The desktop Chrome extension under `extension/` is JavaScript-only. The mobile
PWA under `web/` uses TypeScript modules plus copied classic browser scripts,
and the CORS relay under `worker/` is a TypeScript Cloudflare Worker. Scorer
time is not the bottleneck; browser rendering, chat extraction, and relay
resilience are.

## Current Split

- Claude: `extension/`
- Codex: CI/tooling, `web/`, `worker/`, and shared release automation when a
  change needs end-to-end validation
- Shared: `docs/`, release scripts, package scripts, interface contracts
- Local notes: `.private-discussion/`

## Current Scoring Path

`extension/scoring.js` provides:

- `SYCScoring.createFallbackScorer()`
- `SYCScoring.buildRenderPlan(text, result)`
- speed tiers: fast / normal / slow

The scorer runs locally in the content script and performs no network calls.

## Contract Migration Notes

- Relay input now accepts YouTube continuation tokens containing percent escapes
  by decoding one additional layer before validation and cache lookup. The poll
  envelope and client encoding stay the same; no client migration is required.
- `paidColor` is an optional display-only `ChatMessage` / render payload field
  for Super Chat tier color. Older messages without it remain valid; `amount`
  remains nullable as before.
- Replay continuation polls now use `replay=1` alongside `cont` and `offset`.
  Ambiguous `cont + offset` requests without `replay=1` receive a 400 response.
  Replay `ended` remains device/player-owned, not relay-owned.

## Performance Work

Status as of the current implementation:

| Item | Status | Notes |
| --- | --- | --- |
| Dev frame/long-task diagnostics | Done | `danmaku.js` exposes frame p50/p95/p99, FPS, active count, cache size, and long-task counters through `stats()`. |
| Renderer queue/ring-buffer hotspots | Done | Pending comments use `pendingHead` compaction instead of `Array.shift()`, and spawn work is budgeted per frame. |
| Configurable maxActive with interactivity guard | Done | `maxActive`, `maxQueue`, and `spawnPerFrame` are settings-backed; spawn budget falls under high frame EMA. |
| Chat observation after player replacement | Partial | Lifecycle and chat-client tests cover reconnection behavior, but real YouTube DOM replacement remains a manual smoke item. |
| Official guide/warning filtering | Done | Extension extraction tests cover official-message filtering and sanitized render payloads. |
| Real device tuning | Checklist ready | `docs/DEVICE_TUNING.md` defines iOS/Android smoke steps, HUD metrics, and tuning thresholds. |
| Heavy renderer optimizations | Gated | OffscreenCanvas/worker rasterization requires the `docs/DEVICE_TUNING.md` performance gate to fail on real devices first. |

The next performance work should focus on the browser path:

1. Add dev-only long-task and frame p95/p99 diagnostics.
2. Fix queue/ring-buffer hotspots in renderer admission.
3. Keep `maxActive` configurable up to 2000 while protecting video interactivity.
4. Keep YouTube chat observation attached after iframe or `#items` replacement.
5. Keep official YouTube guide/warning/recommendation messages out of danmaku.

Use these commands:

- `npm run security`
- `npm test`
- `npm run coverage`
- `npm run test:e2e` for renderer performance
- `npm run test:ext` for real Chromium extension smoke testing
- `SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube`
  for opt-in real YouTube smoke testing

## Scorer Transport Gate

Do not add a new scorer transport unless all are true:

1. A batch or stateful scorer exists outside the extension hot path first.
2. Chrome/V8 benchmarks show a clear end-to-end win over the JS scorer.
3. `docs/CONTRACT.md` is updated before the extension depends on the new shape.
4. Manifest CSP and web-accessible resources are reviewed again.

## Release Automation

Chrome Web Store update publishing is automated through:

- `scripts/chrome-webstore.mjs`
- `npm run release:store`
- `.github/workflows/chrome-webstore-release.yml`

The one-time Chrome Web Store Developer Dashboard setup is done. The item is
published as `nkphcfhnfjceplpgcjccnpfdkheafohp`, and a matching `vX.Y.Z` tag
runs checks, builds the zip, uploads it, and submits it for review/publishing.

The remaining manual work per release is Chrome Web Store review itself, so the
published version can trail `main`. Keep the publisher credentials for the
release workflow valid; `docs/RELEASE.md` has the checklist for `403` upload
failures.

## Upstream Feature Adoption

Reference: `ys-j/YoutubeLiveChatFlusher` (independent implementation; no code is
copied, only feature ideas). Work is split into phases so each one is
independently testable and releasable.

Phase 1 — settings/renderer polish (done in v0.2.5):

- Per-type visibility gates (`showNormal`, `showMember`, `showModerator`,
  `showOwner`, `showPaid`, `showMembership`), enforced in `DanmakuOverlay.push`.
- Per-type font multipliers (`scaleMember`, `scaleModerator`, `scaleOwner`,
  `scalePaid`) and a `sizeByScore` toggle.
- `authorName` mode (`never` / `nontext` / `always`).
- Outline `outlineColor` and `outlineBlur` (part of the raster cache key).
- `lineHeightScale` replaces the absolute `lineHeight` px setting; the engine
  still receives `lineHeight` px, derived as `fontPx * scale`.
- NG words gain `mode` (`drop` / `censor` / `replace`) and `replacement` in the
  local filter store; `SYCFilter.apply()` returns `{ drop, text }` and
  `content.js` / `web/app.ts` mask instead of dropping when configured.
- `open-options` command (`Alt+Shift+O`) alongside `toggle-overlay`.

Phase 2 — rendering expression:

- Done: `flowDirection` (`rtl` / `ltr`) and `density` (`top` / `bottom` /
  `random`) in the engine spawn/lane logic.
- Done: `maxWidthPct` clamps a comment to a fraction of the stage, trimming with
  an ellipsis (pixel-measured, not char-counted).
- Done: `layerCss` injects user CSS into the overlay layer (`<style>` with
  `textContent`, 4000-char cap).
- Done: `wrapText` wraps overflowing comments into up to 3 lines instead of
  trimming them; `maxWidthPct` still applies.
- Done: custom emoji images in the extension. `content.js` extracts text runs
  and emoji `<img>` elements from the live-chat DOM, `sanitize.js` validates the
  URLs (`sanitizeMessageParts`), and the renderer draws emoji parts like the
  PWA does. `extension/emoji.js` loads the images.
- Remaining: PiP.

Phase 3 — interaction:

- Done: `timeshiftMs` (web only) shifts the chat replay gate so archive comments
  can be shown earlier or later; the extension has no reliable per-message
  timestamps, so it is PWA-only.
- Done: right-click a comment to pin it in place (it stops moving and will not
  expire or be evicted), then drag it with the left button; the same toggle
  releases it. Gated by the `pinComments` setting and bound in the capture
  phase so YouTube's own player handlers do not fire when a comment is hit.
  Note: this works in the extension (content script on the watch page). In the
  PWA the YouTube iframe owns pointer events, so pin/drag needs a dedicated
  capture layer before it can work there.
- Done: on-device translation via the browser's built-in Translator /
  LanguageDetector APIs (Chrome, experimental). `extension/translate.js` (shared
  verbatim with `web/`) caches results, detects the source language, and returns
  the original text when the API or a language pack is unavailable. Nothing
  leaves the device, so the privacy stance is unchanged. Enabled by the
  `translateTo` setting (default off).
- Remaining: PiP.

Migration note: `lineHeight` px settings are no longer read; stored values
normalize to the new `lineHeightScale` default. The filter store gains `mode`
and `replacement`; older records without them normalize to `drop` and the
default replacement, so no migration step is required.

## Worker Roadmap

`docs/WORKER_ROADMAP.md` tracks the WebSocket + Durable Object single-flight
candidate. It remains gated on HTTP relay metrics proving cache/in-flight
collapse insufficient.
