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

## Performance Work

Status as of the current implementation:

| Item | Status | Notes |
| --- | --- | --- |
| Dev frame/long-task diagnostics | Done | `danmaku.js` exposes frame p50/p95/p99, FPS, active count, cache size, and long-task counters through `stats()`. |
| Renderer queue/ring-buffer hotspots | Done | Pending comments use `pendingHead` compaction instead of `Array.shift()`, and spawn work is budgeted per frame. |
| Configurable maxActive with interactivity guard | Done | `maxActive`, `maxQueue`, and `spawnPerFrame` are settings-backed; spawn budget falls under high frame EMA. |
| Chat observation after player replacement | Partial | Lifecycle and chat-client tests cover reconnection behavior, but real YouTube DOM replacement remains a manual smoke item. |
| Official guide/warning filtering | Done | Extension extraction tests cover official-message filtering and sanitized render payloads. |

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

The remaining manual work is the one-time Chrome Web Store Developer Dashboard
setup: item creation, store listing copy/assets, privacy/data-use declarations,
service-account or OAuth credential setup, and GitHub secret entry. After that,
a matching `vX.Y.Z` tag can run checks, build the zip, upload it, and submit it
for review/publishing.
