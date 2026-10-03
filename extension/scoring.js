(() => {
  "use strict";

  const TIER = {
    FAST: 0,
    NORMAL: 1,
    SLOW: 2
  };

  const TIER_NAME = ["fast", "normal", "slow"];
  const FALLBACK_DURATIONS = [5000, 6000, 8000];

  // Scoring is JavaScript-only and runs locally in the content script. It is
  // never the live-chat bottleneck (rendering and extraction are).
  //
  // How a comment is scored (walk-through with examples: docs/SCORING.md):
  //   1. Measure what a viewer actually reads. Each emoji counts once, whether
  //      it is a Unicode character or a custom-emoji image; an image's alt text
  //      is the emoji's name, never something on screen. Letters are weighted
  //      by how much they say: a CJK character 1, a Latin letter or digit 0.5.
  //   2. Classify. Reactions (emoji, a few characters, a run of one character,
  //      a copy of a comment posted moments ago) are fast; long text is slow;
  //      everything else is normal.
  //   3. Rank. `quality` orders comments for admission when the screen is
  //      full. Nothing is hidden here: the scorer never drops a comment.

  const REACTION_MAX_WEIGHT = 4;  // 草 / おお / いいね / lol / nice play
  const SLOW_MIN_WEIGHT = 24;     // ~24 CJK characters or ~48 Latin letters
  const COPY_SIMILARITY = 0.8;    // bigram Jaccard at which a comment is a copy
  const RECENT_MAX = 64;          // comments remembered for the copy check

  function createFallbackScorer() {
    const recent = [];

    return {
      source: "js-fallback",
      score(input) {
        const text = typeof input === "string" ? input : input?.text ?? "";
        const parts = typeof input === "object" && Array.isArray(input?.parts) ? input.parts : null;
        const m = measureComment(text, parts);
        const grams = bigramSet(m.body);
        const similarity = maxSimilarity(grams, recent);
        if (grams.size > 0) {
          recent.push(grams);
          if (recent.length > RECENT_MAX) recent.shift();
        }

        const reasons = [];
        if (m.emoji > 0 && m.weight <= 2) reasons.push("emoji");
        else if (m.weight <= REACTION_MAX_WEIGHT) reasons.push("short");
        if (m.letters >= 4 && (m.repetition >= 0.5 || grams.size / m.letters <= 0.35)) reasons.push("repeat");
        if (similarity >= COPY_SIMILARITY) reasons.push("copy");

        const tier = reasons.length > 0
          ? TIER.FAST
          : m.weight >= SLOW_MIN_WEIGHT ? TIER.SLOW : TIER.NORMAL;
        if (tier === TIER.SLOW) reasons.push("long");
        else if (tier === TIER.FAST) reasons.unshift("fallback-fast"); // stable tag (docs/CONTRACT.md)

        const copy = similarity >= COPY_SIMILARITY ? 1 : 0;
        const variety = m.letters <= 1 ? m.letters : Math.min(grams.size / (m.letters - 1), 1);
        const quality = clamp01(
          0.2 +
          0.6 * Math.min(m.weight / SLOW_MIN_WEIGHT, 1) +
          0.2 * variety -
          0.3 * m.repetition -
          0.3 * copy
        );
        const spam = clamp01(0.5 * m.repetition + 0.3 * m.emojiShare + 0.4 * copy);

        return {
          tier,
          quality,
          spam,
          toxicity: 0,
          emphasis: clamp01(quality * 0.6 + (tier === TIER.SLOW ? 0.18 : 0)),
          show: m.units > 0,
          reasons
        };
      }
    };
  }

  function buildRenderPlan(text, result) {
    if (result.show === false) return null;

    if (Number.isInteger(result.tier)) {
      return {
        tier: result.tier,
        durationMs: result.durationMs ?? FALLBACK_DURATIONS[result.tier],
        score: result.score ?? result.quality ?? 0,
        emphasis: result.emphasis ?? 0,
        reasons: result.reasons ?? []
      };
    }

    // A result without a tier (an external scorer): derive one from its numbers.
    const charCount = [...text].length;
    const quality = result.quality ?? 0;
    const spam = result.spam ?? 0;
    const emphasis = result.emphasis ?? 0;
    let tier = TIER.NORMAL;

    if (spam >= 0.55 || quality < 0.22 || charCount <= 8) {
      tier = TIER.FAST;
    } else if (charCount >= 42 || emphasis >= 0.62 || quality >= 0.66) {
      tier = TIER.SLOW;
    }

    return {
      tier,
      durationMs: FALLBACK_DURATIONS[tier],
      score: quality,
      emphasis,
      reasons: result.reasons ?? []
    };
  }

  // What the viewer sees. `parts` ([{ t } | { u, a }]) are preferred: images
  // count as one emoji each and their alt text is ignored. Without parts the
  // text is all there is.
  function measureComment(text, parts) {
    let runs = "";
    let images = 0;
    if (parts && parts.length > 0) {
      for (const part of parts) {
        if (part && part.u) images += 1;
        else if (part && part.t != null) runs += part.t;
      }
    } else {
      runs = String(text ?? "");
    }

    const chars = [...normalizeText(runs)];
    let unicodeEmoji = 0;
    let weight = 0;
    let body = "";
    for (const char of chars) {
      if (isEmojiLike(char)) unicodeEmoji += 1;
      else if (/[\p{L}\p{N}]/u.test(char)) {
        body += char;
        weight += isWide(char) ? 1 : 0.5;
      }
    }
    const letters = [...body];
    const emoji = images + unicodeEmoji;
    const units = letters.length + emoji;
    return {
      body,
      letters: letters.length,
      emoji,
      units,
      weight,
      emojiShare: units === 0 ? 0 : emoji / units,
      repetition: estimateRepetition(letters)
    };
  }

  // On-screen length in characters, each emoji (image or Unicode) counting one.
  function visibleLength(text, parts) {
    const m = measureComment(text, parts);
    return m.units;
  }

  function normalizeText(text) {
    return text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Characters that carry a word's worth of meaning on their own: CJK
  // ideographs, kana, hangul.
  function isWide(char) {
    const codePoint = char.codePointAt(0) ?? 0;
    return (
      (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3ffff)
    );
  }

  function bigramSet(body) {
    const chars = [...body];
    const set = new Set();
    if (chars.length === 1) set.add(chars[0]);
    for (let index = 1; index < chars.length; index += 1) set.add(chars[index - 1] + chars[index]);
    return set;
  }

  // Highest Jaccard similarity to a recent comment (0 = nothing alike).
  function maxSimilarity(grams, recent) {
    if (grams.size === 0) return 0;
    let best = 0;
    for (const other of recent) {
      let shared = 0;
      const [small, large] = grams.size <= other.size ? [grams, other] : [other, grams];
      for (const gram of small) if (large.has(gram)) shared += 1;
      const similarity = shared / (grams.size + other.size - shared);
      if (similarity > best) best = similarity;
    }
    return best;
  }

  // 32-bit FNV-1a over a sequence of strings.
  function tokenSignature(values) {
    let hash = 0x811c9dc5;
    for (const value of values) {
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
    return hash >>> 0;
  }

  // SimHash over character bigrams: similar texts get signatures a few bits
  // apart, so signatureDistance() measures closeness (used by the renderer's
  // near-duplicate drop). Emoji characters are part of the text here.
  function textSignature(text) {
    const chars = [...normalizeText(String(text ?? ""))].filter(
      (char) => isEmojiLike(char) || /[\p{L}\p{N}]/u.test(char)
    );
    const grams = bigramSet(chars.join(""));
    if (grams.size === 0) return 0;
    const votes = new Int32Array(32);
    for (const gram of grams) {
      const hash = tokenSignature([gram]);
      for (let bit = 0; bit < 32; bit += 1) votes[bit] += (hash >>> bit) & 1 ? 1 : -1;
    }
    let signature = 0;
    for (let bit = 0; bit < 32; bit += 1) if (votes[bit] > 0) signature |= 1 << bit;
    return signature >>> 0;
  }

  function signatureDistance(a, b) {
    return popCount32((a ^ b) >>> 0);
  }

  function popCount32(value) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  function estimateRepetition(chars) {
    if (chars.length < 2) return 0;
    let repeats = 0;
    for (let index = 1; index < chars.length; index += 1) {
      if (chars[index] === chars[index - 1]) repeats += 1;
    }
    return repeats / (chars.length - 1);
  }

  function isEmojiLike(char) {
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char);
  }

  function clamp01(value) {
    return Math.max(0, Math.min(value, 1));
  }

  globalThis.SYCScoring = {
    TIER,
    TIER_NAME,
    FALLBACK_DURATIONS,
    buildRenderPlan,
    clamp01,
    createFallbackScorer,
    measureComment,
    signatureDistance,
    textSignature,
    tokenSignature,
    visibleLength
  };
})();
