# Performance Notes

The project is now JavaScript-only. The previous Rust/WASM scorer was removed
because the one-message scorer path did not improve the shipped extension, and
browser extraction/rendering is the practical ceiling.

Historical measurements and the removal rationale are in
[`PERFORMANCE_RESEARCH_2026-06-17.md`](./PERFORMANCE_RESEARCH_2026-06-17.md).

## Current Bottleneck

Measure these separately:

- YouTube chat extraction and filtering
- MutationObserver attachment/re-attachment
- pending queue admission
- text rasterization
- canvas draw loop
- active comment count
- dropped comments
- frame p50/p95/p99
- Long Task count

Scoring should stay local and cheap inside `extension/scoring.js`.

## Browser Budget

Initial practical targets:

- renderer: keep controls responsive at `maxActive=2000`
- frame budget: avoid repeated main-thread tasks over 50 ms
- queue budget: avoid unbounded pending growth
- extraction: continue flowing after YouTube replaces chat iframe or `#items`
- security: no remote fetches, no HTML injection sinks

## Browser Rendering Probe

Run the rendering probe:

```sh
npm run test:e2e
```

Or open manually in Chrome:

```text
bench/danmaku-bench.html
```

The probe compares DOM + CSS animation, DOM + JavaScript transform updates, and
canvas redraw. Use fullscreen/manual Chrome testing for final GPU behavior.

## Local Sandbox

Run:

```sh
npm run sandbox
```

Then open:

```text
http://127.0.0.1:4173/
```

The sandbox uses `extension/scoring.js` directly. It no longer loads WASM.

## Known Hot Spots

- `Array.prototype.shift()` on hot queues can move array contents; prefer a head
  index or ring buffer.
- Text rasterization is more expensive than scoring. Keep rasterization budgeted
  and cached.
- High DPR multiplies bitmap memory and draw/clear work.
- Glow/shadow should degrade under load.
- Lane assignment is currently cheap because lane count is small. If lane count
  grows substantially, use a priority queue over lane free times.

## WASM Reintroduction Gate

Do not reintroduce Rust/WASM for the current heuristic scorer. Reconsider only if
a batched or stateful scorer first proves a clear Chrome/V8 end-to-end win and
the contract/docs are updated before shipping.
