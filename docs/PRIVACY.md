# Privacy Policy

Smart YouTube Comment Overlay is a Chrome extension that displays YouTube live
chat as an on-video comment overlay.

## Data Processed

The extension processes the following data locally in the browser:

- YouTube live chat message text
- YouTube live chat author display names and author roles
- YouTube page content needed to find live chat elements and render the overlay
- Extension settings, display preferences, performance limits, and local block
  lists

## Local Processing

Comment scoring, filtering, and rendering run on the user's device. Chat text,
author names, block lists, and settings are not sent to the developer or to an
external server.

## Web App Relay

The standalone web app can request live-chat data through a configured relay
endpoint. In that mode the relay receives the YouTube video ID, live/replay
continuation tokens, and polling offsets needed to fetch the next chat batch.
Do not point `?relay=` at a relay you do not trust. The default extension path
does not use this relay.

## Storage

The extension uses Chrome extension storage to save user settings and local
filter lists. These settings are used only to configure the overlay experience.

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
