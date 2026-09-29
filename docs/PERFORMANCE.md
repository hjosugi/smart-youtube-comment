<!-- i18n: language-switcher -->
[English](PERFORMANCE.md) | [日本語](PERFORMANCE.ja.md)

# Performance Notes

The project is JavaScript-only. Scoring is cheap; browser extraction and
rendering are the practical ceiling.

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

The sandbox uses `extension/scoring.js` directly.

## Sprite Atlas (the periodic "jolt", root cause and fix)

The "moves smoothly, then jolts every 1–3 s" symptom was a garbage-collection
storm, not frame pacing. Every comment used to be rasterized into its own
`<canvas>`; each canvas backing store counts toward V8's *external* memory, so
at chat rates (100+ new comments/s, ~50–300 KB each at typical DPR) that budget
was exhausted every 0.5–3 s and V8 forced a full mark-compact GC. Measured with
a real GPU (`SYC_HEADED=1 node bench/jank-trace.mjs`, 200 comments/s): 13 major
GCs in 12 s with 10–26 ms pauses on a 2 MB JS heap, 22 dropped frames.

The fix is structural: comments are packed into shared **atlas pages** instead.

- A page is a 2048×256 device-px GPU-backed canvas (2 MB). Slots are
  shelf-packed with a 1 px gutter so bilinear sampling never bleeds.
- Text is rasterized on a small CPU scratch canvas (one per power-of-two size
  bucket, reused forever) and the finished sprite is blitted into the page.
  Stroking glyph outlines straight onto a large accelerated page halved the
  frame rate on an AMD iGPU; an image blit is free.
- Each on-screen sprite (and each prepared-but-not-yet-admitted one) holds a
  reference on its page. When the current page is full, the oldest page with
  zero references is wiped and reused; a new page is opened only while none is
  free, up to a hard ceiling. Steady state therefore allocates nothing.
- The raster cache is opportunistic: an entry stays valid while its page's
  generation matches, and is dropped on lookup once the page was recycled.
- Oversized text (wider than a page) or a fully busy atlas falls back to a
  standalone bitmap, which is the rare exception rather than the rule.

After the change, same machine and load: 3 major GCs of 2.6–3.6 ms (V8's idle
memory reducer on a 3 MB heap), 4 single dropped frames in 12 s, frame-loop p99
5 ms instead of 10 ms. `bench/jank-trace.mjs` is the regression probe; keep the
major-GC count near zero.

## Presentation-Side Misses (the residual judder on a real page)

After the atlas fix the overlay was smooth in the sandbox but still stuttered
on a real YouTube live page. Traced there with the unpacked extension
(`bench/real-page-trace.mjs`, 12 s at 20 synthetic comments/s plus live chat,
AMD Renoir iGPU, 60 Hz): the renderer main thread was idle during every missed
frame (frame-loop p99 3 ms, no task over 21 ms, 0 major GCs) and the
compositor received every BeginFrame, but frames were held at the
swap/presentation stage (`Swap` 24–27 ms, submit-to-presentation 48 ms) and
the scheduler then skipped BeginMainFrame. Canvas size did not matter
(`renderScalePct` 50/75/100 alike), GPU busy stayed at 15–60 %, and a plain
60 fps DOM animation over the video with the overlay *off* missed even more
frames: the page's commit pipeline is back-pressured by presentation, not by
our drawing.

Two changes, measured on the same page (missed vsyncs per 12 s):

| run                                     | X11 (XWayland) | native Wayland |
| --------------------------------------- | -------------- | -------------- |
| default canvas                          | 26, 38         | 10             |
| `desynchronized: true` canvas           | 3, 4           | 4              |
| overlay off, full-size DOM animation    | 60             | 7              |

- The overlay canvas is created with `{ alpha: true, desynchronized: true }`:
  it gets its own compositor surface instead of riding the page's commit.
  Desktop Chrome keeps it double-buffered (single-buffered low-latency canvases
  exist only on ChromeOS/Android), so there is no tearing. Chrome ≥ 140 runs
  natively on Wayland in a Wayland session, which is the better-behaved column.
- The few remaining misses no longer show as a jump because of the smoothed
  frame interval (see below).

## Known Hot Spots

- `Array.prototype.shift()` on hot queues can move array contents; prefer a head
  index or ring buffer.
- Text rasterization is more expensive than scoring. `push()` only enqueues; the
  frame loop rasterizes into a `ready` queue under a hard time budget
  (`rasterBudgetMs`) before admitting. There are deliberately **no timers on the
  render thread**: a `setTimeout` slice landing just before a vsync deadline
  shows up as a periodic "jolt" (an exact-1s worker stats timer produced a
  ~1 Hz hitch), so rasterization is frame-driven and bounded instead. The budget
  caps a burst at a few ms, well inside the frame.
- High DPR multiplies bitmap memory and draw/clear work. Keep `renderScalePct`
  and lane geometry honest before adding renderer architecture.
- Glow/shadow should degrade under load.
- Lane assignment is currently cheap because lane count is small. If lane count
  grows substantially, use a priority queue over lane free times.
- Motion uses a **smoothed frame interval** (`frameEMA`, α = 0.1), not the raw
  rAF delta. A missed vsync has already been shown as a repeated frame;
  advancing by the raw 33 ms afterwards lands every comment two steps ahead,
  and that "hold, then double jump" is the judder people see. Smoothing turns
  each miss into a plain hold; a sustained lower frame rate still converges to
  real-time speed within ~20 frames, and danmaku is not clock-synced, so the
  small drift is invisible. Gaps above `LONG_GAP_MS` are a pause (no teleport,
  no expiry). Keep `LONG_GAP_MS` well above a normal hitch (~500 ms) or the
  bug returns.
- Idle frames (no sprites and a clean canvas) skip the full-canvas clear and
  composite entirely; `_dirty` is forced by `clear()`/`_resize()` so the stale
  frame is still wiped exactly once.
- Do not "adapt" resolution at runtime. An earlier adaptive render scale
  (stepping `dpr` down every ~1.5 s, clearing the raster cache and resizing the
  canvas each step) was itself a periodic jolt source and was removed.
- Sprite positions are NOT snapped horizontally: x is drawn at its exact
  fractional coordinate. Snapping x to the device grid quantises constant-velocity
  motion into alternating pixel steps (measured ~18% per-frame velocity swing at
  `dpr 0.75`) and reads as constant judder. Lane y never changes, so it stays
  snapped (`Math.round(y * dpr) / dpr`) for crisp text edges. Horizontal
  sub-pixel filtering is far less noticeable than the stair-step.

## Scorer Transport Gate

Do not add a new scorer transport for the current heuristic scorer. Reconsider
only if a batched or stateful scorer first proves a clear Chrome/V8 end-to-end
win and the contract/docs are updated before shipping.
