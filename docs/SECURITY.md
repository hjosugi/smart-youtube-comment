<!-- i18n: language-switcher -->
[English](SECURITY.md) | [日本語](SECURITY.ja.md)

# Security Posture

This project treats the Chrome extension as a browser supply-chain boundary.
The extension should not fetch remote code, expose broad browser permissions, or
turn YouTube page text into executable content.

## Threats Covered

- Extension supply-chain compromise through broadened permissions, remote code,
  or unexpectedly exposed web-accessible resources.
- Dependency confusion, unpinned package drift, missing package integrity, and
  non-optional lifecycle install scripts.
- DOM/script injection through extension pages or content scripts.
- Prompt-injection-adjacent abuse where page text is treated as data only; chat
  messages must never become executable HTML, JavaScript, configuration, or
  model/tool instructions.

## Release Gate

Run before packaging:

```sh
npm run security
```

Bun path:

```sh
bun run security:bun
```

The gate fails if:

- `manifest.json` leaves Manifest V3.
- permissions expand beyond `storage`.
- `host_permissions` is added; content-script `matches` scopes YouTube injection
  without granting extension-wide host access.
- extension CSP allows inline/eval/remote/blob/data script sources.
- web-accessible resources are exposed.
- extension source uses dangerous injection sinks such as `innerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval`, or `new Function`.
- extension source adds network fetches or remote script/style URLs.
- npm package specs are not pinned exactly.
- lockfile entries lack integrity metadata or use non-registry tarballs.
- non-optional npm packages use lifecycle install scripts.

## Manual Review Checklist

- Keep executable JS and CSS inside `extension/`.
- Do not add CDN scripts, remote stylesheets, or runtime-downloaded logic.
- Prefer `textContent`, `createElement`, `createElementNS`, and fixed CSS text
  over HTML string insertion.
- Treat YouTube chat text, author names, video metadata, and page text as
  untrusted display data only.
- Keep standalone web relays allowlisted: built-in default relay, same-origin
  relays, or explicitly trusted HTTPS origins only. If a deployment adds a
  trusted relay origin, update both `SYC_TRUSTED_RELAY_ORIGINS` and the web CSP
  `connect-src`.
- Never use relay-provided `parts[].u` directly as an image URL. Pass custom
  emoji URLs through the web sanitizer and keep the allowed image hosts limited
  to YouTube emoji assets plus raster `data:image/...` mock assets.
- Keep `chrome.runtime.onMessage` handlers narrow and validate message `type`
  and sender assumptions before acting.
- Keep dependency additions rare. If a package is necessary, pin it exactly,
  inspect its lockfile entry, and rerun `npm run security`.

## Prompt Injection Note

There is no LLM feature in the extension. If one is added later, YouTube chat and
metadata must be passed as quoted untrusted data, never as instructions, and any
tool use or external transmission must be explicit and allowlisted.
