# Performance and Security Research - 2026-06-17

This note is intentionally written on the shared side of the repo. Claude is
actively changing `extension/`, so Codex did not edit extension-owned files while
preparing this research.

Update: the Rust/WASM scorer has since been removed. The measurements below are
kept as historical justification for the JS-only decision.

## Executive decision

The current evidence supports this rule:

- Keep WASM only if it moves to a batched or stateful scorer and proves a clear
  browser-runtime win.
- Remove WASM if the shipped path stays one-message-per-call, especially through
  JSON. The current JS scorer is already faster than the WASM contract path, and
  scoring is not the bottleneck for live chat.

The renderer and chat extraction path should receive the next performance work.
At 100-2000 active comments, the expensive work is text rasterization, canvas
blits, per-frame loops, YouTube DOM observation, and main-thread contention.

## Local measurements

Run date: 2026-06-17, workspace-local dirty tree, current shipped WASM artifact
size: `91,325` bytes.

```text
npm run bench:scorer -- 1000000
messages_per_second: 1,605,865
ns_per_message: 622.7
```

```text
npm run bench:scorer:ceiling -- 200000
contract core:              2,622,688 msgs/sec, 381.3 ns/msg
legacy packed-speed bridge: 2,574,273 msgs/sec, 388.5 ns/msg
```

```text
npm run bench:wasm -- 200000
engine: Node v26.2.0 / V8, proxy for Chrome JS+WASM boundary cost
wasm end-to-end:                 600,908 msgs/sec, 1664.1 ns/msg
wasm contract-json:              177,894 msgs/sec, 5621.3 ns/msg
wasm boundary-only:            1,420,734 msgs/sec,  703.9 ns/msg
extension fallback heuristic:    451,006 msgs/sec, 2217.3 ns/msg
```

```text
npm run bench:wasm:bun -- 200000
engine: Bun 1.3.14
wasm end-to-end:                 739,538 msgs/sec, 1352.2 ns/msg
wasm contract-json:              261,731 msgs/sec, 3820.7 ns/msg
wasm boundary-only:            5,117,529 msgs/sec,  195.4 ns/msg
extension fallback heuristic:    431,936 msgs/sec, 2315.2 ns/msg
```

Interpretation:

- Native Rust is far beyond live traffic requirements.
- The JS fallback is also far beyond live traffic requirements.
- The one-message WASM packed bridge is faster than JS under Bun and somewhat
  faster than JS under Node/V8 in this run, but this is not the active contract
  path and it does not change the visible jank problem.
- The JSON WASM contract path is slower than the JS fallback on V8 because
  stringify/encode/copy/parse dominates the tiny scoring algorithm.
- Bun is useful for faster local iteration, but the deployed extension runs in
  Chrome/V8. Chrome/V8 numbers remain the release decision source.

## Source-backed findings

V8 is still improving WASM. In June 2025, V8 shipped speculative
`call_indirect` inlining and deoptimization support in Chrome M137, with large
microbenchmark wins for some WasmGC workloads and smaller wins in realistic
apps. This does not remove the JS-to-WASM marshalling cost for tiny per-message
calls. Source:
[V8 WASM speculative optimizations](https://v8.dev/blog/wasm-speculative-optimizations).

V8 also lists a 2025 `JSON.stringify` performance improvement, which means JSON
transport is better than it used to be, but it still serializes, copies, parses,
and allocates across the boundary. Source:
[V8 blog index](https://v8.dev/blog).

OffscreenCanvas is relevant because it can detach canvas work from the DOM and
run rendering operations in a worker. MDN describes it as transferable and usable
in worker contexts, and web.dev specifically calls out avoiding main-thread
jank. Sources:
[MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas),
[web.dev OffscreenCanvas](https://web.dev/articles/offscreen-canvas).

Canvas optimization guidance matches the current renderer direction:
pre-render repeated work to offscreen canvases, use integer draw coordinates,
avoid repeated scaling, and layer static/dynamic content when useful. Source:
[MDN Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas).

Long tasks are the right field metric for "kakutsuku". web.dev defines main
thread tasks above 50 ms as long tasks and recommends splitting work into
smaller chunks so input and paint can happen sooner. Source:
[web.dev Optimize long tasks](https://web.dev/articles/optimize-long-tasks).

Near-duplicate detection should use locality-sensitive fingerprints rather than
exact strings. The Google SimHash near-duplicate work uses small fingerprints
where similar documents have small Hamming distance. Source:
[Detecting Near-Duplicates for Web Crawling](https://research.google.com/pubs/archive/33026.pdf).

For bursty stream statistics, Count-Min Sketch is a good reference if we later
track repeated authors/tokens/slurs/phrases without unbounded memory. Source:
[Count-Min Sketch](https://dsf.berkeley.edu/cs286/papers/countmin-latin2004.pdf).

Lane assignment is an interval partitioning problem. The standard optimal
implementation keeps lane finish times in a priority queue, O(n log n). Current
lane counts are small enough that a linear scan is likely fine, but the heap
model is the correct upgrade if lane count grows. Source:
[TU Delft interval partitioning slides](https://ocw.tudelft.nl/wp-content/uploads/Algoritmiek_Interval_partitioning.pdf).

Text rendering systems commonly use pre-rasterized glyph or texture atlases when
rendering large amounts of text. This validates the bitmap-cache direction, but
full glyph atlas work is complex for CJK, emoji, fallback fonts, bidi, and color
fonts. Source:
[State of Text Rendering 2024](https://behdad.org/text2024/).

Supply-chain risk is current, not theoretical. Microsoft reported a May 2026 npm
dependency-confusion campaign using malicious scoped packages, install hooks,
obfuscated stagers, and developer-environment reconnaissance. Source:
[Microsoft Security Blog, 2026 npm dependency confusion](https://www.microsoft.com/en-us/security/blog/2026/05/29/33-malicious-npm-packages-abuse-dependency-confusion-profile-developer-environments/).

Prompt injection is relevant only if this extension later adds an LLM or agentic
summarizer/moderator. OWASP lists prompt injection as the top LLM application
risk for 2025. Source:
[OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

## Security check result

```text
npm run security:bun
WARN optional dependency node_modules/fsevents has an install script; keep it optional and dev-only.
FAIL extension/content.js:176 uses innerHTML.
```

This was not changed here because `extension/` is Claude-owned. The fix is small:
construct the SVG with `document.createElementNS` or replace it with a CSS mask
or text-free icon asset. The existing policy is correct to fail on `innerHTML`;
even a constant string can normalize a bad pattern in extension code.

## Language choice

JavaScript is unavoidable in the content script because the extension must talk
to YouTube's DOM, Chrome extension APIs, canvas, storage, and the player UI.

TypeScript may be better than plain JS for maintainability and security because
settings, scorer results, and renderer payloads are contract-shaped objects. It
does not make Chrome runtime execution faster by itself.

Rust/WASM is only justified for:

- batched scoring;
- stateful streaming features such as SimHash windows, Count-Min Sketch, or
  heavier moderation heuristics;
- algorithms where deterministic memory layout matters;
- future ML/classifier code that is actually more expensive than the boundary.

Rust/WASM is not justified for the current one-message JSON scoring path.

## WASM keep/remove criteria

Keep WASM only if all are true:

1. A batch API exists, for example `score_batch(ptr, len) -> ptr,len`, with a
   compact binary layout or newline-delimited packed records. Avoid JSON in the
   hot path.
2. Browser/V8 bench shows at least 2x speedup over the JS scorer at realistic
   batch sizes, for example 32, 64, 128, and 256 messages.
3. End-to-end Chrome profiling shows scoring appears in long tasks or total
   blocking time before optimization.
4. The compatibility bridge remains documented in `docs/CONTRACT.md` until both
   `extension/` and `scorer/` move together.

Remove WASM if any are true:

1. The scorer remains one-message-per-call.
2. The hot path remains JSON transport.
3. The renderer is still dropping frames while scorer time is below 1-2 ms per
   second of chat traffic.
4. Keeping WASM requires `wasm-unsafe-eval` or extra web-accessible resources
   without a measurable runtime win.

## Highest-impact performance plan

### Phase 0 - prove where jank is

- Add a release-only-disabled diagnostics switch for:
  `active`, `pending`, `cache`, `dropped`, `spawned/frame`, `drawn/frame`,
  `rasterized/frame`, frame delta p50/p95/p99, and Long Task count.
- Use `PerformanceObserver({ type: "longtask" })` in dev mode.
- Record 30-60 seconds on a busy stream with maxActive values 300, 600, 1000,
  1500, and 2000.

### Phase 1 - renderer without WASM dependency

- Keep canvas bitmap caching, but move rasterization work into a strict budget.
- Use integer `drawImage` coordinates.
- Avoid glow/shadow when `active` or frame time is high.
- Keep DPR capped; high DPR multiplies every bitmap and clear/draw cost.
- Replace FIFO `pending.shift()` with an index/ring buffer or priority bucket;
  `shift()` moves array contents.
- Replace `recent.shift()` with a ring buffer.
- Add adaptive quality degradation based on frame p95, not only EMA.
- At 2000 active, prefer admission control over trying to draw every low-value
  comment every frame forever.

### Phase 2 - if WASM survives

- Add a batch benchmark before changing the extension contract.
- Proposed scorer-owned prototype:
  `score_batch_legacy(ptr, len)` consumes packed UTF-8 records and returns packed
  speed/quality records.
- Compare:
  JS scorer single message, JS scorer batch loop, WASM packed single, WASM
  packed batch, WASM JSON batch.
- Do not ship a batch contract until `docs/CONTRACT.md` and Claude's extension
  side move together.

### Phase 3 - serious 2000-comment rendering

- Prototype OffscreenCanvas worker rendering. This targets main-thread jank, not
  total CPU work.
- If Canvas2D still cannot hold 2000 active comments, prototype WebGL texture
  sprites: one texture per rasterized comment bitmap first, glyph atlas later.
- Treat full glyph atlas/SDF text as a later optimization because Japanese,
  emoji, font fallback, and outlines make it much more complex than latin-only
  text.

## Scorer algorithm notes

Current Rust scorer headroom is enormous, but if scorer work continues:

- Replace the O(n^2) `unique_hash_count` helper with sort+dedup on the existing
  token hash vector if long comments become common.
- Avoid allocating normalized lowercase strings in the hot path if benchmarks
  show it matters. A single-pass case-folding tokenizer is possible, but must be
  tested with Japanese and emoji.
- Add SimHash as a stateful novelty signal only if it improves admission quality
  under real stream captures.
- Add Count-Min Sketch only for bounded-memory frequency tracking, not for simple
  exact checks.

## Supply-chain controls

Keep the existing controls and make them release-blocking:

- `package.json` remains private.
- Exact dependency pins only; no `^`, `~`, ranges, or wildcard specs.
- `package-lock.json` integrity fields required.
- No non-optional lifecycle install scripts.
- npm registry only.
- No remote scripts/styles in the extension.
- Minimal permissions: storage plus YouTube host scope only.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, or
  remote fetch except the explicitly whitelisted local WASM fetch while WASM
  exists.

If Bun becomes the primary local runner, keep npm lockfile checks anyway, because
Chrome extension release packaging should remain reproducible and auditable.

## Injection controls

For DOM/HTML injection:

- Use `textContent`, `setAttribute`, and DOM constructors.
- Build SVG with `createElementNS` or ship it as a static icon asset.
- Normalize and bound settings values at storage boundaries.
- Keep content-security-policy strict; do not add remote sources.

For future LLM/prompt injection:

- Treat YouTube chat, video metadata, and page text as untrusted data.
- Never let chat text become tool instructions.
- Separate system/developer instructions from retrieved/chat content.
- Use allowlisted tool calls and explicit user confirmation for privileged
  actions.
- Log provenance: which text came from YouTube, which came from the extension,
  which came from user settings.

## Immediate recommendation

Do not spend more time micro-optimizing the current single-message scorer unless
a profiler proves it is hot. The next useful engineering step is one of:

1. Let Claude finish removing WASM from `extension/`, then delete WASM-specific
   release requirements and CSP only if the scorer boundary no longer needs it.
2. Or, if WASM must survive, prototype batch scoring entirely under `scorer/` and
   `bench/` first, with no extension contract change until it wins in V8.
3. In parallel, fix the `innerHTML` security failure in `extension/content.js`
   and add Long Task/frame diagnostics so future changes are judged by p95/p99
   frame behavior, not by scorer microbenchmarks.
