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

The sandbox uses `extension/scoring.js` directly. It drives the canvas renderer.

## Compositor Renderer (the judder frame gaps could not show)

After the atlas, the desynchronized canvas and the stage frame, the frame loop
looked healthy: on a real live page `requestAnimationFrame` ran on practically
every vsync. Comments still visibly juddered. The frame-gap metric was the
wrong one. What the eye sees is how many **new frames of the stage's surface
reach each display frame**: 1 is a fresh frame, 0 means the previous one is
held for another vsync, 2 means one frame is never shown and the comments make
a double step. `bench/real-page-trace.mjs` now reports this as "presented".

Real live page, headed Brave 156 on native Wayland, theater mode, 12 s at 20
synthetic comments/s plus the stream's own chat (about 80 comments on screen).
The machine is a Xeon E-2244G with a Quadro P1000 on the nouveau driver
(Chrome composites in hardware through ANGLE on Mesa), not the Renoir laptop
of the sections further down. Its desktop is a GNOME remote-desktop session,
so the output was the compositor's virtual 60 Hz monitor, not a physical
panel: the numbers are what Chrome hands to the Wayland compositor on each
refresh. A physical monitor has not been measured with this renderer.

| renderer                 | frame callbacks missed | fresh  | held        | skipped     |
| ------------------------ | ---------------------- | ------ | ----------- | ----------- |
| canvas, `desynchronized` | 4                      | 75.8 % | 12.3 % (88) | 12.0 % (86) |
| compositor (default)     | none run per frame     | 92.6 % | 7.4 % (53)  | 0           |

The canvas ran its callback on time and was still held and skipped about seven
times a second each. A desynchronized canvas submits its frames to the display
compositor straight from the main thread; in a trace the stage's own
compositor draws nothing at all (0 `ProxyImpl::ScheduledActionDraw`). Those
submissions are not aligned with the display compositor's deadline, so they
keep landing on either side of it: one display frame gets none, the next gets
two. Each pair is a "hold, then double step".

The compositor renderer (`extension/danmaku-dom.js`) removes script from the
frame path. Each comment is an element with a Web Animations `transform`
animation, which Chrome runs on the compositor thread from an already
rasterized layer. This is what the DOM danmaku players the project was
compared with do (`YoutubeLiveChatFlusher`: CSS keyframes on `transform`;
`weizhenye/Danmaku`: CSS transitions). Measured in a trace with ten comments
in flight and nothing arriving, over 3 s:

| renderer   | BeginMainFrame | rAF callbacks | compositor draws |
| ---------- | -------------- | ------------- | ---------------- |
| canvas     | 180            | 180           | 0                |
| compositor | 0              | 0             | 180              |

Skipped frames are gone; that difference is firm. The held figures are one
run each and should not be read as "40 % fewer": later runs of the compositor
renderer in the same kind of session ranged from 0.3 % to 6.1 % held with no
change to the code. Most of those holds belong to the display's clock, not to
the renderer; see "Reading held" on a remote-desktop display, below. What is
the renderer's own is the main-thread frame a new comment needs, and the
renderer now makes far fewer of them; see "Batched DOM changes".

Cost. One layer per comment is not free: the compositor thread spends 7 to
9 µs per comment per frame, and every main frame restyles all running
animations. CPU per thread in ms per second (headless with hardware GL, so
compare the columns, not the absolute values; 20 and 60 comments a second):

| comments on screen | renderer   | stage main | stage compositor |
| ------------------ | ---------- | ---------- | ---------------- |
| 80                 | canvas     | 48         | under 8          |
| 80                 | compositor | 16         | 46               |
| 230                | canvas     | 71         | under 8          |
| 250                | compositor | 34         | 100              |

Before the DOM changes were batched the compositor rows read 108 and 73, and
248 and 170. The main thread now does less than with the canvas; what remains
is the compositor thread's share, which grows with the number of layers.

So the number on screen is what costs, and it is the user's to set: "Max
comments on screen" (default 100; past it the priority rule decides, see
`docs/SCORING.md`) has no hidden cap behind it, and its note in the settings
says that more can stutter and that some setups (a slow PC, a remote desktop,
see below) stutter even at the default. Settings saved by 0.3.x hold that
version's default of 2000; it falls back to 100 once. The canvas renderer
stays selectable ("Renderer" under Performance) for very dense chats. Text is laid out with canvas `measureText` in the same font,
so no layout is forced; measured and rendered widths agree within 1 px.

Both renderers look the same: `-webkit-text-stroke` with `paint-order: stroke
fill` reproduces the canvas outline, and the compositor renderer draws at the
display's resolution, so "Render resolution" only applies to the canvas.

### Batched DOM changes (fewer main-thread frames)

Comments in flight cost the main thread nothing. Adding and removing them
does, and every main-thread frame is one the stage's compositor waits for and
commits: those are the frames that can still arrive late. A trace of the first
version at 20 comments/s showed 41 main frames a second on the stage, from
three sources:

- one to add each comment (two comments rarely arrive in the same frame);
- one right after each of those, in which Chrome marks the new animations as
  started and restyles every running animation;
- one when each animation finished, to remove the element.

The DOM is now touched in batches (`BATCH_MS`, 250 ms):

- Every comment enters 250 ms after it arrived. All comments of one window are
  added in a single frame, and each starts as far off-stage as it travels in
  the time it still has to wait. Comments keep their own spacing instead of
  entering in columns, and lanes are booked from the entry time.
- An animation runs on for 1.5 s past the far edge, and the next batch removes
  every comment that has left the stage. If no batch comes by, the animation
  ends and removes the comment itself.

Two things that look equivalent are not. An animation `delay` instead of the
head start costs a main-thread frame at the end of every delay (23 a second in
the trace). Setting `startTime` on the animation does not remove the frame
that follows each batch.

Same page and load, headless with hardware GL, traced for 12 s with about 80
comments on screen:

|                               | per comment | batched |
| ----------------------------- | ----------- | ------- |
| stage main frames per second  | 41          | 7       |
| stage main thread, ms/s       | 146         | 21      |
| stage compositor thread, ms/s | 119         | 56      |

Headed, in the remote-desktop session described above, the build from before
this change against the batched one, alternating, 12 s each
(`SYC_EXTENSION_DIR` points the bench at another build). Held frames per run,
split by cause as the bench prints them:

| build       | held       | display clock | during a stage main-thread frame | other   |
| ----------- | ---------- | ------------- | -------------------------------- | ------- |
| per comment | 13, 33, 39 | 6, 17, 19     | 6, 13, 16                        | 1, 3, 4 |
| batched     | 35, 28, 44 | 25, 21, 34    | 3, 4, 7                          | 7, 3, 3 |

Holds that coincide with a stage main-thread frame fell from about 12 to about
5 per 12 s, which is what batching was for. The total did not move (3.9 % and
3.6 % on average, over three and five runs whose ranges overlap), because in
this session most holds come from the display's clock. So the benefit is
confirmed for its own cause and is small next to the rest; if a physical
monitor shows the same, `BATCH_MS` is paying 250 ms of latency for little and
can come down.

### Reading "held" on a remote-desktop display

Chrome's display compositor announces every frame with a BeginFrame and waits
for its clients until the deadline that BeginFrame names, normally a full
interval later. The stage needs about 1 ms from its BeginFrame to a submitted
frame, so it makes that deadline with room to spare.

On the remote-desktop virtual monitor the clock is not regular. The display
compositor re-bases its timer on the presentation times the Wayland compositor
reports, and here that produced 62 to 75 BeginFrames a second for 60 draws,
with 3 to 17 % of them arriving less than 3 ms before their deadline. A frame
announced that late is drawn without the stage's new frame: a hold that no
renderer could have avoided. The share changes from launch to launch, which is
why "held" ranged from 0.3 % to 6.1 % for one build.

Consequences for measuring:

- one run cannot compare two builds on "held"; alternate them and compare by
  cause;
- `bench/real-page-trace.mjs` prints "held by cause" and the BeginFrame
  figures; read those before the total;
- a trace of more than about 20 s wraps the trace buffer (the bench warns), so
  use several short runs instead of one long one.

### Comments are live (the flood after a background tab)

`push()` used to queue up to `maxQueue` (2400) comments whenever the frame loop
was not running: a hidden tab, a player scrolled out of view (Chrome stops
frames in an off-screen cross-origin frame), a video paused with "Pause
comments with video". On return the queue drained at 600 comments a second.
Now:

- `push()` refuses a comment while frames are due but not arriving for more
  than `LONG_GAP_MS`, or while the engine is stopped;
- a comment that waited longer than `maxWaitMs` (2 s) is dropped when its turn
  comes;
- the first frame after a long gap discards whatever is still queued;
- the chat frame forwards only the newest 8 of a batch of more than 24 new
  messages, which is YouTube replaying history (on load, after a seek, when
  the chat catches up) rather than live chat.

## Through a Remote Desktop (what the viewer gets)

Everything above is what Chrome hands to the Wayland compositor. A viewer on a
remote desktop sees it after the remote-desktop server has encoded the screen
and the network has carried it, and that part can be far worse than anything
the renderer does. Measured on GNOME Remote Desktop 50 over RDP (software
encoding: neither VA-API nor NVENC is available with the nouveau driver), a
direct Tailscale link, a 30 fps live video in theater mode. The figures are
read once a second from the server's TCP socket with `ss -tinH`
(`bytes_sent`, `rtt`, `unacked`, `data_segs_in`):

| remote screen | comments on screen | sent     | round trip | segments in flight |
| ------------- | ------------------ | -------- | ---------- | ------------------ |
| 1904x995      | none (video only)  | 2.8 MB/s | 16 ms      | 110                |
| 1904x995      | 20                 | 4.7 MB/s | 18 ms      | 160                |
| 1904x995      | 40                 | 6.8 MB/s | 48 ms      | 560                |
| 1904x995      | 80                 | 7 to 9.5 | 240–370 ms | 2000–3000          |
| 2856x1493     | 1                  | 4.8 MB/s | 23 ms      | 180                |
| 2856x1493     | 20                 | 7.6 MB/s | 44 ms      | 720                |
| 2856x1493     | 80                 | 8.7 MB/s | 245 ms     | 2400               |

- This link carries about 8 MB/s. Past that the stream queues: the picture
  arrives a quarter to half a second late, and the packets coming back from
  the client (mostly frame acknowledgements) fall from about 70 a second to 30
  to 50. Sampled every 0.25 s, delivery also stops for 0.25 to 0.5 s about
  every 3 s (at 37.25, 40.5, 43.5, 46.5 and 50.25 s of one run). A viewer
  describes this as very choppy with a jolt every three seconds. Chrome's own
  output during it was 60 draws a second with 94 to 99 % fresh frames.
- Comments are expensive for such a stream. The video changes the picture 30
  times a second and the comments move 60 times a second, so the encoder gets
  a changed picture twice as often, and moving text edges compress badly.
  Each comment on screen adds about 0.1 MB/s at 1904x995.
- The extension cannot detect this: its frames are produced at full rate
  throughout. What helps is on the viewer's side: a low "Max comments on
  screen" (the setting goes down to 10; about 30 fit at 1904x995, fewer on a
  larger screen), a smaller remote screen, hardware video encoding on the
  server, or watching in a browser on the local machine.
- YouTube stops playback in the bench's fresh profile after about a minute,
  so each run has to finish before that.

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

These counts are frame-callback gaps. They did not show what reached the
display: measured there, the desynchronized canvas is held and skipped about
seven times a second (see "Compositor Renderer" above), which is why the
canvas is no longer the default renderer.

## Stage Frame (YouTube's main thread was the bottleneck)

With the engine in the content script, the danmaku loop shared YouTube's main
thread. Traced on a real live page (Brave 154, native Wayland, Renoir iGPU,
hololive stream, 15 s): with the extension **off**, YouTube itself ran 655 ms
and 526 ms main-thread tasks, and the in-page overlay froze for each of them.
Its rAF also made the page run its full lifecycle (style, IntersectionObserver
computation, layerize, paint) every vsync instead of when YouTube needed it.

A worker would avoid that, but YouTube's CSP blocks `blob:` workers and
workers cannot load extension-origin scripts. So the engine now runs in
`stage.html`, an extension-origin iframe laid over the player: it gets the
extension's own renderer process and frame clock. `content.js` keeps settings
for the page side, translation and the toggle, forwards comments with
`postMessage`, and forwards the player's pointer input (the stage is
`pointer-events: none`; it reports what is under the cursor so a right-click
can be swallowed synchronously). The stage reads its settings from storage.

Final build, headless Brave with hardware GL (`SYC_HEADLESS=1`), 15 s at 20
comments/s plus live chat, three rounds each:

| run                 | YouTube main thread | BeginMainFrame on YouTube |
| ------------------- | ------------------- | ------------------------- |
| extension off       | 27–30 ms/s          | 2–3/s                     |
| engine in the page  | 168–171 ms/s        | 30–31/s                   |
| stage frame         | 37–77 ms/s          | 2/s                       |

The total is not smaller: the drawing work moves to the stage process (45–70
ms/s on a real display). What changes is that YouTube's page stays as light as
without the extension and the danmaku keeps moving through YouTube's long
tasks. Headless canvases are software-rastered, so stage-side numbers and
frame pacing from headless runs are not representative; judge those headed.

Gotchas:

- The stage is loaded through its per-session dynamic URL, but its document
  origin is still `chrome-extension://<extension id>`; match and target that.
- An iframe whose `color-scheme` differs from its document paints an opaque
  backdrop; both sides use `normal`.

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
