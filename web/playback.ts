// Pure helpers for replay/VOD playback: per-message gating and seek detection.
// No DOM, no timers — fully unit-testable.

import type { ChatMessage } from "./types.ts"

export type Fate = "show" | "skip" | "drop"

interface FateOptions {
  seen: Set<string>
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
