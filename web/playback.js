// Pure helpers for replay/VOD playback: per-message gating and seek detection.
// No DOM, no timers — fully unit-testable.

// Decide a message's fate given the current playback position, the already-shown
// id set, and the NG predicate. Live messages (no offsetMs) stream straight
// through (deduped). Replay messages are gated to a window around `now` so the
// backlog is not dumped and future messages are revisited when playback reaches
// them. Returns "show" | "skip" (re-evaluate later) | "drop" (never).
export const makeFate = ({ seen, shouldDrop, leadMs = 1500, lagMs = 8000 }) => (m, now) => {
  if (shouldDrop(m.author, m.text)) return "drop";
  if (m.offsetMs != null) {
    if (m.offsetMs > now + leadMs) return "skip";
    if (m.offsetMs < now - lagMs) return "drop";
  }
  return seen.has(m.id) ? "drop" : "show";
};

// Did the player jump (seek) rather than advance normally? Compares the playback
// delta to the wall-clock delta over the same interval. A genuine seek moves
// playback far more (or less) than time actually elapsed.
export const isSeek = (deltaPlaybackMs, deltaWallMs, thresholdMs = 2000) =>
  Math.abs(deltaPlaybackMs - deltaWallMs) > thresholdMs;
