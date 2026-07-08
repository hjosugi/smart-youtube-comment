// Pure helpers for replay/VOD playback: per-message gating and seek detection.
// No DOM, no timers — fully unit-testable.

import type { ChatMessage } from "./types.ts"

export type Fate = "show" | "skip" | "drop"

interface FateOptions {
  seen: { has: (id: string) => boolean }
  shouldDrop: (author: string, text: string) => boolean
  leadMs?: number
  lagMs?: number
}

// Decide a message's fate given the current playback position, the already-shown
// id set, and the NG predicate. Live messages (no offsetMs) stream straight
// through (deduped). Replay messages are gated to a window around `now` so the
// backlog is not dumped and future messages are revisited when playback reaches
// them. Returns "show" | "skip" (re-evaluate later) | "drop" (never).
export const makeFate =
  ({ seen, shouldDrop, leadMs = 1500, lagMs = 8000 }: FateOptions) =>
  (m: ChatMessage, now: number): Fate => {
    if (shouldDrop(m.author, m.text)) return "drop"
    if (m.offsetMs != null) {
      if (m.offsetMs > now + leadMs) return "skip"
      if (m.offsetMs < now - lagMs) return "drop"
    }
    return seen.has(m.id) ? "drop" : "show"
  }

// Did the player jump (seek) rather than advance normally? Compares the playback
// delta to the wall-clock delta over the same interval. A genuine seek moves
// playback far more (or less) than time actually elapsed.
export const isSeek = (deltaPlaybackMs: number, deltaWallMs: number, thresholdMs = 2000): boolean =>
  Math.abs(deltaPlaybackMs - deltaWallMs) > thresholdMs

export const createSeenTracker = (maxIds = 4000) => {
  const generationMax = Math.max(1, Math.floor(maxIds / 2))
  let current = new Set<string>()
  let previous = new Set<string>()

  return {
    has(id: string): boolean {
      return current.has(id) || previous.has(id)
    },
    add(id: string) {
      if (current.has(id) || previous.has(id)) return
      if (current.size >= generationMax) {
        previous = current
        current = new Set()
      }
      current.add(id)
    },
    clear() {
      current.clear()
      previous.clear()
    },
    get size() {
      return current.size + previous.size
    },
  }
}

interface SeekWatcherOptions {
  playbackMs: () => number
  onSeek: () => void
  isPlaying?: () => boolean
  intervalMs?: number
  thresholdMs?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => any
  clearTimer?: (timer: any) => void
}

export const createSeekWatcher = ({
  playbackMs,
  onSeek,
  isPlaying = () => true,
  intervalMs = 700,
  thresholdMs = 2000,
  now = () => performance.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
}: SeekWatcherOptions) => {
  let lastT = playbackMs()
  let lastWall = now()

  const check = () => {
    const t = playbackMs()
    const wall = now()
    const deltaPlayback = t - lastT
    const deltaWall = wall - lastWall
    const jumped = isPlaying()
      ? isSeek(deltaPlayback, deltaWall, thresholdMs)
      : Math.abs(deltaPlayback) > thresholdMs
    lastT = t
    lastWall = wall
    if (jumped) onSeek()
  }

  const timer = setTimer(check, intervalMs)
  return {
    check,
    stop: () => clearTimer(timer),
  }
}
