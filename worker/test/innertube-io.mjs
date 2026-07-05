// Deterministic IO tests for the InnerTube relay layer. Network calls are
// replaced with fixture-backed fetch handlers so CI never depends on YouTube.

import test, { afterEach } from "node:test"
import assert from "node:assert/strict"

import { _test, pollLiveChat, resolveLiveChat } from "../src/innertube.ts"

const originalFetch = globalThis.fetch
const originalRandom = Math.random

afterEach(() => {
  globalThis.fetch = originalFetch
  Math.random = originalRandom
})

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })

const textResponse = (body, init = {}) => new Response(body, init)

const readFetchCall = async (input, init) => {
  const url = typeof input === "string" ? input : input.url
  return {
    url: new URL(url),
    body: init?.body ? JSON.parse(init.body) : null,
    init,
  }
}

const mockFetch = handler => {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const call = await readFetchCall(input, init)
    calls.push(call)
    return handler(call, calls.length)
  }
  return calls
}

test("postOnce tags AbortError as 504", async () => {
  mockFetch(() => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" })
  })

  await assert.rejects(_test.postOnce("next", {}), error => {
    assert.equal(error.status, 504)
    assert.match(error.message, /timeout/)
    return true
  })
})

test("postOnce tags non-JSON success bodies as 502", async () => {
  mockFetch(() => textResponse("<html>not json</html>", { status: 200 }))

  await assert.rejects(_test.postOnce("next", {}), error => {
    assert.equal(error.status, 502)
    assert.match(error.message, /non-JSON/)
    return true
  })
})

test("postWithRetry retries transient upstream failures and caps attempts", async () => {
  Math.random = () => 0
  const calls = mockFetch((_, n) =>
    n === 1 ? textResponse("temporary", { status: 500 }) : jsonResponse({ ok: true }),
  )

  assert.deepEqual(await _test.postWithRetry("next", { videoId: "abc123def45" }), { ok: true })
  assert.equal(calls.length, 2)
})

test("postWithRetry does not retry deterministic 4xx failures", async () => {
  const calls = mockFetch(() => textResponse("forbidden", { status: 403 }))

  await assert.rejects(_test.postWithRetry("next", {}), error => {
    assert.equal(error.status, 403)
    return true
  })
  assert.equal(calls.length, 1)
})

test("postWithRetry does not retry upstream rate-limit responses", async () => {
  const calls = mockFetch(() => textResponse("rate limited", { status: 429 }))

  await assert.rejects(_test.postWithRetry("next", {}), error => {
    assert.equal(error.status, 429)
    return true
  })
  assert.equal(calls.length, 1)
})

test("postWithRetry stops after the configured transient retry budget", async () => {
  Math.random = () => 0
  const calls = mockFetch(() => textResponse("bad gateway", { status: 502 }))

  await assert.rejects(_test.postWithRetry("next", {}), error => {
    assert.equal(error.status, 502)
    return true
  })
  assert.equal(calls.length, 2)
})

test("resolveLiveChat extracts continuation and localized replay state", async () => {
  const calls = mockFetch(call => {
    assert.equal(call.url.pathname, "/youtubei/v1/next")
    return jsonResponse({
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            liveChatRenderer: {
              continuations: [
                { timedContinuationData: { continuation: "INITIAL", timeoutMs: 2500 } },
              ],
              header: {
                liveChatHeaderRenderer: {
                  viewSelector: {
                    sortFilterSubMenuRenderer: {
                      subMenuItems: [{ title: "ライブチャットのリプレイ" }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
  })

  assert.deepEqual(await resolveLiveChat("abc123def45"), {
    continuation: "INITIAL",
    isReplay: true,
  })
  assert.equal(calls[0].body.videoId, "abc123def45")
  assert.equal(calls[0].body.context.client.clientName, "WEB")
  assert.equal(calls[0].body.context.client.hl, "en")
  assert.equal(calls[0].body.context.client.gl, "US")
})

test("resolveLiveChat returns null when a watch page has no chat renderer", async () => {
  mockFetch(() => jsonResponse({ contents: { twoColumnWatchNextResults: {} } }))

  assert.equal(await resolveLiveChat("abc123def45"), null)
})

test("pollLiveChat builds live envelopes and marks terminal batches ended", async () => {
  let responseIndex = 0
  const calls = mockFetch(call => {
    assert.equal(call.url.pathname, "/youtubei/v1/live_chat/get_live_chat")
    responseIndex += 1
    if (responseIndex === 1) {
      return jsonResponse({
        continuationContents: {
          liveChatContinuation: {
            actions: [
              {
                addChatItemAction: {
                  item: {
                    liveChatTextMessageRenderer: {
                      id: "msg-1",
                      timestampUsec: "1700000000000000",
                      authorName: { simpleText: "@live" },
                      message: { runs: [{ text: "hello live" }] },
                    },
                  },
                },
              },
            ],
            continuations: [{ timedContinuationData: { continuation: "NEXT", timeoutMs: 1500 } }],
          },
        },
      })
    }
    return jsonResponse({
      continuationContents: {
        liveChatContinuation: {
          actions: [],
          continuations: [],
        },
      },
    })
  })

  const first = await pollLiveChat("START")
  assert.equal(calls[0].body.continuation, "START")
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].text, "hello live")
  assert.equal(first.continuation, "NEXT")
  assert.equal(first.timeoutMs, 1500)
  assert.equal(first.ended, false)
  assert.equal(first.isReplay, false)

  const second = await pollLiveChat("NEXT")
  assert.equal(second.messages.length, 0)
  assert.equal(second.continuation, null)
  assert.equal(second.ended, true)
})

test("pollLiveChat replay mode clamps negative offsets and preserves replay offsets", async () => {
  const calls = mockFetch(call => {
    assert.equal(call.url.pathname, "/youtubei/v1/live_chat/get_live_chat_replay")
    return jsonResponse({
      continuationContents: {
        liveChatContinuation: {
          actions: [
            {
              replayChatItemAction: {
                videoOffsetTimeMsec: "123456",
                actions: [
                  {
                    addChatItemAction: {
                      item: {
                        liveChatTextMessageRenderer: {
                          id: "replay-1",
                          authorName: { simpleText: "@vod" },
                          message: { runs: [{ text: "hello replay" }] },
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    })
  })

  const result = await pollLiveChat("REPLAY", { replay: true, offsetMs: -42 })
  assert.equal(calls[0].body.continuation, "REPLAY")
  assert.equal(calls[0].body.currentPlayerState.playerOffsetMs, "0")
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text, "hello replay")
  assert.equal(result.messages[0].offsetMs, 123456)
  assert.equal(result.continuation, "REPLAY")
  assert.equal(result.timeoutMs, 3000)
  assert.equal(result.ended, false)
  assert.equal(result.isReplay, true)
})
