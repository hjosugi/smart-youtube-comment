# Plan

## 2026-06-17

The Rust/WASM scorer has been removed from the active architecture. The
extension is JavaScript-only because the previous one-message WASM path did not
improve runtime performance, and scorer time is not the bottleneck.

## Current Split

- Claude: `extension/`
- Shared: `docs/`, release scripts, package scripts
- Local notes: `.private-discussion/`

There is no active `scorer/` crate.

## Current Scoring Path

`extension/scoring.js` provides:

- `SYCScoring.createFallbackScorer()`
- `SYCScoring.buildRenderPlan(text, result)`
- speed tiers: fast / normal / slow

The scorer runs locally in the content script and performs no network calls.

## Performance Work

The next performance work should focus on the browser path:

1. Add dev-only long-task and frame p95/p99 diagnostics.
2. Fix queue/ring-buffer hotspots in renderer admission.
3. Keep `maxActive` configurable up to 2000 while protecting video interactivity.
4. Keep YouTube chat observation attached after iframe or `#items` replacement.
5. Keep official YouTube guide/warning/recommendation messages out of danmaku.

Use these commands:

- `npm run security`
- `npm run test:sandbox`
- `npm run test:e2e` for renderer performance
- `npm run test:ext` for real Chromium extension smoke testing

## WASM Reintroduction Gate

Do not reintroduce Rust/WASM unless all are true:

1. A batch or stateful scorer exists outside the extension hot path first.
2. Chrome/V8 benchmarks show a clear end-to-end win over JS.
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
