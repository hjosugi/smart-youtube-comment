<!-- i18n: language-switcher -->
[English](PLAN.md) | [日本語](PLAN.ja.md)

# Plan

What ships is listed under "Status" in the [README](../README.md), and how it
works is in [ARCHITECTURE.md](../ARCHITECTURE.md). This file holds what is still
open, the gates that keep heavier work from starting too early, and migration
notes for shape changes.

## Open

- **Real-display check of the stage frame and picture-in-picture.** Headless
  traces measure main-thread load only. Frame pacing of the stage frame and of
  PiP (beta) on a real monitor has not been confirmed.
- **Chat observation when YouTube replaces the chat.** Re-attaching after
  YouTube recreates `#items`, and the stand-in chat frame used while the chat is
  closed, have no automated test. Both are checked by hand on a real stream.
- **PWA on real devices.** Run the checklist below on the deployed PWA.
- **Pin and drag in the PWA.** The YouTube iframe owns pointer events there, so
  pinning needs a capture layer first. It works in the extension.

### PWA device checklist

Devices: iOS Safari (current, low-power mode off and then on), Android Chrome
(current, mid-range device), optionally an older Android device if frame p95
is close to the gate.

1. Open the deployed PWA.
2. Start a live stream from the URL field and from the Web Share Target.
3. Tap-to-play, pause, and the custom controls work.
4. Live hides the seekbar; replay enables it.
5. Media Session metadata shows, and play/pause works where supported.
6. Wake Lock keeps the screen on while in front and releases on stop.
7. Open `?perf=1` and watch an active chat for at least 3 minutes. Record
   `fps`, `frameP95`, `frameP99`, `longTasks`, `active`, and `dropped`.

If a device fails, lower `renderScalePct`, `spawnPerFrame`, or `maxActive`
first. Give iOS and Android different `renderScalePct` defaults only if both
measurements support it. Put the final values and HUD captures in the release
notes.

## Gates

Do not start these until the evidence exists.

### New scorer transport

The scorer is plain JavaScript in the content script (chat frame) and the PWA,
and it is not the bottleneck. Add another transport only if all hold:

1. a batch or stateful scorer exists outside the extension hot path first;
2. Chrome/V8 benchmarks show a clear end-to-end win over the JS scorer;
3. [CONTRACT.md](CONTRACT.md) is updated before the extension depends on the
   new shape;
4. the manifest CSP and web-accessible resources are reviewed again.

### Heavier renderer (OffscreenCanvas, worker rasterization)

Keep Canvas2D unless a real device in the checklist above shows one of:

- `frameP95 > 33 ms` for more than 30 s while `active < maxActive`;
- long tasks growing repeatedly during normal chat bursts;
- touch or video controls visibly delayed while comments flow.

A prototype must include before/after HUD captures on those devices and must not
regress emoji, Super Chat color, or comment-list scrolling.

### Relay single flight (WebSocket + Durable Object)

The relay stays stateless HTTP polling (edge cache, in-flight collapse, rate
limit; see "Relay robustness and cost" in ARCHITECTURE.md). Move on only when
relay metrics show:

- a high MISS rate among many viewers of the same video;
- upstream 429/5xx bursts despite cache tuning;
- client-visible latency from repeated re-resolve or continuation churn.

Candidate: one Durable Object per video ID owns a single upstream poll loop and
broadcasts `PollEnvelope` batches to clients over WebSocket; clients send their
playback offset for replay. HTTP `/api/livechat` stays as the fallback until the
WebSocket path is measured. Acceptance: no scoring or rendering moves into the
Worker; per-video memory stays bounded under disconnect churn; replay offsets
are grouped or sampled so one scrubbing viewer cannot multiply upstream calls;
metrics compare upstream calls, latency, and errors between the two paths.

## Migration notes

Shapes (see [CONTRACT.md](CONTRACT.md)):

- The relay decodes one more layer of percent escapes in continuation tokens
  before validation and cache lookup. Envelope and client encoding are
  unchanged.
- `paidColor` is an optional, display-only field on `ChatMessage` and the render
  payload. Messages without it stay valid; `amount` stays nullable.
- Replay polls send `replay=1` with `cont` and `offset`. `cont` + `offset`
  without `replay=1` is a 400. The relay keeps replay `ended: false`; the player
  decides when a replay is over.

Stored settings:

- `lineHeight` (px) is no longer read. Stored values normalize to the
  `lineHeightScale` default; the engine still receives px (`fontPx * scale`).
- The filter store gained `mode` (`drop` / `censor` / `replace`) and
  `replacement`. Older records normalize to `drop` and the default replacement.

## Store review

Record rejection reasons here.

## Credits

Several settings and interactions (per-type visibility and size, author name
mode, outline, flow direction, density, maximum width, wrapping, user layer CSS,
pinning, time shift) follow ideas from `ys-j/YoutubeLiveChatFlusher`. They are
independent implementations; no code was copied.
