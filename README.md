<!-- i18n: language-switcher -->
[English](README.md) | [日本語](README.ja.md)

# Smart YouTube Comment Overlay

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Smart%20YouTube%20Comment%20Overlay-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/nkphcfhnfjceplpgcjccnpfdkheafohp)

Chrome MV3 extension for a Nico-style YouTube live chat overlay. It scores
messages locally in JavaScript and uses that score to decide whether a comment
should move quickly, normally, or slowly across the video.

The goal is to keep useful comments visible without letting short repeated
reactions, emoji floods, or low-value bursts bury everything else.

## Install

The extension is published on the Chrome Web Store:

<https://chromewebstore.google.com/detail/nkphcfhnfjceplpgcjccnpfdkheafohp>

- extension ID: `nkphcfhnfjceplpgcjccnpfdkheafohp`
- store category: Entertainment
- listing languages: English and Japanese
- support and bug reports: <https://github.com/hjosugi/smart-youtube-comment/issues>
- privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md)

The store listing tracks the last version that passed Chrome Web Store review,
so it can trail the version in this repository. To run the newest source, load
`extension/` unpacked as described in [Load In Chrome](#load-in-chrome).

## Status

Published on the Chrome Web Store. Implemented:

- Chrome MV3 extension scaffold
- mobile PWA under `web/`
- Cloudflare Worker live-chat relay under `worker/`
- YouTube live-chat extraction from all frames
- danmaku renderer in an extension stage frame over the player: comments are
  moved by the browser's compositor (default), with a canvas renderer kept for
  extremely dense chats
- starts on streams opened from the YouTube home page, a search or a channel
  (YouTube's in-page navigation), not only on a freshly loaded watch page
- comments are live: nothing queues up while the tab is in the background, the
  player is out of view or the video is paused, so nothing floods the video on
  return
- right-click menu on a comment: pin and drag it, or hide everything from its
  author (saved to the NG list)
- text size that can track the player (grows in fullscreen, shrinks in small
  windows with the "relative" font scaling mode)
- comments keep flowing when YouTube's chat is closed (a hidden chat frame
  stands in, replays included)
- picture-in-picture with comments (beta, Document Picture-in-Picture)
- JavaScript-only local scorer in `extension/scoring.js`
- settings and filter UI
- local sandbox and renderer performance probes
- release zip packaging
- security/supply-chain checks

Browser extraction and rendering are the practical bottlenecks, so scoring is
kept small and local.

## How It Works

The extension never calls a YouTube API. It reads the chat that YouTube already
renders: `extension/content.js` runs in the watch page and in YouTube's
live-chat frame.

1. The chat frame watches YouTube's live-chat renderer nodes.
2. Each new message is read from the DOM, checked against the NG lists, and
   normalized into a `ScoreInput`.
3. `extension/scoring.js` scores it locally: emoji and short reactions flow
   fast, long text flows slow, and a quality score decides which comments win
   when the screen is full. Nothing is hidden by the score. The rules, with
   examples, are in [docs/SCORING.md](docs/SCORING.md).
4. `buildRenderPlan()` maps the result into fast / normal / slow display timing.
5. A background service worker relays messages from chat frames to the top video
   frame.
6. The top frame forwards them to `stage.html`, an extension frame laid over
   the YouTube player, in the extension's own process, off YouTube's main
   thread. There each comment is one element moved by a transform animation
   that Chrome's compositor runs by itself, so no script runs per frame
   (`danmaku-dom.js`; the measurements behind this are in
   `docs/PERFORMANCE.md`). The older canvas renderer (`danmaku.js`) can be
   selected under Settings → Performance → Renderer.

The extension does not fetch remote code. The mobile PWA under `web/` gets the
same chat by polling YouTube's InnerTube API through the Worker relay under
`worker/`. Both paths, with the files and functions involved, are described in
[ARCHITECTURE.md](ARCHITECTURE.md).

## How Comments Are Scored

Every comment gets a score before it is drawn. The score never hides a
comment. It decides three things:

| The score decides | Through | Effect on screen |
| --- | --- | --- |
| how fast the comment flows | **tier** (fast / normal / slow) | reactions pass quickly, long sentences stay readable |
| how big it is drawn | **emphasis** | substantial comments are slightly larger with a soft glow, throwaway ones slightly smaller |
| who stays when the screen is full | **priority** | a new comment replaces the lowest-priority one only if its own priority is higher |

Scoring is plain arithmetic on the text, done in the browser
(`extension/scoring.js`). There is no machine learning and nothing is sent
anywhere.

### Step 1: measure the text

| Measure | How it is counted | Example |
| --- | --- | --- |
| **Weight** (how much the text says) | 1 per CJK character, kana or hangul; 0.5 per Latin letter or digit; 0 for spaces, punctuation and emoji | `nice play` = 4, `おつかれさまです` = 8 |
| **Emoji** | 1 per emoji, custom (image) or Unicode | `👏👏👏` = 3 |
| **Repetition** | share of characters equal to the one before | `wwwwww` = 1.0 |
| **Variety** | distinct 2-character pairs ÷ number of characters | `えがおえがおえがお` ≈ 0.33 |
| **Copy** | 1 if the comment shares 80% or more of its 2-character pairs with one of the last 64 comments, else 0 | the 2nd post of the same line |

### Step 2: pick the tier (speed)

The first rule that matches wins.

| # | Rule | Tier | Examples |
| --- | --- | --- | --- |
| 1 | emoji with a weight of 2 or less | fast | `👏👏👏`, a run of custom emoji |
| 2 | weight of 4 or less | fast | `草`, `おお`, `lol`, `nice play` |
| 3 | 4+ characters that mostly repeat (repetition ≥ 0.5 or variety ≤ 0.35) | fast | `wwwwww`, `8888888` |
| 4 | a copy of a recent comment | fast | a line everyone is pasting |
| 5 | weight of 24 or more | slow | explanations, questions |
| 6 | everything else | normal | `おつかれさまです`, `what song is this` |

Each tier has a time: how long a comment's head takes to cross the player
(defaults 3 s fast, 4 s normal, 5 s slow, divided by the scroll speed setting).
Comments in one tier move at the same speed whatever their length; a long one
simply stays on screen longer.

### Step 3: quality, emphasis, priority

```text
quality  = 0.2 + 0.6 × min(weight / 24, 1) + 0.2 × variety − 0.3 × repetition − 0.3 × copy     (kept within 0..1)
emphasis = 0.6 × quality   (+ 0.18 in the slow tier)
priority = 0.55 × emphasis + 0.30 × quality + role bonus (+ 0.5 for a Super Chat)
```

- **quality** grows with how much the text says and how varied it is, and
  shrinks for repetition and copies.
- **emphasis** of 0.62 or more is drawn 12% larger with a glow; 0.18 or less is
  drawn 10% smaller ("Vary size by score" turns this off).
- **role bonus**: owner 0.40, moderator 0.25, member 0.10.
- **priority** only matters once the on-screen limit is reached. Below the
  limit every comment is shown.

### Worked examples

| Comment | Tier | Quality | Emphasis | Priority | Why |
| --- | --- | --- | --- | --- | --- |
| `wwwwwwww` | fast | 0.03 | 0.02 | 0.02 | one letter repeated: drawn small, first to give way |
| `👏👏👏` | fast | 0.20 | 0.12 | 0.13 | emoji only |
| `草` | fast | 0.43 | 0.26 | 0.27 | a short reaction |
| `nice play` | fast | 0.50 | 0.30 | 0.32 | weight 4 |
| `what song is this` | normal | 0.56 | 0.34 | 0.35 | weight 7 |
| `おつかれさまです` | normal | 0.60 | 0.36 | 0.38 | weight 8 |
| `おつかれさまです` from a moderator | normal | 0.60 | 0.36 | 0.63 | + 0.25 role bonus |
| `ありがとう` as a Super Chat | normal | 0.53 | 0.32 | 0.83 | + 0.5, and 1.3× the time on screen |
| `the audio is delayed by about two seconds after the scene transition` | slow | 0.98 | 0.77 | 0.72 | long and varied: larger, glow, slow |
| the same line posted again by someone else | fast | lower by 0.3 | | | a copy |

More detail (length-based speed variation, lanes, measurements on real chat) is
in [docs/SCORING.md](docs/SCORING.md).

## Privacy And Storage

The extension scores, filters, and renders comments locally in the browser.
Display, behavior, and performance settings are saved with Chrome Sync storage
when available, so Chrome may sync those settings across the signed-in profile.
Blocked users and blocked words are saved only in local extension storage on the
current device. Chat text, author names, and block lists are not sent to the
developer.

## Requirements

- Chrome or Chromium for loading the extension
- Node.js 22+ and npm 10+ for scripts
- Optional: Bun 1.3+ for faster local scripts

Install JS tooling:

```sh
npm install
```

## Test

Run the security gate, typecheck, web build, unit suites, browser e2e suites
when Chromium is installed, and sandbox smoke checks:

```sh
npm test
```

Run the security gate directly:

```sh
npm run security
```

Bun equivalents:

```sh
bun run test:bun
bun run security:bun
```

Renderer performance probe:

```sh
npm run test:e2e
```

Real extension smoke test in Chromium:

```sh
npm run test:ext
```

Opt-in real YouTube smoke:

```sh
SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube
```

`test:ext` opens a real browser locally. In CI it skips by default unless
`SYC_REQUIRE_EXTENSION_E2E=1` is set. To make `npm test` fail instead of
skipping missing Chromium, set `SYC_REQUIRE_E2E=1`.

## Worker Relay

The Cloudflare Worker under `worker/` relays YouTube InnerTube live-chat calls.
It defaults to the checked-in WEB client version, but production can override it
without a code change:

```sh
wrangler deploy --var INNERTUBE_CLIENT_VERSION:2.20260705.00.00
```

`GET /health` returns the effective and default InnerTube client versions.
`GET /health?deep=1&video=<11-char-id>` runs a canary `next` probe with the same
effective client version; use it from an external scheduled monitor or Cloudflare
Cron Trigger to detect client-version rejection before viewers hit it.

Optional relay controls:

- `ALLOWED_ORIGINS=https://your-pwa.example` rejects browser callers from other
  origins.
- `RATE_LIMIT_PER_MINUTE=120` limits each client IP per Worker isolate; set `0`
  to disable.

## Local Sandbox

Run:

```sh
npm run sandbox
```

Then open:

```text
http://127.0.0.1:4173/
```

The sandbox serves `sandbox/index.html`, loads the shared JS scorer, simulates
live chat, and renders comments over a fake video surface.

## Load In Chrome

Use this path to run the current source instead of the published store build.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension` directory.
5. Open a YouTube live stream with live chat.

After changing content scripts or manifest files, reload the extension in
`chrome://extensions` and reload the YouTube tab.

Expected behavior:

- comments appear over the video in danmaku style
- short or spammy messages move faster
- higher-quality or emphasized messages move slower
- returning to a background tab shows only the comments arriving from then on;
  the ones posted while it was hidden are not replayed
- the seekbar-area toggle can hide/show danmaku
- default YouTube chat hide/show follows settings

Known limitation:

- YouTube pop-out chat runs in a separate tab without the video player, so this
  extension does not render pop-out chat messages over the original video tab.
  Use the normal embedded chat on the watch page for the overlay.

## Release Build

Create a tester zip:

```sh
npm run release:zip
```

Bun path:

```sh
bun run release:zip:bun
```

Artifacts are written to `.release/`, which is ignored by Git. See
[docs/RELEASE.md](docs/RELEASE.md).

Store releases go out when a version bump lands on `main`, through
[`.github/workflows/chrome-webstore-release.yml`](.github/workflows/chrome-webstore-release.yml),
which then tags `vX.Y.Z` and creates the GitHub Release.
The store listing and publisher setup is already done; the credentials the
workflow needs are in [docs/RELEASE.md](docs/RELEASE.md).

Set package and manifest versions together:

```sh
npm run version:set -- 0.1.1
```

This updates the root, `web/`, `worker/`, their lockfile root metadata, and
`extension/manifest.json`.

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how comments are obtained and rendered, code map, repository layout |
| [docs/CONTRACT.md](docs/CONTRACT.md) | message, poll envelope, and score shapes |
| [docs/SCORING.md](docs/SCORING.md) | how a comment is scored |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | measured bottlenecks and their fixes |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model and the security gate |
| [docs/PRIVACY.md](docs/PRIVACY.md) | privacy policy |
| [docs/RELEASE.md](docs/RELEASE.md) | release flow and store automation |
| [docs/PLAN.md](docs/PLAN.md) | open work, gates, migration notes |
| [CONTRIBUTING.md](CONTRIBUTING.md) | setup, checks, boundaries |

## License

0BSD. You can use, copy, modify, and distribute this project for almost any purpose.

## Disclaimer

This project is not developed or distributed as a business, and does not infringe the patent rights of DWANGO Co., Ltd. in Japan.

The developer accepts no liability for any damage arising from this extension.
