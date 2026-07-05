# Privacy Policy

Smart YouTube Comment Overlay is a Chrome extension that displays YouTube live
chat as an on-video comment overlay.

## Data Processed

The extension processes the following data locally in the browser:

- YouTube live chat message text
- YouTube live chat author display names and author roles
- YouTube page content needed to find live chat elements and render the overlay
- Extension settings, display preferences, and performance limits
- Local block lists for users and words

## Local Processing

Comment scoring, filtering, and rendering run on the user's device. Chat text,
author names, block lists, and settings are not sent to the developer or to an
external server.

## Web App Relay

The standalone web app can request live-chat data through a configured relay
endpoint. In that mode the relay receives the YouTube video ID, live/replay
continuation tokens, and polling offsets needed to fetch the next chat batch.
The web app only honors `?relay=` when it resolves to the built-in default
relay, the web app's own origin, or a deployment-provided trusted HTTPS relay
origin. Other relay origins are ignored and the built-in default relay is used
instead.

Self-hosted deployments that trust an additional relay can provide
`globalThis.SYC_TRUSTED_RELAY_ORIGINS = ["https://relay.example"]` from a
same-origin script loaded before `app.js`, and must keep the page CSP
`connect-src` in sync. The default extension path does not use this relay.

Relay-provided custom emoji image URLs are treated as untrusted display data.
The web app only loads raster `data:image/...` URLs used by local mock data and
HTTPS YouTube image assets from `yt3.ggpht.com` or subdomains of
`googleusercontent.com`; unsafe image URLs are rendered as text fallbacks or
ignored.

## Storage

The extension uses Chrome extension storage only to configure the overlay
experience:

- Display, behavior, and performance settings are saved in
  `chrome.storage.sync` when Chrome Sync is available, so Chrome may sync those
  settings through the user's signed-in Chrome profile. The extension falls back
  to local extension storage if sync storage is unavailable.
- Blocked users and blocked words are saved in `chrome.storage.local` only.
  They stay on the current device and are not synced across Chrome profiles.

## Remote Code

The extension does not load remote JavaScript or WebAssembly. All executable
extension code is packaged with the extension.

## Data Sharing

The developer does not sell, transfer, or use user data for purposes unrelated
to the extension's single purpose. The extension does not use user data for
creditworthiness or lending decisions.

## Contact

For privacy questions or support, use the GitHub issue tracker:

https://github.com/hjosugi/smart-youtube-comment/issues
