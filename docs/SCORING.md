<!-- i18n: language-switcher -->
[English](SCORING.md) | [日本語](SCORING.ja.md)

# Comment Scoring

Every chat message gets a score before it is drawn. The score decides two
things:

- **how fast the comment flows** (fast, normal or slow tier), and
- **which comments win when the screen is full** (priority).

Scoring runs locally in `extension/scoring.js` (`web/scoring.js` is the same
file). It never hides a comment. Hiding is done only by NG words and users
(including "hide this user" in a comment's right-click menu), the per-type
toggles, and, when the screen is full, by the priority rule in section 3.

## 1. What is measured

The scorer looks at what a viewer actually sees on screen.

| Measure | How it is counted | Example |
| --- | --- | --- |
| Emoji | Each custom-emoji image counts as 1, and so does each Unicode emoji. An image's alt text is the emoji's name and is not read. | 3 custom emoji = 3 |
| Weight (how much the text says) | Each CJK character, kana or hangul counts 1. Each Latin letter or digit counts 0.5. Spaces, punctuation and emoji count 0. | `nice play` = 4, `おつかれさまです` = 8 |
| Repetition | Share of characters that equal the one before | `wwwwww` = 1.0 |
| Variety | Distinct 2-character pairs ÷ number of characters | `えがおえがおえがお` ≈ 0.33 |
| Copy | Overlap of 2-character pairs with each of the last 64 comments (Jaccard similarity) | 0.8 or more counts as a copy |

## 2. Tier (speed)

The checks run top to bottom; the first one that matches decides the tier.

| Tier | When | Examples |
| --- | --- | --- |
| fast | Emoji with a weight of 2 or less | `👏👏👏`, a run of custom emoji, `かわいい` + emoji |
| fast | Weight of 4 or less | `草`, `おお`, `いいね`, `lol`, `nice play` |
| fast | 4 or more characters with repetition ≥ 0.5 or variety ≤ 0.35 | `wwwwww`, `8888888`, `草草草草草` |
| fast | A copy of a comment posted moments ago | the 2nd and later posts of the same line |
| slow | Weight of 24 or more (about 24 Japanese characters or 48 Latin letters) | long explanations and questions |
| normal | Everything else | `おつかれさまです`, `what song is this` |

The tier sets the speed.

- **Tier time**: The settings "Fast / Normal / Slow tier time" hold one time per tier (defaults 3 s, 4 s and 5 s, divided by the scroll speed %). It is how long a comment's head takes to cross the player. Every comment in a tier moves at the same speed, so a long comment is not faster than a short one; it simply stays on screen longer.
- **Vary speed by length** (on by default): lengthens the time for long comments and shortens it a little for short ones: 0.8× to 1.45× at a "Length speed strength" of 100%, about 0.93× to 1.16× at the default 35%. Length here counts each emoji once.
- **Fixed rules**: Super Chats get 1.3× the time, and membership items always use the fast time.
- **Lanes**: a comment only enters a lane if it cannot catch up with the comment ahead of it before that one leaves the screen. Faster comments therefore never run into slower ones.

## 3. Quality and priority

```text
quality  = 0.2 + 0.6 × min(weight / 24, 1) + 0.2 × variety − 0.3 × repetition − 0.3 × copy   (clamped to 0..1)
emphasis = 0.6 × quality (+ 0.18 in the slow tier)
priority = 0.55 × emphasis + 0.30 × quality + role bonus + 0.5 for a Super Chat
```

- **Role bonus**: owner 0.40, moderator 0.25, member 0.10.
- **Emphasis**: 0.62 or more draws the comment slightly larger with a soft glow; 0.18 or less draws it slightly smaller ("Vary size by score").
- **When the screen is full**: once the on-screen limit is reached, a new comment replaces the lowest-priority one only if its own priority is higher. Otherwise it is skipped and counted as "dropped". This is the only way the score can keep a comment off screen, and it only happens under load.

## 4. Measured on real chat

481 messages from four live streams (2026-10-03), default settings, 1280 px
wide player. "Before" is v0.3.2.

| | Before | After |
| --- | --- | --- |
| Runs of 3+ emoji (51) | normal tier, 432 px/s | fast tier, 553 px/s |
| Comments the scorer hid | 13 (`おお`, `いいね`, `👏👏👏` …) | 0 |
| Median speed fast / normal / slow | 606 / 478 / 464 px/s | 553 / 408 / 284 px/s |
| Tier depends on arrival order | yes, at random (hash noise) | only for copies |

Before, a custom emoji counted as its name (`スバルさいなりうむあひる`, 12
characters), so emoji runs looked like long text. Long comments in the slow
tier moved almost as fast as normal ones, because the tier time covered the
whole comment's width. The "novelty" check compared hash values that differ
completely even for similar text, so some ordinary comments were randomly
treated as duplicates.

## 5. What it does not do

- No machine learning and no network calls. `toxicity` is always 0.
- It does not hide by content. Use NG words / filters for that.

## Where it lives

- Scoring: `extension/scoring.js` (`createFallbackScorer`, `buildRenderPlan`, `measureComment`)
- Scorer call: `extension/content.js` → `processChatNode` (chat frame)
- Timing, lanes and priority: `extension/danmaku.js` → `_prepare`, `_admit`, `_laneReadyAt`, `_priority`
- Tests: `extension/test/scoring.mjs`, `web/test/danmaku.mjs`
- Data shapes: [CONTRACT.md](CONTRACT.md)
