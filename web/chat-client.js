// Device-side live-chat client (mobile PWA).
//
// Polls the Cloudflare relay with an ADAPTIVE cadence. Free-tier friendly:
//   - healthy            -> poll at the server `timeoutMs` (clamped)
//   - QUIET (empty polls) -> stretch the interval (up to maxQuietMs) so a dead
//     chat burns far fewer Worker requests; snaps back the moment messages return
//   - PAUSED (tab hidden / video paused) -> stop polling entirely (zero requests)
//   - transient failure  -> exponential backoff with jitter; re-resolve on a streak
//   - `ended`            -> stop
//
// Design: the cadence decision is a PURE state machine (`step`) — no fetch, no
// timers — fully testable in isolation. `start` is the thin effectful shell.
// Relay envelope shape: see docs/CONTRACT.md.

const DEFAULTS = {
  base: "",
  minIntervalMs: 800,
  maxIntervalMs: 30000, // cap during backoff
  backoffBase: 1000,
  backoffFactor: 1.8,
  jitterRatio: 0.25,
  requestTimeoutMs: 12000,
  reResolveAfter: 4,
  maxConsecutiveFailures: Infinity,
  // quiet-stream adaptation (free-tier request saver)
  quietThreshold: 1, // a poll with < this many messages counts as "quiet" (i.e. 0)
  quietGrowth: 1.6, // interval multiplier per consecutive quiet poll
  maxQuietMs: 40000, // ceiling while quiet
  getOffsetMs: null, // () => current player offset (ms); enables replay/VOD mode
  random: Math.random,
};

// ---- pure core --------------------------------------------------------------

const clamp = (lo, hi) => (n) => Math.max(lo, Math.min(hi, n));

const healthyWait = (cfg, timeoutMs, quiet) => {
  const base = clamp(cfg.minIntervalMs, cfg.maxIntervalMs)(Number(timeoutMs) || cfg.minIntervalMs);
  return Math.min(cfg.maxQuietMs, Math.round(base * cfg.quietGrowth ** quiet));
};

const backoffWait = (cfg, failures) =>
  Math.min(cfg.maxIntervalMs, cfg.backoffBase * cfg.backoffFactor ** (failures - 1));

// (cfg) -> (state, outcome) -> plan   [PURE]
//   state   = { cont, failures, quiet }
//   outcome = { ok: true, env } | { ok: false, error }
const step = (cfg) => (state, outcome) => {
  if (outcome.ok) {
    const env = outcome.env;
    const emit = env.messages ?? [];
    if (env.ended || !env.continuation) return { state, emit, stop: "ended" };
    const quiet = emit.length < cfg.quietThreshold ? state.quiet + 1 : 0;
    return {
      state: { cont: env.continuation, failures: 0, quiet },
      emit,
      wait: healthyWait(cfg, env.timeoutMs, quiet),
      healthy: true,
    };
  }
  const failures = state.failures + 1;
  if (failures >= cfg.maxConsecutiveFailures) {
    return { state: { ...state, failures }, emit: [], stop: "failed", error: outcome.error };
  }
  return {
    state: { cont: failures >= cfg.reResolveAfter ? null : state.cont, failures, quiet: state.quiet },
    emit: [],
    wait: backoffWait(cfg, failures),
    healthy: false,
    error: outcome.error,
  };
};

const jitter = (ratio, rng) => (ms) => Math.max(0, Math.round(ms + (rng() * 2 - 1) * ms * ratio));

// ---- effectful shell --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildUrl = (base, { cont, video, offset }) => {
  const url = new URL(base.replace(/\/$/, "") + "/api/livechat");
  if (cont) url.searchParams.set("cont", cont);
  else if (video) url.searchParams.set("video", video);
  if (offset != null) url.searchParams.set("offset", String(offset));
  return url;
};

export function createLiveChatClient(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const advance = step(cfg);
  const applyJitter = jitter(cfg.jitterRatio, cfg.random);
  let stopped = false;
  let paused = false;
  let wake = null; // resolve fn for the paused gate
  let inflight = null;

  const waitWhilePaused = () => (paused ? new Promise((r) => (wake = r)) : Promise.resolve());
  const releasePause = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const fetchEnvelope = async (params, signal) => {
    const res = await fetch(buildUrl(cfg.base, params), { signal, headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  };

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
    // Suspend/resume polling without tearing down state (tab hidden, video paused).
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      releasePause();
    },
    stop() {
      stopped = true;
      paused = false;
      releasePause();
      inflight?.abort();
    },

    async start(videoId, handlers = {}) {
      const { onMessages, onState, onError, onEnded } = handlers;
      stopped = false;
      let state = { cont: null, failures: 0, quiet: 0 };
      let replay = false; // latched the first time the relay reports a VOD

      const paramsFor = (s) => {
        const p = s.cont ? { cont: s.cont } : { video: videoId };
        if (replay) p.offset = Math.max(0, Math.floor(cfg.getOffsetMs?.() ?? 0));
        return p;
      };

      while (!stopped) {
        await waitWhilePaused(); // zero requests while paused
        if (stopped) break;

        const outcome = await pollOnce(paramsFor(state));
        if (outcome.ok && outcome.env.isReplay) replay = true;
        const plan = advance(state, outcome);
        state = plan.state;

        if (plan.emit.length) onMessages?.(plan.emit);
        if (plan.error) onError?.(plan.error, state.failures);
        if (plan.stop) {
          onEnded?.({ reason: plan.stop });
          break;
        }
        if (stopped) break;

        const wait = plan.healthy ? plan.wait : applyJitter(plan.wait);
        onState?.({ healthy: plan.healthy, failures: state.failures, quiet: state.quiet, nextInMs: wait, replay });
        await sleep(wait);
      }
    },
  };
}

// Exposed for unit tests of the pure core (no network required).
export const _pure = { step, healthyWait, backoffWait, clamp, jitter };

if (typeof globalThis !== "undefined") {
  globalThis.SYCChat = { createLiveChatClient };
}
