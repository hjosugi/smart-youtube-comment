// Live test for the device-side adaptive chat client against the DEPLOYED relay.
//
// Usage: node web/test/chat-client-live.mjs <relayBase> [videoId] [runSeconds]
// If videoId is omitted, finds a currently-live one via the worker oracle.

import { createLiveChatClient } from "../chat-client.ts"
import { resolveContinuation, pollLiveChat } from "../../worker/src/innertube.js"

const CLIENT = { clientName: "WEB", clientVersion: "2.20240814.00.00" }

async function search(q) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://www.youtube.com" },
    body: JSON.stringify({ context: { client: CLIENT }, query: q, params: "EgJAAQ%3D%3D" }),
  })
  const s = JSON.stringify(await r.json())
  return [...new Set([...s.matchAll(/"videoId":"([\w-]{11})"/g)].map(m => m[1]))]
}

async function findLive() {
  const ids = [...new Set([...(await search("news live")), ...(await search("24/7 live"))])]
  for (const id of ids) {
    try {
      const c = await resolveContinuation(id)
      if (!c) continue
      const p = await pollLiveChat(c)
      if (p.messages.length > 0) return id
    } catch {
      /* next */
    }
  }
  return null
}

async function main() {
  const base = process.argv[2]
  if (!base) {
    console.error("usage: node web/test/chat-client-live.mjs <relayBase> [videoId] [runSeconds]")
    process.exit(2)
  }
  const runMs = (Number(process.argv[4]) || 20) * 1000
  const videoId = process.argv[3] || (await findLive())
  if (!videoId) {
    console.error("[test] no active live video found")
    process.exit(1)
  }
  console.log(`[test] relay=${base} video=${videoId} run=${runMs / 1000}s`)

  const client = createLiveChatClient({ base })
  let total = 0
  let batches = 0
  let errors = 0
  let maxFailStreak = 0
  const seen = new Set()
  let dupes = 0

  const done = client.start(videoId, {
    onMessages(msgs) {
      batches += 1
      total += msgs.length
      for (const m of msgs) {
        if (seen.has(m.id)) dupes += 1
        else seen.add(m.id)
      }
      console.log(
        `[msgs] +${msgs.length} (total ${total}) e.g. "${msgs[0]?.text?.slice(0, 48) ?? ""}"`,
      )
    },
    onState(s) {
      console.log(`[state] healthy=${s.healthy} failures=${s.failures} nextIn=${s.nextInMs}ms`)
    },
    onError(e, n) {
      errors += 1
      maxFailStreak = Math.max(maxFailStreak, n)
      console.log(`[error] #${n} status=${e.status ?? "?"} ${e.message} (will retry, backing off)`)
    },
    onEnded(info) {
      console.log(`[ended] reason=${info.reason}`)
    },
  })

  setTimeout(() => client.stop(), runMs)
  await done

  console.log("\n=== SUMMARY ===")
  console.log(`unique messages: ${seen.size}, batches: ${batches}, duplicate ids: ${dupes}`)
  console.log(`errors: ${errors}, max consecutive fail streak: ${maxFailStreak}`)
  console.log(
    seen.size > 0
      ? "RESULT: ✅ adaptive client polled live chat end-to-end"
      : "RESULT: ⚠️ no messages",
  )
}

main().catch(e => {
  console.error("[test] ERROR:", e.message)
  process.exit(1)
})
