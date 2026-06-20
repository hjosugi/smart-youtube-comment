// Device-side live-chat client (mobile PWA).
//
// Polls the Cloudflare relay (worker/) with an ADAPTIVE cadence:
//   - healthy   -> poll at the server-provided `timeoutMs` (clamped)
//   - transient failure -> exponential backoff with jitter, so we BACK OFF a
//     tarpitting/throttling upstream instead of hammering it (which helps it
//     recover, and is gentler on the relay's shared CF egress IP)
//   - recovery  -> cadence resets immediately on the next success
//   - sustained failure -> re-resolve from the videoId (in case the continuation
//     went stale), and optionally give up after a hard cap
//   - `ended` (stream over) -> stop polling
//
// Runtime-agnostic: uses only fetch / AbortController / setTimeout (browser and
// Node both provide these). The relay envelope is documented in docs/CONTRACT.md.

const DEFAULTS = {
  base: "", // relay origin, e.g. "https://syc-livechat-relay.acofun.workers.dev"
  minIntervalMs: 800, // floor between polls even when healthy
  maxIntervalMs: 30000, // cap during backoff
  backoffBase: 1000, // first backoff step after a failure
  backoffFactor: 1.8, // exponential growth per consecutive failure
  jitterRatio: 0.25, // +/- jitter fraction applied to every wait
  requestTimeoutMs: 12000, // client-side abort for a single in-flight request
  reResolveAfter: 4, // consecutive failures before re-resolving from videoId
  maxConsecutiveFailures: Infinity, // hard stop (Infinity = never give up)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function withJitter(ms, ratio) {
  const delta = ms * ratio;
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
}

export function createLiveChatClient(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let stopped = false;
  let inflight = null; // AbortController of the current request

  async function fetchEnvelope(params, signal) {
    const url = new URL(cfg.base.replace(/\/$/, "") + "/api/livechat");
    if (params.cont) url.searchParams.set("cont", params.cont);
    else if (params.video) url.searchParams.set("video", params.video);

    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* keep body = {} */
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body; // { messages, continuation, timeoutMs, ended }
  }

  return {
    stop() {
      stopped = true;
      inflight?.abort();
    },

    // Drive the poll loop. Handlers (all optional):
    //   onMessages(ChatMessage[]) — a fresh batch arrived
    //   onState({ healthy, failures, nextInMs }) — cadence/health changed
    //   onError(error, consecutiveFailures) — a poll failed (will be retried)
    //   onEnded({ reason }) — stream ended ("ended") or gave up ("failed")
    async start(videoId, handlers = {}) {
      const { onMessages, onState, onError, onEnded } = handlers;
      stopped = false;
      let cont = null;
      let failures = 0;

      while (!stopped) {
        let wait;
        try {
          inflight = new AbortController();
          const timer = setTimeout(() => inflight.abort(), cfg.requestTimeoutMs);
          let env;
          try {
            env = await fetchEnvelope(cont ? { cont } : { video: videoId }, inflight.signal);
          } finally {
            clearTimeout(timer);
          }

          failures = 0;
          if (env.messages?.length) onMessages?.(env.messages);
          if (env.ended || !env.continuation) {
            onEnded?.({ reason: "ended" });
            break;
          }
          cont = env.continuation;
          wait = clamp(Number(env.timeoutMs) || cfg.minIntervalMs, cfg.minIntervalMs, cfg.maxIntervalMs);
          onState?.({ healthy: true, failures: 0, nextInMs: wait });
        } catch (e) {
          if (stopped) break;
          failures += 1;
          onError?.(e, failures);

          if (failures >= cfg.maxConsecutiveFailures) {
            onEnded?.({ reason: "failed" });
            break;
          }
          // Sustained failure: the continuation may have gone stale — drop back
          // to a fresh resolve from the videoId on the next attempt.
          if (failures >= cfg.reResolveAfter) cont = null;

          wait = withJitter(
            Math.min(cfg.maxIntervalMs, cfg.backoffBase * cfg.backoffFactor ** (failures - 1)),
            cfg.jitterRatio
          );
          onState?.({ healthy: false, failures, nextInMs: wait });
        }

        if (stopped) break;
        await sleep(wait);
      }
    },
  };
}

// Classic-script convenience (mirrors globalThis.SYC* used by scoring/danmaku).
if (typeof globalThis !== "undefined") {
  globalThis.SYCChat = { createLiveChatClient };
}
