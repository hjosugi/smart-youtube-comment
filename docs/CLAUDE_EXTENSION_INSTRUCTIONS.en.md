<!-- i18n: language-switcher -->
[English](CLAUDE_EXTENSION_INSTRUCTIONS.en.md) | [日本語](CLAUDE_EXTENSION_INSTRUCTIONS.md)

# Claude Extension Instructions - 2026-06-17

This file is a work instruction document to be passed to Claude. Claude's main responsibility is `extension/`.

## First Read

1. `AGENTS.md`
2. `docs/CONTRACT.md`
3. `docs/PERFORMANCE.md`
4. `docs/SECURITY.md`
5. This file

## Current Assumptions

Currently, only the JS scorer in `extension/scoring.js` is used.

Please do not add new scorer transports. If you do, first prove that the batch/stateful scorer clearly outperforms in Chrome/V8 real-world measurements, and then update `docs/CONTRACT.md` and `docs/PLAN.md`.

## Claude's Areas of Responsibility

Areas that can be modified freely:

- `extension/`
- Display, settings, YouTube DOM reading, and danmaku renderer of the extension
- Extension manifest / icons / locales

Areas to handle with caution:

- `scripts/`: Related to package/security/release, so clearly state the purpose when making changes
- `docs/`: Only update if you change contracts or operational procedures

## Highest Priority Tasks

1. Add stuttering measurement
   - It is sufficient for dev/debug purposes, so make it possible to see Long Task and frame p95/p99.
   - Values to collect:
     `active`, `pending`, `cache`, `dropped`, `shown`, `spawned/frame`,
     `drawn/frame`, `rasterized/frame`, frame delta p50/p95/p99,
     Long Task count.

2. Optimize renderer to withstand 2000 max
   - Change `pending.shift()` to a ring buffer or head index, as it compresses the entire array.
   - Also convert `recent.shift()` to a ring buffer.
   - Make `drawImage` coordinates integers.
   - Automatically disable glow/shadow when frames are heavy.
   - Do not set DPR too high. High DPR increases bitmap and clear/draw costs.
   - Instead of smoothly rendering all 2000 items, prioritize admission and adaptive quality to protect the video itself.

3. Fix the issue where comments stop flowing after a few minutes
   - Follow the regeneration of the YouTube live chat iframe / `#items`.
   - Ensure that the MutationObserver is not stuck on old nodes.
   - Check that the seen set / dedup / recent cache is not too strong, causing all drops.
   - Do not pick up official messages or guide messages from YouTube as chat messages.

4. Do not overly reduce the NG word preset
   - Reaction strings like `wwwwwww`, `aaaaaaa`, `8888888`, `草草草草` are normal reactions in different cultural contexts, so remove them from the starter preset.
   - Users should be able to manually add to the NG words.
   - Instead of automatic drops, handle them weakly on the priority/admission side during overload.

## Security Requirements

Please prohibit the following in the extension:

- `innerHTML`
- `outerHTML`
- `insertAdjacentHTML`
- `eval`
- `new Function`
- Remote script / remote stylesheet
- Unnecessary remote fetch
- Adding `data:` / `blob:` / remote origin to CSP
- Making `web_accessible_resources` non-empty

For strings output to the DOM, please use `textContent` as a principle. Treat YouTube comment text, author names, video metadata, and text on the page as untrusted input.

Minimize Chrome extension permissions.

- Permissions should primarily be `storage`
- Host permission should be `https://www.youtube.com/*`
- Keep `web_accessible_resources` empty

## Supply-chain Measures

- Dependencies should only use exact pins. Do not use `^`, `~`, `*`, or ranges.
- Maintain the integrity of `package-lock.json`.
- Do not add dependencies with lifecycle install scripts.
- Do not resolve outside of the npm registry.
- Keep `package.json` private.
- Even when using Bun, maintain the auditability of the npm lockfile.

## Local Dev Update Procedure

After updating the extension in local dev mode, do the following:

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Press the reload button for this extension
4. Reload the YouTube watch/live tab
5. If the content script is still old, close and reopen that tab

If you change the manifest, an extension reload is necessary. Even changes to just the content script require a reload of the YouTube tab.

## Verification Commands

After making changes, please execute at least the following:

```sh
npm run security:bun
npm run test:sandbox:bun
npm run release:zip:bun
```

On a real Chrome device, please check the following:

- The danmaku toggle works near the seek bar
- The default chat is hidden as per settings while danmaku is ON
- Official guidance/warnings/recommendations do not mix with danmaku
- New comments continue to flow even after waiting for a few minutes
- Video operations do not freeze even with maxActive set to 2000
- The upper limit settings in options are saved and reflected after reload

## Prompt for Claude

```text
This repo is /mnt/data/workspace/smart-youtube-comment.

Please read AGENTS.md, docs/CONTRACT.md, docs/PERFORMANCE.md,
docs/CLAUDE_EXTENSION_INSTRUCTIONS.md first.

Currently, it is JavaScript-only. Please do not add new scorer transports.

The objectives this time are:
1. Prioritize addressing stuttering. Monitor renderer / chat extraction / queue / Long Task.
2. Make it less likely to crash even with maxActive set to 2000. Avoid pending/recent shifts, and convert to ring buffer/head index.
3. Fix the issue where comments stop flowing after a few minutes. Check the regeneration of the YouTube chat iframe/#items, observer replacement, and dedup all drops.
4. Do not mix unnecessary official comments such as guidance/warnings/recommendations with danmaku.
5. Place the danmaku toggle near the seek bar and do not rely solely on options.
6. When danmaku is displayed, do not open/hide the default chat based on settings.
7. Remove reaction strings like wwww/aaaa/8888/草草草草 from the NG word starter preset. Manual registration by users is allowed.

Security:
- Do not use innerHTML/outerHTML/insertAdjacentHTML/eval/new Function/remote script/remote style.
- Treat YouTube comment text, author names, and metadata as untrusted input. Use textContent/setAttribute/DOM API for DOM output.
- Keep web_accessible_resources empty.
- Keep permissions to a minimum. `permissions` should only be `storage`, manage the injection range to YouTube through `content_scripts.matches`, and do not add `host_permissions`.
- If increasing package dependencies, adhere to exact pins, lockfile integrity, and no install scripts.

Verification:
- npm run security:bun
- npm run test:sandbox:bun
- npm run release:zip:bun
- Extension reload + YouTube tab reload in Chrome local dev mode
- Confirm for a few minutes on a busy live stream, checking maxActive 2000, toggle, default chat hide, exclusion of official comments, and stuttering.
```