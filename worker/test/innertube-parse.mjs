// Unit tests for the PURE InnerTube transforms (no network). Feeds fixture
// actions shaped like real get_live_chat responses and asserts the normalized
// ChatMessage + continuation extraction.

import test from "node:test"
import assert from "node:assert/strict"

import { _pure } from "../src/innertube.ts"

const { parseAction, extractContinuation, authorTypeFromBadges } = _pure

const textRenderer = (over = {}) => ({
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id: "t1",
        timestampUsec: "1700000000000000",
        authorName: { simpleText: "@alice" },
        message: { runs: [{ text: "hello " }, { emoji: { shortcuts: [":wave:"] } }] },
        ...over,
      },
    },
  },
})

const headerWith = titles => ({
  header: {
    liveChatHeaderRenderer: {
      viewSelector: {
        sortFilterSubMenuRenderer: { subMenuItems: titles.map(title => ({ title })) },
      },
    },
  },
})

test("text messages reconstruct emoji runs and timestamps", () => {
  const m = parseAction(textRenderer())
  assert.equal(m.kind, "text")
  assert.equal(m.author, "@alice")
  assert.equal(m.text, "hello :wave:")
  assert.equal(m.ts, 1700000000000)
  assert.equal(m.authorColor, null)
  assert.ok("authorColor" in m)
})

test("author badge precedence is owner > moderator > member > normal", () => {
  const badge = (iconType, custom) => ({
    liveChatAuthorBadgeRenderer: iconType ? { icon: { iconType } } : { customThumbnail: custom },
  })

  assert.equal(authorTypeFromBadges([badge("OWNER"), badge("MODERATOR")]), "owner")
  assert.equal(authorTypeFromBadges([badge("MODERATOR"), badge(null, {})]), "moderator")
  assert.equal(authorTypeFromBadges([badge(null, {})]), "member")
  assert.equal(authorTypeFromBadges([]), "normal")
})

test("paid messages and stickers preserve amount fallback text", () => {
  const paid = parseAction({
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id: "p1",
          timestampUsec: "1700000000000000",
          authorName: { simpleText: "@bob" },
          purchaseAmountText: { simpleText: "¥1,000" },
          bodyBackgroundColor: 0xff1565c0,
        },
      },
    },
  })
  assert.equal(paid.kind, "paid")
  assert.equal(paid.amount, "¥1,000")
  assert.equal(paid.paidColor, "#1565c0")
  assert.equal(paid.text, "¥1,000")

  const sticker = parseAction({
    addChatItemAction: {
      item: {
        liveChatPaidStickerRenderer: {
          id: "s1",
          authorName: { simpleText: "@c" },
          purchaseAmountText: { simpleText: "$5.00" },
        },
      },
    },
  })
  assert.equal(sticker.kind, "paid")
  assert.equal(sticker.amount, "$5.00")
  assert.equal(sticker.text, "$5.00")
})

test("membership and sponsorship renderers normalize text and author", () => {
  const membership = parseAction({
    addChatItemAction: {
      item: {
        liveChatMembershipItemRenderer: {
          id: "m1",
          authorName: { simpleText: "@d" },
          headerSubtext: { runs: [{ text: "Member for 3 months" }] },
        },
      },
    },
  })
  assert.equal(membership.kind, "membership")
  assert.equal(membership.text, "Member for 3 months")

  const gift = parseAction({
    addChatItemAction: {
      item: {
        liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
          id: "g1",
          header: {
            liveChatSponsorshipsHeaderRenderer: {
              authorName: { simpleText: "@gifter" },
              primaryText: { runs: [{ text: "gifted 5 memberships" }] },
            },
          },
        },
      },
    },
  })
  assert.equal(gift.kind, "membership")
  assert.equal(gift.author, "@gifter")
  assert.equal(gift.text, "gifted 5 memberships")
})

test("replacement items unwrap and unknown renderers drop to null", () => {
  const replacement = parseAction({
    replaceChatItemAction: {
      replacementItem: {
        liveChatTextMessageRenderer: {
          id: "r1",
          authorName: { simpleText: "@e" },
          message: { runs: [{ text: "now real" }] },
        },
      },
    },
  })
  assert.equal(replacement.text, "now real")

  assert.equal(
    parseAction({
      addChatItemAction: { item: { liveChatPlaceholderItemRenderer: { id: "x" } } },
    }),
    null,
  )
  assert.equal(parseAction({ markChatItemAsDeletedAction: { targetItemId: "z" } }), null)
})

test("continuation extraction preserves precedence and clamps timeout boundaries", () => {
  assert.equal(
    extractContinuation([{ invalidationContinuationData: { continuation: "A", timeoutMs: 5000 } }])
      .token,
    "A",
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "B", timeoutMs: 3000 } }])
      .timeoutMs,
    3000,
  )
  assert.equal(extractContinuation([]).token, null)
  assert.equal(
    extractContinuation([{ reloadContinuationData: { continuation: "C", timeoutMs: "x" } }])
      .timeoutMs,
    1000,
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "D", timeoutMs: 999999 } }])
      .timeoutMs,
    30000,
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "E", timeoutMs: 10 } }])
      .timeoutMs,
    250,
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "F", timeoutMs: 250 } }])
      .timeoutMs,
    250,
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "G", timeoutMs: 300 } }])
      .timeoutMs,
    300,
  )
  assert.equal(
    extractContinuation([{ timedContinuationData: { continuation: "H", timeoutMs: 999 } }])
      .timeoutMs,
    999,
  )
  assert.deepEqual(
    extractContinuation([
      { unknownContinuationData: { continuation: "ignored", timeoutMs: 1 } },
      { reloadContinuationData: { continuation: "I", timeoutMs: 2000 } },
    ]),
    { token: "I", timeoutMs: 2000 },
  )
})

test("replay chat detection covers flags, English titles, and localized titles", () => {
  assert.equal(
    _pure.isReplayChat({
      continuations: [{ liveChatReplayContinuationData: { continuation: "REPLAY" } }],
    }),
    true,
  )
  assert.equal(_pure.isReplayChat(headerWith(["Top chat replay", "Live chat replay"])), true)
  assert.equal(_pure.isReplayChat(headerWith(["Top chat", "Live chat"])), false)
  assert.equal(
    _pure.isReplayChat(headerWith(["上位チャットのリプレイ", "ライブチャットのリプレイ"])),
    true,
  )
  assert.equal(_pure.isReplayChat(headerWith(["Repetición del chat destacado"])), true)
  assert.equal(_pure.isReplayChat({ isReplay: true }), true)
})

test("replay actions unwrap inner actions and preserve video offsets", () => {
  const items = _pure.replayItems({
    replayChatItemAction: {
      videoOffsetTimeMsec: "123456",
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: "rp1",
                authorName: { simpleText: "@v" },
                message: { runs: [{ text: "vod comment" }] },
              },
            },
          },
        },
      ],
    },
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].off, 123456)
  assert.equal(parseAction(items[0].action)?.text, "vod comment")
  assert.equal(_pure.replayItems({ addChatItemAction: {} }).length, 0)
})

test("malformed input is null-safe and normalizes safe defaults", () => {
  assert.equal(parseAction(null), null)
  assert.equal(parseAction({}), null)
  assert.equal(_pure.parseItem(undefined), null)
  assert.equal(_pure.parseItem({ someUnknownRenderer: { id: "x" } }), null)
  assert.equal(_pure.runsToText(null), "")
  assert.equal(_pure.runsToText({ simpleText: "hi" }), "hi")
  assert.equal(
    _pure.runsToText({
      runs: [{ text: "a" }, { emoji: { shortcuts: [":x:"] } }, { text: "b" }],
    }),
    "a:x:b",
  )
  assert.equal(authorTypeFromBadges(undefined), "normal")
  assert.equal(authorTypeFromBadges([]), "normal")

  const bare = parseAction({
    addChatItemAction: { item: { liveChatTextMessageRenderer: { id: "b1" } } },
  })
  assert.equal(bare.text, "")
  assert.equal(bare.author, "")
  assert.equal(bare.authorType, "normal")
  assert.equal(bare.ts, 0)
  assert.equal(bare.authorColor, null)
})

test("emoji parts preserve standard glyphs and custom emoji image parts", () => {
  const rp = _pure.runsToParts
  assert.deepEqual(rp({ runs: [{ text: "hi" }] }), [{ t: "hi" }])
  assert.deepEqual(rp({ runs: [{ emoji: { emojiId: "🥕", shortcuts: [":carrot:"] } }] }), [
    { t: "🥕" },
  ])

  const custom = rp({
    runs: [
      {
        emoji: {
          isCustomEmoji: true,
          shortcuts: [":x:"],
          image: { thumbnails: [{ url: "u1" }, { url: "u2" }] },
        },
      },
    ],
  })
  assert.equal(custom.length, 1)
  assert.equal(custom[0].u, "u2")
  assert.equal(custom[0].a, ":x:")

  assert.deepEqual(rp({ runs: [{ text: "a " }, { emoji: { emojiId: "😀" } }, { text: " b" }] }), [
    { t: "a " },
    { t: "😀" },
    { t: " b" },
  ])
  assert.deepEqual(rp({ simpleText: "hello" }), [{ t: "hello" }])
  assert.deepEqual(rp(null), [])

  const m = parseAction({
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: "e1",
          authorName: { simpleText: "@a" },
          message: {
            runs: [
              { text: "hi " },
              {
                emoji: {
                  isCustomEmoji: true,
                  shortcuts: [":m:"],
                  image: { thumbnails: [{ url: "IMG" }] },
                },
              },
            ],
          },
        },
      },
    },
  })
  assert.ok(m.parts.some(p => p.u === "IMG"))
  assert.equal(m.text, "hi :m:")
})
