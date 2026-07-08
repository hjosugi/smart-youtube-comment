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

import { clamp } from "./math.js"

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
}

// ---- pure core --------------------------------------------------------------

const healthyWait = (cfg, timeoutMs, quiet) => {
  const base = clamp(cfg.minIntervalMs, cfg.maxIntervalMs, Number(timeoutMs) || cfg.minIntervalMs)
  return Math.min(cfg.maxQuietMs, Math.round(base * cfg.quietGrowth ** quiet))
}

const backoffWait = (cfg, failures) =>
  Math.min(cfg.maxIntervalMs, cfg.backoffBase * cfg.backoffFactor ** (failures - 1))

// (cfg) -> (state, outcome) -> plan   [PURE]
//   state   = { cont, failures, quiet }
//   outcome = { ok: true, env } | { ok: false, error }
const step = cfg => (state, outcome) => {
  if (outcome.ok) {
    const env = outcome.env
    const emit = env.messages ?? []
    if (env.ended || !env.continuation) return { state, emit, stop: "ended" }
    const quiet = emit.length < cfg.quietThreshold ? state.quiet + 1 : 0
    return {
      state: { cont: env.continuation, failures: 0, quiet },
      emit,
      wait: healthyWait(cfg, env.timeoutMs, quiet),
      healthy: true,
    }
  }
  const failures = state.failures + 1
  if (failures >= cfg.maxConsecutiveFailures) {
    return { state: { ...state, failures }, emit: [], stop: "failed", error: outcome.error }
  }
  return {
    state: {
      cont: failures >= cfg.reResolveAfter ? null : state.cont,
      failures,
      quiet: state.quiet,
    },
    emit: [],
    wait: backoffWait(cfg, failures),
    healthy: false,
    error: outcome.error,
  }
}

const jitter = (ratio, rng) => ms => Math.max(0, Math.round(ms + (rng() * 2 - 1) * ms * ratio))

// ---- effectful shell --------------------------------------------------------

const buildUrl = (base, { cont, video, offset }) => {
  const url = new URL(base.replace(/\/$/, "") + "/api/livechat")
  if (cont) url.searchParams.set("cont", cont)
  else if (video) url.searchParams.set("video", video)
  if (offset != null) {
    url.searchParams.set("offset", String(offset))
    url.searchParams.set("replay", "1")
  }
  return url
}

export function createLiveChatClient(options = {}) {
  const cfg: any = { ...DEFAULTS, ...options }
  const advance = step(cfg)
  const applyJitter = jitter(cfg.jitterRatio, cfg.random)
  let stopped = false
  let running: Promise<void> | null = null
  let paused = false
  let wake: any = null // resolve fn for the paused gate
  let inflight: any = null
  let refreshRequested = false

  const waitWhilePaused = () => (paused ? new Promise<void>(r => (wake = r)) : Promise.resolve())
  const releasePause = () => {
    const w = wake
    wake = null
    w?.()
  }

  // Interruptible inter-poll wait so refresh() (e.g. on a seek) can poll now.
  let napTimer: any = null
  let napResolve: any = null
  const nap = ms =>
    new Promise<void>(resolve => {
      napResolve = resolve
      napTimer = setTimeout(() => {
        napTimer = null
        napResolve = null
        resolve()
      }, ms)
    })
  const wakeNap = () => {
    if (napTimer) clearTimeout(napTimer)
    napTimer = null
    const r = napResolve
    napResolve = null
    r?.()
  }

  const fetchEnvelope = async (params, signal) => {
    const res = await fetch(buildUrl(cfg.base, params), {
      signal,
      headers: { Accept: "application/json" },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err: any = new Error(body?.error || `HTTP ${res.status}`)
      err.status = res.status
      err.reResolve = body?.reResolve === true
      throw err
    }
    return body
  }

  const pollOnce = async params => {
    const controller = new AbortController()
    inflight = controller
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
    try {
      return { ok: true, env: await fetchEnvelope(params, controller.signal) }
    } catch (error: any) {
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
      if (inflight === controller) inflight = null
    }
  }

  return {
    // Suspend/resume polling without tearing down state (tab hidden, video paused).
    pause() {
      paused = true
    },
    resume() {
      paused = false
      releasePause()
    },
    // Poll now instead of waiting out the current interval (e.g. after a seek).
    refresh() {
      refreshRequested = true
      wakeNap()
    },
    stop() {
      stopped = true
      paused = false
      refreshRequested = false
      releasePause()
      wakeNap()
      inflight?.abort()
    },

    async start(videoId: string, handlers: any = {}) {
      if (running) return running

      const loop = (async () => {
        const { onMessages, onState, onError, onEnded } = handlers
        stopped = false
        let state: { cont: string | null; failures: number; quiet: number } = {
          cont: null,
          failures: 0,
          quiet: 0,
        }
        let replay = false // latched the first time the relay reports a VOD

        const paramsFor = (s: typeof state): any => {
          const p: any = s.cont ? { cont: s.cont } : { video: videoId }
          if (replay) p.offset = Math.max(0, Math.floor(cfg.getOffsetMs?.() ?? 0))
          return p
        }

        while (!stopped) {
          await waitWhilePaused() // zero requests while paused
          if (stopped) break

          refreshRequested = false
          const outcome = await pollOnce(paramsFor(state))

          // 404 = no live chat (chat disabled, not actually live, or members-only).
          // This is terminal, not a transient blip — stop instead of reconnecting.
          if (!outcome.ok && outcome.error?.status === 404) {
            onEnded?.({ reason: "unavailable" })
            break
          }
          if (!outcome.ok && (outcome.error?.status === 410 || outcome.error?.reResolve)) {
            onError?.(outcome.error, state.failures + 1)
            state = { cont: null, failures: 0, quiet: state.quiet }
            continue
          }

          if (outcome.ok && outcome.env.isReplay) replay = true
          const plan = advance(state, outcome)
          state = plan.state

          if (plan.emit.length) onMessages?.(plan.emit)
          if (plan.error) onError?.(plan.error, state.failures)
          if (plan.stop) {
            onEnded?.({ reason: plan.stop })
            break
          }
          if (stopped) break

          const wait = plan.healthy ? plan.wait : applyJitter(plan.wait)
          onState?.({
            healthy: plan.healthy,
            failures: state.failures,
            quiet: state.quiet,
            nextInMs: wait,
            replay,
          })
          if (refreshRequested) {
            refreshRequested = false
            continue
          }
          await nap(wait)
        }
      })()

      running = loop
      try {
        await loop
      } finally {
        if (running === loop) running = null
      }
    },
  }
}

// Exposed for unit tests of the pure core (no network required).
export const _pure = { step, healthyWait, backoffWait, clamp, jitter }

if (typeof globalThis !== "undefined") {
  globalThis.SYCChat = { createLiveChatClient }
}
