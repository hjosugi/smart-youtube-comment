<!-- i18n: language-switcher -->
[English](CONTRACT.md) | [日本語](CONTRACT.ja.md)

# Interface Contract

This file documents the message and scoring shapes used inside the extension.

Contract version: `2`

## Ownership

- Claude owns live-chat extraction, overlay rendering, settings, filtering, and
  browser UX under `extension/` (desktop Chrome) and `web/` (mobile PWA), plus
  the InnerTube CORS relay under `worker/` (Cloudflare Worker).
- The `ChatMessage` / `ScoreInput` / `ScoreResult` shapes below are shared across
  all surfaces. The mobile `web/` build may keep its own optimized copy of the
  scorer/renderer (it is NOT required to be byte-identical to `extension/`), but
  it MUST keep producing/consuming these shapes.
- Shared behavior changes must be reflected here and in `docs/PLAN.md`.

## Current Transport

Scoring is JavaScript-only and local-only through `extension/scoring.js`.

The hot path is:

```text
ChatMessage -> SYCScoring.createFallbackScorer().score(ScoreInput) -> ScoreResult -> render plan
```

Do not add a new scorer transport unless it has a measured Chrome/V8 win and the
contract is updated before both sides depend on it.

## ChatMessage

Produced by the live-chat reader and consumed by the overlay renderer.

```jsonc
{
  "id": "string",
  "ts": 0,
  "kind": "text",          // "text" | "paid" | "membership"
  "author": "string",
  "authorType": "normal",  // "normal" | "member" | "moderator" | "owner"
  "authorColor": null,
  "text": "string",
  "parts": [
    { "t": "plain text" },
    { "u": "https://yt3.ggpht.com/custom-emoji=s24", "a": ":emoji:" }
  ],
  "amount": null,
  "paidColor": null,      // optional "#rrggbb" Super Chat tier color
  "offsetMs": 0            // replay/VOD only: the message's video timestamp (omitted for live)
}
```

`parts[].u` is untrusted relay data. Web consumers must validate it before
assigning it to `img.src` or drawing it to canvas. The accepted image sources
are HTTPS YouTube emoji assets from `yt3.ggpht.com` or subdomains of
`googleusercontent.com`, plus raster `data:image/...` URLs used by local mock
data. Unsafe image parts should fall back to their alt text when available or be
ignored.

## LiveChat Poll Envelope

The `worker/` relay returns this envelope to the device on each poll. The device
feeds `messages` into the scorer and uses `continuation` / `timeoutMs` to drive
the next poll.

```jsonc
{
  "messages": [],          // ChatMessage[]
  "continuation": "string",// token for the next poll, or null when ended
  "timeoutMs": 1000,       // device should wait this long before the next poll
  "ended": false,          // true => stream/chat is over; stop polling
  "isReplay": false        // true => VOD replay chat (see below)
}
```

Terminal signal: when the stream ends YouTube stops issuing continuations, so the
relay sets `ended: true` and `continuation: null`. The device MUST stop polling
on this signal (do not re-poll the previous token — it is dead).

Clients treat `continuation` as opaque and URL-encode it once when sending
`cont`. YouTube may include percent escapes inside the token itself, such as
`%3D` padding. After parsing the query string, the relay decodes at most one
additional layer before validation, caching, and upstream polling. Malformed
escapes, invalid token characters, and tokens over 8192 characters before this
additional decoding receive a 400 response.

Replay (VOD) mode: when a video is a past-live recording, the relay reports
`isReplay: true`. The device then polls
`GET /api/livechat?cont=<token>&offset=<ms>&replay=1` where `offset` is the
current player position; each replay message carries an `offsetMs` (its video
timestamp). The explicit `replay=1` flag disambiguates replay continuation polls
from live continuation polls. Older `cont + offset` requests without `replay=1`
are rejected with `400 { "error": "offset requires replay=1" }`.

The same replay continuation is reused — replay seeks by offset, it does not
advance. The device gates messages to a window around playback. Replay envelopes
keep `ended: false`; the embedded player, not the relay, is authoritative for
VOD terminal state because the replay endpoint can be queried by arbitrary
player offsets.

`timeoutMs` is clamped by the relay to `[250, 30000]`; the device may apply its
own additional floor.

## ScoreInput

Input to the JS scorer.

```jsonc
{
  "text": "string",
  "authorType": "normal",  // "normal" | "member" | "moderator" | "owner"
  "kind": "text"           // "text" | "paid" | "membership"
}
```

## ScoreResult

Output from the scorer. Numeric values are in `[0.0, 1.0]`.

```jsonc
{
  "quality": 0.5,
  "spam": 0.0,
  "toxicity": 0.0,
  "emphasis": 0.0,
  "show": true,
  "reasons": []
}
```

Default advisory verdict:

```jsonc
{
  "minQuality": 0.15,
  "maxSpam": 0.85,
  "maxToxicity": 0.90
}
```

`show` should equal:

```text
quality >= minQuality && spam <= maxSpam && toxicity <= maxToxicity
```

The extension may re-check this against live user settings.

## Render Plan

`SYCScoring.buildRenderPlan(text, result)` maps `ScoreResult` to the renderer's
speed payload:

```jsonc
{
  "tier": 1,          // 0=fast, 1=normal, 2=slow
  "durationMs": 6000,
  "score": 0.5,
  "emphasis": 0.0,
  "reasons": []
}
```

Paid-message render payloads may additionally carry `amount` and `paidColor`.
These fields are display-only metadata: `amount` labels Super Chat currency
text, and `paidColor` is an optional sanitized `#rrggbb` tier color. They do not
affect the scorer's `tier` value.

## Reason Tags

Reason tags are stable, kebab-case strings. Existing tags should not be renamed.

Current tags:

- `fallback-fast`
