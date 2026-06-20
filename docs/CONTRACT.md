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

There is no Rust/WASM scorer. Scoring is JavaScript-only and local-only through
`extension/scoring.js`.

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
  "amount": null
}
```

## LiveChat Poll Envelope

The `worker/` relay returns this envelope to the device on each poll. The device
feeds `messages` into the scorer and uses `continuation` / `timeoutMs` to drive
the next poll.

```jsonc
{
  "messages": [],          // ChatMessage[]
  "continuation": "string",// token for the next poll, or null when ended
  "timeoutMs": 1000,       // device should wait this long before the next poll
  "ended": false           // true => stream/chat is over; stop polling
}
```

Terminal signal: when the stream ends YouTube stops issuing continuations, so the
relay sets `ended: true` and `continuation: null`. The device MUST stop polling
on this signal (do not re-poll the previous token — it is dead).

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

## Reason Tags

Reason tags are stable, kebab-case strings. Existing tags should not be renamed.

Current tags:

- `fallback-fast`

Historical tags from the removed Rust scorer may appear in old docs or release
notes, but the current JS scorer does not emit them.
