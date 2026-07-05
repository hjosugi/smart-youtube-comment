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

  function createFallbackScorer() {
    const recent = [];

    return {
      source: "js-fallback",
      score(input) {
        const text = typeof input === "string" ? input : input.text;
        const normalized = normalizeText(text);
        const chars = [...normalized];
        const charCount = chars.length;
        const emojiCount = chars.filter(isEmojiLike).length;
        const emojiRatio = charCount === 0 ? 0 : emojiCount / charCount;
        const tokens = tokenize(normalized);
        const signature = tokenSignature(tokens.length > 0 ? tokens : chars);
        const novelty = estimateNovelty(signature, recent);
        const uniqueRatio = uniqueCount(tokens) / Math.max(tokens.length, 1);
        const repetitionRatio = estimateRepetition(chars);

        recent.push(signature);
        if (recent.length > 96) recent.shift();

        const infoScore =
          Math.min(charCount / 64, 1) * 0.34 +
          uniqueRatio * 0.22 +
          novelty * 0.32 -
          emojiRatio * 0.2 -
          repetitionRatio * 0.18;

        let tier = TIER.NORMAL;
        if (charCount >= 42 || (novelty > 0.72 && tokens.length >= 4) || infoScore >= 0.58) {
          tier = TIER.SLOW;
        }
        if (charCount <= 8 || emojiRatio > 0.5 || novelty < 0.22 || repetitionRatio > 0.38) {
          tier = TIER.FAST;
        }

        const quality = clamp01(infoScore);
        const spam = clamp01(emojiRatio * 0.32 + repetitionRatio * 0.3 + (novelty < 0.22 ? 0.24 : 0));

        return {
          quality,
          spam,
          toxicity: 0,
          emphasis: clamp01(quality * 0.6 + (tier === TIER.SLOW ? 0.18 : 0)),
          show: quality >= 0.15 && spam <= 0.85,
          reasons: tier === TIER.FAST ? ["fallback-fast"] : []
        };
      }
    };
  }

  function buildRenderPlan(text, result) {
    if (result.show === false) return null;

    if (Number.isInteger(result.tier)) {
      return {
        tier: result.tier,
        durationMs: result.durationMs,
        score: result.score ?? result.quality ?? 0,
        emphasis: result.emphasis ?? 0,
        reasons: result.reasons ?? []
      };
    }

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

  function normalizeText(text) {
    return text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function tokenize(text) {
    return text.match(/[\p{L}\p{N}]+/gu) ?? [];
  }

  function uniqueCount(values) {
    return new Set(values).size;
  }

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

  function textSignature(text) {
    const normalized = normalizeText(String(text ?? ""));
    const tokens = tokenize(normalized);
    return tokenSignature(tokens.length > 0 ? tokens : [...normalized]);
  }

  function estimateNovelty(signature, recent) {
    if (recent.length === 0) return 1;
    let bestDistance = 32;
    for (const previous of recent) {
      const distance = signatureDistance(signature, previous);
      if (distance < bestDistance) bestDistance = distance;
    }
    return bestDistance / 32;
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
    return repeats / Math.max(chars.length - 1, 1);
  }

  function isEmojiLike(char) {
    const codePoint = char.codePointAt(0) ?? 0;
    return (
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf)
    );
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
    signatureDistance,
    textSignature,
    tokenSignature
  };
})();
