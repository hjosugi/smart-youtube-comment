// Live verification harness for the InnerTube relay logic.
//
// Usage:  node worker/test/probe.mjs <videoIdOrUrl> [rounds]
//
// Proves the highest-risk assumption: that a *server* (no browser, no cookies)
// can resolve a live-chat continuation and poll real messages via InnerTube.
// This is exactly what the Cloudflare Worker will do.

import { resolveContinuation, pollLiveChat } from "../src/innertube.js";

function parseVideoId(arg) {
  if (!arg) return null;
  const m =
    arg.match(/[?&]v=([\w-]{11})/) ||
    arg.match(/youtu\.be\/([\w-]{11})/) ||
    arg.match(/live\/([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(arg)) return arg;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const videoId = parseVideoId(process.argv[2]);
  const rounds = Number(process.argv[3] ?? 3);
  if (!videoId) {
    console.error("usage: node worker/test/probe.mjs <videoIdOrUrl> [rounds]");
    process.exit(2);
  }

  console.log(`[probe] videoId=${videoId}`);
  const continuation = await resolveContinuation(videoId);
  if (!continuation) {
    console.error("[probe] FAIL: no live-chat continuation (not live, or chat disabled)");
    process.exit(1);
  }
  console.log(`[probe] OK: resolved continuation (${continuation.length} chars)`);

  let cont = continuation;
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const { messages, continuation: next, timeoutMs, ended } = await pollLiveChat(cont);
    total += messages.length;
    console.log(
      `[probe] round ${i + 1}/${rounds}: ${messages.length} msg, next poll in ${timeoutMs}ms${ended ? " [ENDED]" : ""}`
    );
    for (const m of messages.slice(0, 5)) {
      console.log(
        `        [${m.kind}/${m.authorType}] ${m.author}: ${m.text}${m.amount ? ` (${m.amount})` : ""}`
      );
    }
    if (ended || !next) {
      console.log("[probe] stream ended — stopping");
      break;
    }
    cont = next;
    if (i < rounds - 1) await sleep(Math.min(timeoutMs || 1000, 5000));
  }

  console.log(`[probe] DONE: ${total} messages over ${rounds} rounds`);
  if (total === 0) {
    console.log("[probe] note: continuation worked but chat was quiet this window");
  }
}

main().catch((e) => {
  console.error(`[probe] ERROR: ${e.message}`);
  process.exit(1);
});
