// Device-side live-chat client (mobile PWA).
//
// Polls the Cloudflare relay with an ADAPTIVE cadence:
//   - healthy            -> poll at the server-provided `timeoutMs` (clamped)
//   - transient failure  -> exponential backoff with jitter (back off a
//     tarpitting upstream instead of hammering it; gentler on the shared egress)
//   - recovery           -> cadence resets on the next success
//   - sustained failure  -> re-resolve from the videoId (continuation may be stale)
//   - `ended`            -> stop polling
//
// Design: the decision logic is a PURE state machine (`step`) — no fetch, no
// timers — so it is fully testable in isolation. `start` is the thin effectful
// shell that performs requests and runs the effects the machine returns.
// Relay envelope shape: see docs/CONTRACT.md.

const DEFAULTS = {
  base: "", // relay origin, e.g. "https://syc-livechat-relay.acofun.workers.dev"
  minIntervalMs: 800, // floor between polls even when healthy
  maxIntervalMs: 30000, // cap during backoff
  backoffBase: 1000, // first backoff step after a failure
  backoffFactor: 1.8, // exponential growth per consecutive failure
  jitterRatio: 0.25, // +/- jitter fraction applied to backoff waits
  requestTimeoutMs: 12000, // client-side abort for a single in-flight request
  reResolveAfter: 4, // consecutive failures before re-resolving from videoId
  maxConsecutiveFailures: Infinity, // hard stop (Infinity = never give up)
  random: Math.random, // injectable RNG (keeps jitter deterministic in tests)
};

// ---- pure core --------------------------------------------------------------

const clamp = (lo, hi) => (n) => Math.max(lo, Math.min(hi, n));

const healthyWait = (cfg, timeoutMs) =>
  clamp(cfg.minIntervalMs, cfg.maxIntervalMs)(Number(timeoutMs) || cfg.minIntervalMs);

const backoffWait = (cfg, failures) =>
  Math.min(cfg.maxIntervalMs, cfg.backoffBase * cfg.backoffFactor ** (failures - 1));

// (cfg) -> (state, outcome) -> plan   [PURE]
//   state   = { cont: string|null, failures: number }
//   outcome = { ok: true, env } | { ok: false, error }
//   plan    = { state, emit: ChatMessage[], wait?, healthy?, stop?, error? }
const step = (cfg) => (state, outcome) => {
  if (outcome.ok) {
    const env = outcome.env;
    const emit = env.messages ?? [];
    if (env.ended || !env.continuation) return { state, emit, stop: "ended" };
    return {
      state: { cont: env.continuation, failures: 0 },
      emit,
      wait: healthyWait(cfg, env.timeoutMs),
      healthy: true,
    };
  }
  const failures = state.failures + 1;
  if (failures >= cfg.maxConsecutiveFailures) {
    return { state: { ...state, failures }, emit: [], stop: "failed", error: outcome.error };
  }
  return {
    state: { cont: failures >= cfg.reResolveAfter ? null : state.cont, failures },
    emit: [],
    wait: backoffWait(cfg, failures),
    healthy: false,
    error: outcome.error,
  };
};

// jitter is the one impure cadence concern; applied at the effect boundary
const jitter = (ratio, rng) => (ms) => Math.max(0, Math.round(ms + (rng() * 2 - 1) * ms * ratio));

// ---- effectful shell --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildUrl = (base, { cont, video }) => {
  const url = new URL(base.replace(/\/$/, "") + "/api/livechat");
  if (cont) url.searchParams.set("cont", cont);
  else if (video) url.searchParams.set("video", video);
  return url;
};

export function createLiveChatClient(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const advance = step(cfg);
  const applyJitter = jitter(cfg.jitterRatio, cfg.random);
  let stopped = false;
  let inflight = null;

  const fetchEnvelope = async (params, signal) => {
    const res = await fetch(buildUrl(cfg.base, params), {
      signal,
      headers: { Accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body; // { messages, continuation, timeoutMs, ended }
  };

  // One request -> a pure outcome the state machine can fold.
  const pollOnce = async (params) => {
    inflight = new AbortController();
    const timer = setTimeout(() => inflight.abort(), cfg.requestTimeoutMs);
    try {
      return { ok: true, env: await fetchEnvelope(params, inflight.signal) };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    stop() {
      stopped = true;
      inflight?.abort();
    },

    // Drive the loop. Handlers (all optional):
    //   onMessages(ChatMessage[]), onState({healthy,failures,nextInMs}),
    //   onError(error, consecutiveFailures), onEnded({reason})
    async start(videoId, handlers = {}) {
      const { onMessages, onState, onError, onEnded } = handlers;
      stopped = false;
      let state = { cont: null, failures: 0 };

      while (!stopped) {
        const params = state.cont ? { cont: state.cont } : { video: videoId };
        const plan = advance(state, await pollOnce(params));
        state = plan.state;

        if (plan.emit.length) onMessages?.(plan.emit);
        if (plan.error) onError?.(plan.error, state.failures);
        if (plan.stop) {
          onEnded?.({ reason: plan.stop });
          break;
        }
        if (stopped) break;

        const wait = plan.healthy ? plan.wait : applyJitter(plan.wait);
        onState?.({ healthy: plan.healthy, failures: state.failures, nextInMs: wait });
        await sleep(wait);
      }
    },
  };
}

// Exposed for unit tests of the pure core (no network required).
export const _pure = { step, healthyWait, backoffWait, clamp, jitter };

// Classic-script convenience (mirrors globalThis.SYC* used by scoring/danmaku).
if (typeof globalThis !== "undefined") {
  globalThis.SYCChat = { createLiveChatClient };
}
