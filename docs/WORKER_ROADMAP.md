# Worker Roadmap

## Current Release

The relay remains stateless HTTP polling:

- edge cache collapses warm same-key polls,
- in-isolate in-flight collapse protects cold bursts,
- optional `ALLOWED_ORIGINS` (comma-separated origins) blocks browser callers
  outside trusted apps,
- `RATE_LIMIT_PER_MINUTE` limits each client IP per isolate (`120` default, `0`
  disables),
- structured metrics report cache, in-flight, upstream latency, and retry counts.

Replay continuation polls are explicit:

```text
/api/livechat?cont=<token>&offset=<ms>&replay=1
```

Replay terminal state is owned by the embedded player. The relay keeps replay
`ended: false` because the replay endpoint can be queried by arbitrary offsets.

## Durable Object Single-Flight Candidate

Move to WebSocket + Durable Object only after HTTP polling metrics show that
edge cache plus in-flight collapse are insufficient. Required evidence:

- high MISS rate for many viewers of the same video,
- upstream 429/5xx bursts despite cache HIT ratio tuning,
- client-visible latency from repeated re-resolve or continuation churn.

Candidate architecture:

1. One Durable Object instance per YouTube video ID.
2. Clients connect by WebSocket and send current playback offset for replay.
3. The DO owns one upstream poll loop per live continuation.
4. The DO broadcasts normalized `PollEnvelope` batches to connected clients.
5. HTTP `/api/livechat` remains as fallback until WebSocket adoption is measured.

Acceptance gates:

- no extra scorer/rendering work moves into the Worker,
- per-video DO memory remains bounded under disconnect churn,
- replay offsets are grouped or sampled so one scrubber cannot force upstream
  request amplification,
- metrics compare HTTP and DO paths for upstream calls, latency, and errors.
