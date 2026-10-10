<!-- i18n: language-switcher -->
[English](ARCHITECTURE.md) | [日本語](ARCHITECTURE.ja.md)

# Architecture

This repository ships two products that put YouTube live chat over the video as
Nico-style danmaku:

| Product | Where | How it gets comments | Talks to a server |
| --- | --- | --- | --- |
| Chrome extension | `extension/` (desktop, on the Chrome Web Store) | Reads the live-chat frame that YouTube already renders (DOM + `MutationObserver`) | No |
| Mobile PWA | `web/` + `worker/` (iOS Safari, Android Chrome) | Polls YouTube's InnerTube API (`youtubei/v1`) through a Cloudflare Worker | Yes, the relay only |

Both handle live chat and chat replay (the chat of a past live stream). Neither
reads the ordinary comment section under a video.

Both end in the same pipeline, with the shapes in [docs/CONTRACT.md](docs/CONTRACT.md):

```text
ChatMessage -> NG filter (filter.js) -> score (scoring.js) -> buildRenderPlan() -> DanmakuOverlay.push() (danmaku.js)
```

Scoring, filtering, and rendering always run on the device. The Worker only
relays chat; it never scores, deduplicates, or renders.

---

## 1. Chrome extension

### 1.1 Frames

A YouTube watch page holds three pieces of this extension, plus the background
service worker:

```text
www.youtube.com/watch?v=…  (top frame)        content.js -> initRenderer()
 ├─ ytd-live-chat-frame > iframe /live_chat     content.js -> initChatExtractor()
 │    (YouTube's chat, or our hidden stand-in when the chat is closed)
 └─ .html5-video-player > iframe stage.html     stage.js + danmaku.js
      (extension origin, its own renderer process)

background service worker                        background.mjs -> background.js
```

`manifest.json` injects `content.js` twice: into `/watch*` and `/live/*` (top
frame only, renderer side) and into `/live_chat*` with `all_frames: true`
(extraction side). The last lines of `content.js` pick the role from
`location.pathname`.

### 1.2 How comments are obtained

The extension never requests chat itself. YouTube's own chat frame fetches it
and renders it into the DOM; the extension reads those DOM nodes. So there is
no API key, no CORS problem, and no request of our own to YouTube. Users that
the viewer blocked on YouTube never reach the DOM, so they never reach the
overlay either.

```text
/live_chat iframe  (content.js, initChatExtractor)
  MutationObserver on yt-live-chat-item-list-renderer #items
  + scan() every 2.5 s: re-attach if YouTube replaced #items, re-read the last 80 nodes
        |
  processChatNode(node)
    isUserChatMessageNode   drop banners, tickers, pinned, deleted/retracted
    extractMessageParts     text runs + custom emoji <img> -> parts
    author / kind / authorType / amount / paidColor / channel id
    isOfficialChatText      drop YouTube's own welcome/guideline lines
    SYCFilter.apply         NG lists: drop, or censor/replace the text
    scorer.score -> buildRenderPlan
        |  chrome.runtime.sendMessage({ type: "smart-comment:chat-message" })
        v
background.js
    sender must be a tab on www.youtube.com; sanitizeRenderPayload
        |  chrome.tabs.sendMessage(tabId, { type: "smart-comment:render-message" }, { frameId: 0 })
        v
top frame  (content.js, initRenderer)
    sanitizeRenderPayload; optional on-device translation (translate.js)
        |  stage.push -> postMessage({ type: "push" }) to the stage frame
        v
stage.html  (stage.js)
    checks event.source and origin; sanitizeRenderPayload
    DanmakuOverlay.push -> canvas
```

The payload is sanitized again at every hop (background, top frame, stage),
because each hop receives it from another context.

What `processChatNode()` reads:

| YouTube element | `kind` |
| --- | --- |
| `yt-live-chat-text-message-renderer` | `text` |
| `yt-live-chat-paid-message-renderer` | `paid` |
| `yt-live-chat-membership-item-renderer` | `membership` |

| Inside the element | Becomes |
| --- | --- |
| `#message` (text nodes and `<img>` emoji) | `text`, `parts` (`{t}` text runs, `{u, a}` images) |
| `#author-name` | `author`; its `external-channel-id` (or the element's `author-external-channel-id`) is the channel ID used by the NG list |
| `author-type` attribute, else badge `[type=…]` | `authorType`: `owner` / `moderator` / `member` / `normal` |
| `#purchase-amount`, `--yt-live-chat-paid-message-*-color` | `amount`, `paidColor` (Super Chat) |

Details:

- **Duplicates.** `processedChatNodes` (a `WeakSet`) remembers each processed
  node. A node is only marked once it has text, so a placeholder that YouTube
  fills in later is picked up through the `characterData` mutation.
- **Why only inside the chat frame.** A document-wide observer on the watch
  page was a measurable source of jank, and the top frame holds no chat nodes.
- **Chat closed.** Closing YouTube's chat unloads its frame.
  `createChatSource()` then adds a hidden 1×1 iframe at the URL YouTube's frame
  last showed (a replay needs its continuation), or at
  `/live_chat?is_popout=1&v=<id>` for a live stream opened with the chat already
  closed. For a replay it forwards the video's `timeupdate` as the same
  `yt-player-video-progress` message YouTube's page sends its own chat frame. A
  `MutationObserver` on the `collapsed` attribute of `ytd-live-chat-frame`
  switches the stand-in on and off.
- **"Hide default chat".** This setting only shrinks YouTube's chat to 1 px with
  CSS. The frame stays loaded, so extraction continues.

Code map:

| File | Function | Role |
| --- | --- | --- |
| `extension/manifest.json` | `content_scripts` | which scripts run in which frames |
| `extension/content.js` | `initChatExtractor`, `findChatItemsRoot` | observer and periodic re-attach |
| | `processChatNode`, `isUserChatMessageNode`, `isOfficialChatText` | one node to one payload |
| | `extractMessageParts`, `extractAuthorType`, `extractAmount`, `extractPaidColor`, `extractAuthorChannelId` | DOM readers |
| | `safeRuntimeSend` | chat frame to background |
| | `createChatSource` | hidden stand-in chat frame |
| | `initRenderer`, `createStage` | top frame: toggle button, stage frame, pointer input, PiP |
| `extension/background.js` | `onMessage` listener, `isAllowedSender` | chat frame to top frame relay |
| `extension/stage.js` | `message` listener | stage side: push, clear, start/stop, hit test, pin, hide user |
| `extension/sanitize.js` | `sanitizeRenderPayload`, `sanitizeMessageParts` | payload and emoji URL validation |
| `extension/filter.js` | `SYCFilter.apply` | NG users, channels, words, regexes |
| `extension/scoring.js` | `createFallbackScorer`, `buildRenderPlan` | tier and priority ([docs/SCORING.md](docs/SCORING.md)) |
| `extension/danmaku.js` | `DanmakuOverlay` | canvas engine |

### 1.3 Rendering in the stage frame

The engine does not run in YouTube's page. `stage.html` is an extension page
that `content.js` lays over the player as an iframe. It is the only
`web_accessible_resources` entry, limited to `https://www.youtube.com/*` and
served through `use_dynamic_url`. In the page, the engine's frame loop made
YouTube's own page lifecycle run every vsync and froze whenever YouTube ran its
routine 0.5 s tasks; in the stage it has its own process and frame clock (see
"Stage Frame" in [docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

- The stage reads settings straight from `chrome.storage`
  (`SYCSettings.load` / `onChange`). The top frame only forwards comments and
  pointer input.
- The stage takes no pointer events. The top frame listens on the player
  (capture phase), sends `hover` / `select` / `drag*` messages, and the stage
  answers with what is under the pointer. The right-click menu is built in the
  page with DOM APIs and `textContent`. "Hide this user" makes the stage write
  the author to the NG lists; the chat frame's `SYCFilter` sees the storage
  change and drops that author from then on.
- Picture-in-picture (beta) moves the `<video>` element into a Document
  Picture-in-Picture window with a stage of its own. The stage accepts messages
  from `parent.opener` for this case.
- Inside the engine, comments are rasterized into shared sprite-atlas pages, so
  the steady state allocates nothing (see "Sprite Atlas" in
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

### 1.4 Settings, storage, and the other pages

- `settings.js` is a schema. `options.html` and `popup.html` draw their forms
  from it, and `toEngineConfig()` turns it into the engine's config.
  Settings live in `chrome.storage.sync`.
- `filter.js` holds the NG lists (users, channel IDs, words, regexes, and the
  drop / censor / replace mode) in `chrome.storage.local` only.
- `background.js` also handles the `toggle-overlay` and `open-options`
  keyboard commands.

---

## 2. Mobile PWA

### 2.1 Why a companion web app

| Environment | Extension | Userscript | Plain web app |
| --- | --- | --- | --- |
| iOS Safari | needs an Xcode app shipped through the App Store | via the Userscripts app | yes |
| Android Chrome | not possible | not possible | yes |

Only a web app covers both. The PWA embeds the YouTube IFrame Player on its own
site and lays a danmaku canvas over it. The official YouTube app cannot be
extended.

No background playback: an embedded player stops when the screen locks or the
app is switched, by OS and YouTube policy. The PWA only uses the Wake Lock API
(keep the screen on while in front) and the Media Session API (lock-screen
metadata and controls). Watching danmaku means looking at the screen, so this is
accepted.

### 2.2 Why a relay

A page cannot call InnerTube (`youtubei/v1`) directly because of CORS. The
official YouTube Data API allows CORS, but polling live chat exhausts its free
quota quickly. So a stateless Cloudflare Worker relays the InnerTube calls and
adds CORS headers. Everything else stays on the device.

### 2.3 How comments are obtained

```text
device (PWA)                         Cloudflare Worker                     YouTube InnerTube
------------                         -----------------                     -----------------
app.ts  client.start(videoId)
chat-client.ts
  GET /api/livechat?video=<id> --->  index.ts handle() -> fetchEnvelope()
                                       resolveLiveChat()  ----------------> POST youtubei/v1/next
                                                          <---------------- conversationBar.liveChatRenderer
                                                                            .continuations[]
                                       pollLiveChat(cont) ----------------> POST live_chat/get_live_chat
                                                          <---------------- actions[]
                                       parseAction() -> ChatMessage[]
                               <---  { messages, continuation, timeoutMs, ended, isReplay }
  onMessages(messages)
  wait (step() decides how long)
  GET /api/livechat?cont=<token> ->  (repeat with the continuation)
```

1. **Resolve.** `?video=<id>`: `resolveLiveChat()` posts `next` and reads
   `contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer`. That
   gives the first continuation and whether the chat is a replay. The first
   poll runs in the same request.
2. **Live poll.** `pollLiveChat()` posts `live_chat/get_live_chat` with the
   continuation and reads `continuationContents.liveChatContinuation`:

   ```text
   actions[]
     addChatItemAction.item                 (new message)
     replaceChatItemAction.replacementItem  (a placeholder replaced)
       liveChatTextMessageRenderer                          -> text
       liveChatPaidMessageRenderer, liveChatPaidStickerRenderer -> paid
       liveChatMembershipItemRenderer                       -> membership
       liveChatSponsorshipsGiftPurchaseAnnouncementRenderer -> membership
       anything else (banners, polls, …)                    -> dropped
   continuations[]
     next token + timeoutMs (clamped to 250–30000 ms)
     no token -> ended: true, the device stops
   ```

   Author badges set `authorType`; message runs become text and emoji `parts`.
3. **Replay poll.** `?cont=<token>&offset=<ms>&replay=1`: `pollReplay()` posts
   `live_chat/get_live_chat_replay` with `currentPlayerState.playerOffsetMs`,
   unwraps `replayChatItemAction`, and stamps each message with `offsetMs`. The
   same continuation is reused; the player position moves the window, and the
   relay always answers `ended: false` for a replay (the player owns the end). The
   device shows only messages within 8 s behind to 1.5 s ahead of the playback
   position (`makeFate` in `playback.ts`), and resets on a backwards seek.
4. **Device loop.** `createLiveChatClient()` in `chat-client.ts` runs the poll
   loop around a pure state machine, `step()`:
   - healthy: wait the server's `timeoutMs`;
   - quiet (empty polls): stretch the wait by `quietGrowth` per poll, up to 40 s;
   - errors: exponential backoff with jitter, up to 30 s;
   - after 4 failures in a row, or right away on a `410`: resolve again from
     the video ID (the continuation expired);
   - tab hidden or video paused: no polling at all;
   - `ended`, or `404` (no live chat): stop.
5. **Pipeline.** `app.ts` `onMessages()`: `sanitizeChatMessage` (URL checks) ->
   replay window and seen-ID check -> `filter.apply` -> comment list and
   `makeRenderer()` (`pipeline.ts`: score, `buildRenderPlan`) ->
   `overlay.push()`.

Code map:

| File | Function | Role |
| --- | --- | --- |
| `worker/src/index.ts` | `handle`, `readParams`, `fetchEnvelope` | routing, validation, edge cache, in-flight collapse, rate limit |
| `worker/src/innertube.ts` | `resolveLiveChat`, `pollLiveChat`, `pollReplay` | InnerTube calls |
| | `postWithRetry`, `postOnce` | 3.5 s per attempt, one retry on timeout/5xx |
| | `extractContinuation`, `parseAction`, `RENDERERS`, `runsToParts`, `authorTypeFromBadges` | pure response transforms |
| `web/chat-client.ts` | `createLiveChatClient`, `step`, `buildUrl` | adaptive poll loop |
| `web/app.ts` | `onMessages` | wiring: player, client, filter, list, overlay |
| `web/pipeline.ts` | `makeRenderer`, `renderBatch` | ChatMessage to danmaku payload |
| `web/playback.ts` | `makeFate`, `createSeenTracker` | replay window, dedup by ID |
| `web/player.ts`, `web/lifecycle.ts` | | YouTube IFrame API, Wake Lock, Media Session |

### 2.4 Relay robustness and cost

- **Input.** `video` must be an 11-character ID and `cont` a bounded token;
  ambiguous `cont` + `offset` without `replay=1` is rejected.
- **Edge cache.** Envelopes are stored in `caches.default` with
  `s-maxage = floor(timeoutMs / 1000)`, keyed only on `video` / `cont` / the
  offset rounded to 3 s. Viewers of the same stream in the same Cloudflare
  location share one upstream call. Polls with `timeoutMs < 1000` and terminal
  envelopes are not cached.
- **Cold bursts.** In-flight requests for the same key share one promise inside
  an isolate.
- **Upstream errors.** They come back as `429` (YouTube rate limit), `410` with
  `reResolve: true` (a 4xx on a continuation: it expired), or `502`, and are
  cached for 1 s so a stalled upstream is not hit by every viewer at once.
  `404` means the video has no live chat.
- **Retries.** The Worker retries once, only on timeout/5xx, which bounds the
  worst case near 7 s. `429` is not retried; sustained trouble is the device's
  backoff to handle. (Measured 2026-06-20: InnerTube is reachable from
  Cloudflare egress at about 1 s per call; it occasionally tarpits a request for
  a few seconds, which is not a lasting IP block.)
- **Optional controls.** `ALLOWED_ORIGINS` rejects other browser origins;
  `RATE_LIMIT_PER_MINUTE` (default 120) limits each client IP per isolate.
- **Client version.** InnerTube is called as the public `WEB` client, version
  `2.20240814.00.00` by default. Override it without a code change with the
  `INNERTUBE_CLIENT_VERSION` variable. `GET /health?deep=1&video=<id>` runs a
  canary `next` call to catch a rejected version before viewers do.
- **Free tier.** Each poll is one Worker request, cache hit or not. At 10 s per
  poll one viewer makes 8,640 requests a day, so the Workers Free 100k/day
  covers about 11 viewers around the clock, or about 278 one-hour sessions. The
  edge cache protects YouTube and the egress IP, not this quota. Pausing while
  hidden and the quiet-chat stretch are what save requests. A WebSocket +
  Durable Object single flight is the next step, gated in
  [docs/PLAN.md](docs/PLAN.md).

### 2.5 Mobile specifics

- The canvas is a sibling of the player iframe inside a wrapper, with
  `pointer-events: none`, so taps reach the YouTube controls.
- `sw.js` caches the static shell. It never caches the chat API.
- `store.js` is a `localStorage` shim with the `chrome.storage` surface, so
  `settings.js` and `filter.js` work unchanged.
- `ui.ts` / `controls.ts` draw a touch settings sheet from the same schema.
- `?perf=1` shows a HUD (`perf.ts`): fps, active comments, drops, frame p95,
  long tasks. Heavier renderer work waits until a real device fails the gate in
  [docs/PLAN.md](docs/PLAN.md).

---

## 3. Shared code

There is no `shared/` directory and no build step for the engine files. They are
classic scripts that publish `globalThis.SYC*`, copied into both trees:

| File | Extension vs web |
| --- | --- |
| `scoring.js`, `filter.js` | byte-identical; `npm run check:shared-drift` fails otherwise |
| `emoji.js` | identical |
| `translate.js` | same logic; the web copy is formatted by `oxfmt` |
| `danmaku.js` | deliberate fork, tuned per surface |
| `settings.js` | deliberate fork: same schema, different defaults |

Default differences (`SYCSettings.PROFILE` names the surface; tests pin these
values, and another test keeps the engine's `DEFAULTS` equal to
`toEngineConfig(DEFAULTS)`):

| Setting | Extension (desktop) | Web (mobile) |
| --- | --- | --- |
| `fontPx` | 24 | 18 |
| `maxActive` | 2000 | 250 |
| `maxQueue` | 2400 | 1000 |
| `spawnPerFrame` | 10 | 6 |
| `renderScalePct` | 75 | 60 |
| `dedup` | off | on |
| `listEnabled` | — | on (web only) |

Change a message or score shape only together with
[docs/CONTRACT.md](docs/CONTRACT.md).

---

## 4. What YouTube can break

| Surface | Depends on | First check |
| --- | --- | --- |
| Extension, extraction | element names `yt-live-chat-*-renderer`, `#items`, `#message`, `#author-name`, the `author-type` attribute | `npm run test:ext:youtube` on a live stream |
| Extension, page | `ytd-live-chat-frame[collapsed]`, `.html5-video-player`, `.ytp-right-controls`, the `yt-player-video-progress` message | same |
| Relay | `twoColumnWatchNextResults.conversationBar.liveChatRenderer`, the `RENDERERS` keys, the continuation data keys, the client version | `/health?deep=1`, `node worker/test/probe.mjs` |

---

## 5. Repository layout

```text
.
├── extension/        Chrome MV3 extension (plain JS, no build step)
│   ├── manifest.json, background.mjs, background.js
│   ├── content.js    chat extraction (chat frames) + stage host (top frame)
│   ├── stage.html, stage.js   the frame the engine runs in
│   ├── danmaku.js, scoring.js, filter.js, settings.js, sanitize.js, emoji.js, translate.js
│   ├── options.*, popup.*, _locales/, icons/
│   └── test/
├── web/              mobile PWA (TypeScript modules + the shared classic scripts), built to web/dist
├── worker/           Cloudflare Worker relay (src/index.ts, src/innertube.ts, test/)
├── bench/            renderer benchmarks, jank traces, browser e2e (bench/e2e)
├── sandbox/          local page with simulated chat (npm run sandbox)
├── scripts/          test runner, security gate, packaging, store upload, version bump
└── docs/             see below
```

## 6. Documents

| Document | Contents |
| --- | --- |
| [README.md](README.md) | install, status, development commands |
| [docs/CONTRACT.md](docs/CONTRACT.md) | `ChatMessage`, poll envelope, `ScoreInput`, `ScoreResult`, render plan |
| [docs/SCORING.md](docs/SCORING.md) | how a comment is scored, with examples |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | measured bottlenecks and their fixes |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model and the release security gate |
| [docs/PRIVACY.md](docs/PRIVACY.md) | privacy policy (linked from the store listing) |
| [docs/RELEASE.md](docs/RELEASE.md) | release flow, store automation, store listing reference |
| [docs/PLAN.md](docs/PLAN.md) | open work, gates, migration notes |
| [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) | checks, boundaries, who edits what |
